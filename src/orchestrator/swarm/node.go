// Package swarm lets Ramlaal instances find and call each other.
//
// Discovery and events ride on NATS: every instance announces its identity, capabilities and A2A
// address on a heartbeat, and each instance keeps an in-memory table of live peers (no shared
// registry to run or lose). Instance-to-instance calls use the A2A protocol over gRPC.
package swarm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	"github.com/a2aproject/a2a-go/v2/a2agrpc/v1"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"github.com/a2aproject/a2a-go/v2/a2asrv/taskstore"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	"ramlaal/orchestrator/auth"
	"ramlaal/orchestrator/ramlaal"
)

const (
	announceSubject = "ramlaal.registry.announce"
	eventPrefix     = "ramlaal.events."
)

// Config configures a Node.
type Config struct {
	Identity      ramlaal.Identity
	NATSURL       string // empty runs the instance alone: A2A for users, no peers
	ListenAddr    string // gRPC listen address, e.g. ":9000"
	AdvertiseAddr string // host:port other instances dial
	// Auth verifies incoming bearer tokens (Keycloak); nil disables authentication.
	Auth auth.Verifier
	// PeerCreds authenticates this instance's calls to peers; nil sends no credentials.
	PeerCreds credentials.PerRPCCredentials
	// Handle runs one request for the user in ctx (auth.UserFrom) and returns the reply.
	Handle        func(ctx context.Context, request string) (string, error)
	AnnounceEvery time.Duration // default 5s; peers expire after three missed beats
	CallTimeout   time.Duration // default 10m
}

type announcement struct {
	ramlaal.Peer
	Addr    string `json:"addr"`
	Leaving bool   `json:"leaving,omitempty"`
}

type peerEntry struct {
	ann  announcement
	seen time.Time
}

// Node is one instance's presence in the swarm and its A2A endpoint for users.
type Node struct {
	cfg      Config
	nc       *nats.Conn // nil when running without a swarm
	grpc     *grpc.Server
	listener net.Listener
	card     *a2a.AgentCard
	handler  a2asrv.RequestHandler

	mu      sync.Mutex
	peers   map[string]peerEntry
	clients map[string]*a2aclient.Client

	stop chan struct{}
	done sync.WaitGroup
}

// Start serves this instance over A2A/gRPC and, when NATSURL is set, joins the swarm.
func Start(cfg Config) (*Node, error) {
	if cfg.AnnounceEvery <= 0 {
		cfg.AnnounceEvery = 5 * time.Second
	}
	if cfg.CallTimeout <= 0 {
		cfg.CallTimeout = 10 * time.Minute
	}
	if cfg.Handle == nil || cfg.Identity.Instance == "" {
		return nil, errors.New("swarm: Handle and Identity.Instance are required")
	}
	n := &Node{cfg: cfg, peers: map[string]peerEntry{}, clients: map[string]*a2aclient.Client{}, stop: make(chan struct{})}

	if cfg.NATSURL != "" {
		nc, err := nats.Connect(cfg.NATSURL, nats.Name(cfg.Identity.Instance), nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1))
		if err != nil {
			return nil, fmt.Errorf("swarm: nats: %w", err)
		}
		n.nc = nc
	}

	lis, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		if n.nc != nil {
			n.nc.Close()
		}
		return nil, fmt.Errorf("swarm: listen: %w", err)
	}
	n.listener = lis
	if n.cfg.AdvertiseAddr == "" {
		n.cfg.AdvertiseAddr = lis.Addr().String()
	}
	n.card = buildCard(n.cfg.Identity, n.cfg.AdvertiseAddr)

	// Task state (submitted, working, completed, failed) lives in memory, scoped to the calling user.
	store := taskstore.NewInMemory(&taskstore.InMemoryStoreConfig{Authenticator: a2asrv.NewTaskStoreAuthenticator()})
	n.handler = a2asrv.NewHandler(a2asrv.AgentExecutorFunc(n.execute),
		a2asrv.WithExtendedAgentCard(n.card), a2asrv.WithTaskStore(store), a2asrv.WithCallInterceptors(userInterceptor{}))
	n.grpc = grpc.NewServer(grpc.StatsHandler(otelgrpc.NewServerHandler()), grpc.UnaryInterceptor(auth.UnaryInterceptor(cfg.Auth)), grpc.StreamInterceptor(auth.StreamInterceptor(cfg.Auth)))
	a2agrpc.NewHandler(n.handler).RegisterWith(n.grpc)
	n.done.Add(1)
	go func() {
		defer n.done.Done()
		if err := n.grpc.Serve(lis); err != nil {
			log.Printf("swarm: grpc server: %v", err)
		}
	}()

	if n.nc != nil {
		if _, err := n.nc.Subscribe(announceSubject, n.onAnnounce); err != nil {
			n.Close()
			return nil, fmt.Errorf("swarm: subscribe: %w", err)
		}
		n.announce(false)
		n.done.Add(1)
		go n.heartbeat()
	}
	return n, nil
}

