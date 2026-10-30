package swarm

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"

	"ramlaal/orchestrator/auth"
	"ramlaal/orchestrator/ramlaal"
)

type fakeVerifier struct{}

func (fakeVerifier) Verify(_ context.Context, tok string) (auth.Principal, error) {
	switch tok {
	case "peer":
		return auth.Principal{Subject: "svc", Peer: true}, nil
	case "user":
		return auth.Principal{Subject: "alice"}, nil
	}
	return auth.Principal{}, errors.New("bad token")
}

type fakeCreds struct{ token string }

func (c fakeCreds) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	m := map[string]string{"authorization": "Bearer " + c.token}
	if u := auth.UserFrom(ctx); u != "" {
		m[auth.UserHeader] = u
	}
	return m, nil
}
func (fakeCreds) RequireTransportSecurity() bool { return false }

func startNATS(t *testing.T) string {
	t.Helper()
	s, err := server.NewServer(&server.Options{Host: "127.0.0.1", Port: -1, NoLog: true, NoSigs: true})
	if err != nil {
		t.Fatal(err)
	}
	go s.Start()
	if !s.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats not ready")
	}
	t.Cleanup(s.Shutdown)
	return s.ClientURL()
}

func startNode(t *testing.T, url, name, purpose, token string, caps []string, h func(context.Context, string) (string, error)) *Node {
	t.Helper()
	n, err := Start(Config{
		Identity:   ramlaal.Identity{Instance: name, Purpose: purpose, Capabilities: caps},
		NATSURL:    url,
		ListenAddr: "127.0.0.1:0",
		Auth:       fakeVerifier{},
		PeerCreds:  fakeCreds{token: token},
		Handle:     h, AnnounceEvery: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(n.Close)
	return n
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestDiscoveryAndDelegation(t *testing.T) {
	url := startNATS(t)
	home := startNode(t, url, "home-1", "home appliances", "peer", []string{"home"},
		func(_ context.Context, req string) (string, error) { return "done: " + req, nil })
	code := startNode(t, url, "code-1", "code changes", "peer", []string{"code"},
		func(context.Context, string) (string, error) { return "", errors.New("boom") })

	waitFor(t, "discovery", func() bool { return len(code.Peers()) == 1 && len(home.Peers()) == 1 })
	if p := code.Peers()[0]; p.Instance != "home-1" || p.Capabilities[0] != "home" {
		t.Fatalf("peer = %+v", p)
	}

	out, err := code.Delegate(context.Background(), "home", "turn off the kitchen light")
	if err != nil || out != "done: turn off the kitchen light" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if _, err := home.Delegate(context.Background(), "code", "x"); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("peer failure should surface, got %v", err)
	}
	if _, err := home.Delegate(context.Background(), "netsec", "x"); err == nil || !strings.Contains(err.Error(), "no live peer") {
		t.Fatalf("got %v", err)
	}
}

func TestWrongTokenRejected(t *testing.T) {
	url := startNATS(t)
	startNode(t, url, "home-1", "home", "peer", []string{"home"},
		func(context.Context, string) (string, error) { return "ok", nil })
	intruder := startNode(t, url, "intruder", "x", "wrong", []string{"x"}, nil2)
	waitFor(t, "discovery", func() bool { return len(intruder.Peers()) == 1 })
	if _, err := intruder.Delegate(context.Background(), "home", "unlock the door"); err == nil {
		t.Fatal("a peer with the wrong token must be rejected")
	}
}

func nil2(context.Context, string) (string, error) { return "", nil }

func TestPeerLeavesAndEvents(t *testing.T) {
	url := startNATS(t)
	a := startNode(t, url, "a", "a", "", []string{"home"}, nil2)
	b := startNode(t, url, "b", "b", "", []string{"netsec"}, nil2)
	waitFor(t, "discovery", func() bool { return len(a.Peers()) == 1 })

	got := make(chan string, 1)
	if err := a.Subscribe("alert", func(_ context.Context, from, kind string, payload []byte) {
		got <- from + ":" + kind + ":" + string(payload)
	}); err != nil {
		t.Fatal(err)
	}
	if err := b.nc.Flush(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := b.Publish(context.Background(), "alert", map[string]string{"msg": "unknown device"}); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-got:
		if m != `b:alert:{"msg":"unknown device"}` {
			t.Fatalf("event = %s", m)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no event")
	}

	b.Close()
	waitFor(t, "peer removal", func() bool { return len(a.Peers()) == 0 })
}

// The full path: a worker on instance "code-1" asks for a delegation, the result flows back
// through A2A, and the worker's second reply becomes the task's final answer.
func TestRunTaskDelegatesToPeer(t *testing.T) {
	url := startNATS(t)
	startNode(t, url, "home-1", "home appliances", "peer", []string{"home"},
		func(_ context.Context, req string) (string, error) { return "lights are now off", nil })
	var delegator *Node
	delegator = startNode(t, url, "code-1", "code changes", "peer", []string{"code"}, nil2)
	waitFor(t, "discovery", func() bool { return len(delegator.Peers()) == 1 })

	l := ramlaal.NewLedgers().For("local")
	id := l.CreateTask("turn off the lights", ".", nil)
	worker := ramlaal.NewScriptedRunner(
		ramlaal.RunResult{OK: true, Summary: "DELEGATE: home | turn off all lights"},
		ramlaal.RunResult{OK: true, Summary: "Done, the lights are off.\nKIND: answer"},
	)
	status := ramlaal.RunTask(context.Background(), id, l, worker, ramlaal.NewScriptedReviewer(), ramlaal.NewInMemoryMemory(),
		ramlaal.RunOptions{Delegator: delegator, Identity: ramlaal.Identity{Instance: "code-1", Purpose: "code changes"}})
	if status != "completed" {
		t.Fatalf("status %s", status)
	}
	if !strings.Contains(worker.Prompts[0], "home-1") {
		t.Error("first prompt should list the peer")
	}
	if !strings.Contains(worker.Prompts[1], "lights are now off") {
		t.Error("second prompt should carry the peer's result")
	}
	kinds := ""
	for _, e := range l.Events(0, &id, 0) {
		kinds += e.Kind + ","
	}
	for _, want := range []string{"delegated", "delegation_result", "answered", "task_completed"} {
		if !strings.Contains(kinds, want) {
			t.Errorf("missing %s event in %s", want, kinds)
		}
	}
}