// HTTPHandler serves A2A over JSON-RPC for browsers and other HTTP clients. Mount it behind
// auth.Middleware so the calling user is known.
func (n *Node) HTTPHandler() http.Handler { return a2asrv.NewJSONRPCHandler(n.handler) }

// userInterceptor copies the authenticated user from the transport into the A2A call context,
// which scopes tasks to their owner.
type userInterceptor struct {
	a2asrv.PassthroughCallInterceptor
}

func (userInterceptor) Before(ctx context.Context, cc *a2asrv.CallContext, _ *a2asrv.Request) (context.Context, any, error) {
	user := auth.UserFrom(ctx)
	if user == "" {
		return ctx, nil, a2a.ErrUnauthenticated
	}
	cc.User = a2asrv.NewAuthenticatedUser(user, nil)
	return ctx, nil, nil
}

// Close announces departure and releases the connection and server.
func (n *Node) Close() {
	select {
	case <-n.stop:
		return
	default:
		close(n.stop)
	}
	if n.nc != nil {
		n.announce(true)
		_ = n.nc.Flush()
	}
	n.grpc.GracefulStop()
	if n.nc != nil {
		n.nc.Close()
	}
	n.done.Wait()
	n.mu.Lock()
	for _, c := range n.clients {
		_ = c.Destroy()
	}
	n.mu.Unlock()
}

// Card is this instance's A2A AgentCard.
func (n *Node) Card() *a2a.AgentCard { return n.card }

// CardHandler serves the public AgentCard so other A2A clients can discover this instance.
func (n *Node) CardHandler() http.Handler { return a2asrv.NewStaticAgentCardHandler(n.card) }

// Addr is the address the A2A server is listening on.
func (n *Node) Addr() string { return n.listener.Addr().String() }

func buildCard(id ramlaal.Identity, addr string) *a2a.AgentCard {
	card := &a2a.AgentCard{
		Name:                id.Instance,
		Description:         id.Purpose,
		Version:             "1.0.0",
		SupportedInterfaces: []*a2a.AgentInterface{a2a.NewAgentInterface(addr, a2a.TransportProtocolGRPC)},
		DefaultInputModes:   []string{"text/plain"},
		DefaultOutputModes:  []string{"text/plain"},
	}
	for _, c := range id.Capabilities {
		card.Skills = append(card.Skills, a2a.AgentSkill{ID: c, Name: c, Description: id.Purpose, Tags: []string{c}})
	}
	return card
}

func (n *Node) announce(leaving bool) {
	raw, _ := json.Marshal(announcement{
		Peer: ramlaal.Peer{Instance: n.cfg.Identity.Instance, Purpose: n.cfg.Identity.Purpose, Capabilities: n.cfg.Identity.Capabilities},
		Addr: n.cfg.AdvertiseAddr, Leaving: leaving,
	})
	if err := n.nc.Publish(announceSubject, raw); err != nil {
		log.Printf("swarm: announce: %v", err)
	}
}

func (n *Node) heartbeat() {
	defer n.done.Done()
	t := time.NewTicker(n.cfg.AnnounceEvery)
	defer t.Stop()
	for {
		select {
		case <-n.stop:
			return
		case <-t.C:
			n.announce(false)
		}
	}
}

func (n *Node) onAnnounce(m *nats.Msg) {
	var a announcement
	if json.Unmarshal(m.Data, &a) != nil || a.Instance == "" || a.Instance == n.cfg.Identity.Instance {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if a.Leaving {
		delete(n.peers, a.Instance)
		return
	}
	n.peers[a.Instance] = peerEntry{ann: a, seen: time.Now()}
}

func (n *Node) live() []announcement {
	n.mu.Lock()
	defer n.mu.Unlock()
	cutoff := time.Now().Add(-3 * n.cfg.AnnounceEvery)
	var out []announcement
	for name, e := range n.peers {
		if e.seen.Before(cutoff) {
			delete(n.peers, name)
			continue
		}
		out = append(out, e.ann)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Instance < out[j].Instance })
	return out
}

// Peers lists the live peers, excluding this instance.
func (n *Node) Peers() []ramlaal.Peer {
	var out []ramlaal.Peer
	for _, a := range n.live() {
		out = append(out, a.Peer)
	}
	return out
}

// Delegate sends the request to a peer with the capability, trying the next one if a peer fails.
func (n *Node) Delegate(ctx context.Context, capability, request string) (string, error) {
	capability = strings.ToLower(capability)
	var errs []string
	for _, a := range n.live() {
		if !hasCapability(a.Capabilities, capability) {
			continue
		}
		out, err := n.call(ctx, a, request)
		if err == nil {
			return out, nil
		}
		errs = append(errs, a.Instance+": "+err.Error())
	}
	if len(errs) == 0 {
		return "", fmt.Errorf("no live peer has capability %q", capability)
	}
	return "", errors.New(strings.Join(errs, "; "))
}

func hasCapability(caps []string, want string) bool {
	for _, c := range caps {
		if strings.EqualFold(c, want) {
			return true
		}
	}
	return false
}

func (n *Node) client(ctx context.Context, a announcement) (*a2aclient.Client, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if c := n.clients[a.Addr]; c != nil {
		return c, nil
	}
	opts := []grpc.DialOption{grpc.WithTransportCredentials(insecureCreds()), grpc.WithStatsHandler(otelgrpc.NewClientHandler())}
	if n.cfg.PeerCreds != nil {
		opts = append(opts, grpc.WithPerRPCCredentials(n.cfg.PeerCreds))
	}
	card := buildCard(ramlaal.Identity{Instance: a.Instance, Purpose: a.Purpose, Capabilities: a.Capabilities}, a.Addr)
	c, err := a2aclient.NewFromCard(ctx, card, a2agrpc.WithGRPCTransport(opts...))
	if err != nil {
		return nil, err
	}
	n.clients[a.Addr] = c
	return c, nil
}

func (n *Node) call(ctx context.Context, a announcement, request string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, n.cfg.CallTimeout)
	defer cancel()
	c, err := n.client(ctx, a)
	if err != nil {
		return "", err
	}
	ctx, span := otel.Tracer("ramlaal/swarm").Start(ctx, "swarm.delegate "+a.Instance, trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.String("ramlaal.peer", a.Instance), attribute.String("ramlaal.instance", n.cfg.Identity.Instance)))
	defer span.End()
	msg := a2a.NewMessage(a2a.MessageRoleUser, a2a.NewTextPart(request))
	msg.Metadata = map[string]any{"from": n.cfg.Identity.Instance}
	res, err := c.SendMessage(ctx, &a2a.SendMessageRequest{Message: msg})
	if err != nil {
		n.mu.Lock()
		if n.clients[a.Addr] == c { // reconnect next time, the peer may have restarted
			delete(n.clients, a.Addr)
			_ = c.Destroy()
		}
		n.mu.Unlock()
		span.RecordError(err)
		return "", err
	}
	return resultText(res)
}

// execute serves an incoming A2A request by running it through this instance's own loop,
// reporting progress as A2A task state.
func (n *Node) execute(ctx context.Context, ec *a2asrv.ExecutorContext) iter.Seq2[a2a.Event, error] {
	return func(yield func(a2a.Event, error) bool) {
		if ec.StoredTask == nil && !yield(a2a.NewSubmittedTask(ec, ec.Message), nil) {
			return
		}
		if !yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateWorking, nil), nil) {
			return
		}
		if ec.User != nil && ec.User.Name != "" {
			ctx = auth.WithUser(ctx, ec.User.Name)
		}
		reply, err := n.cfg.Handle(ctx, messageText(ec.Message))
		if err != nil {
			msg := a2a.NewMessageForTask(a2a.MessageRoleAgent, ec, a2a.NewTextPart(err.Error()))
			yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateFailed, msg), nil)
			return
		}
		if !yield(a2a.NewArtifactEvent(ec, a2a.NewTextPart(reply)), nil) {
			return
		}
		yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateCompleted, nil), nil)
	}
}

// Publish sends an event to every instance, e.g. Publish("alert", ...) -> ramlaal.events.<instance>.alert.
func (n *Node) Publish(ctx context.Context, kind string, payload any) error {
	if n.nc == nil {
		return errors.New("swarm: not connected to NATS")
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	// the W3C trace context rides in NATS headers so subscribers on other instances join this trace
	msg := &nats.Msg{Subject: eventPrefix + n.cfg.Identity.Instance + "." + kind, Data: raw, Header: nats.Header{}}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(msg.Header))
	return n.nc.PublishMsg(msg)
}

// Subscribe receives events of a kind from any instance (kind "*" for all).
func (n *Node) Subscribe(kind string, fn func(ctx context.Context, from, kind string, payload []byte)) error {
	if n.nc == nil {
		return errors.New("swarm: not connected to NATS")
	}
	_, err := n.nc.Subscribe(eventPrefix+"*."+kind, func(m *nats.Msg) {
		parts := strings.Split(strings.TrimPrefix(m.Subject, eventPrefix), ".")
		if len(parts) == 2 {
			ctx := otel.GetTextMapPropagator().Extract(context.Background(), propagation.HeaderCarrier(m.Header))
			ctx, span := otel.Tracer("ramlaal/swarm").Start(ctx, "swarm.event "+parts[1], trace.WithSpanKind(trace.SpanKindConsumer),
				trace.WithAttributes(attribute.String("ramlaal.from", parts[0]), attribute.String("ramlaal.instance", n.cfg.Identity.Instance)))
			defer span.End()
			fn(ctx, parts[0], parts[1], m.Data)
		}
	})
	return err
}

func messageText(m *a2a.Message) string {
	if m == nil {
		return ""
	}
	return partsText(m.Parts)
}

func partsText(parts a2a.ContentParts) string {
	var b strings.Builder
	for _, p := range parts {
		if t, ok := p.Content.(a2a.Text); ok {
			b.WriteString(string(t))
		}
	}
	return b.String()
}

func resultText(res a2a.SendMessageResult) (string, error) {
	switch r := res.(type) {
	case *a2a.Message:
		return messageText(r), nil
	case *a2a.Task:
		switch r.Status.State {
		case a2a.TaskStateFailed, a2a.TaskStateRejected, a2a.TaskStateCanceled:
			return "", fmt.Errorf("task %s: %s", r.Status.State, messageText(r.Status.Message))
		}
		var b strings.Builder
		for _, art := range r.Artifacts {
			b.WriteString(partsText(art.Parts))
		}
		if b.Len() == 0 {
			return messageText(r.Status.Message), nil
		}
		return b.String(), nil
	}
	return "", nil
}
