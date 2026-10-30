package ramlaal

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// Task is the live state of one unit of work, in the JSON shape the UI consumes.
type Task struct {
	ID            int64   `json:"id"`
	Mission       string  `json:"mission"`
	Workspace     string  `json:"workspace"`
	VerifyCommand *string `json:"verify_command"`
	Status        string  `json:"status"`
	Attempts      int     `json:"attempts"`
	CostUSD       float64 `json:"cost_usd"`
	CreatedAt     float64 `json:"created_at"`
}

// Event is one entry of a task's live activity feed.
type Event struct {
	ID      int64          `json:"id"`
	TS      float64        `json:"ts"`
	TaskID  *int64         `json:"task_id"`
	Peer    *string        `json:"peer"`
	Kind    string         `json:"kind"`
	Payload map[string]any `json:"payload"`
}

// Retention bounds. Nothing is persisted: the ledger is the live task state and activity feed of
// one user, so a restart starts clean and old entries are dropped.
const (
	maxTasks  = 200
	maxEvents = 5000
)

// Ledger holds one user's tasks and events in memory.
type Ledger struct {
	mu        sync.Mutex
	tasks     []Task // ascending id
	events    []Event
	nextTask  int64
	nextEvent int64
}

// NewMemoryLedger is an empty ledger.
func NewMemoryLedger() *Ledger { return &Ledger{} }

func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }

func (l *Ledger) find(taskID int64) *Task {
	for i := len(l.tasks) - 1; i >= 0; i-- {
		if l.tasks[i].ID == taskID {
			return &l.tasks[i]
		}
	}
	return nil
}

func (l *Ledger) AddCost(taskID int64, usd float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t := l.find(taskID); t != nil {
		t.CostUSD += usd
	}
}

func (l *Ledger) CreateTask(mission, workspace string, verifyCommand *string) int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextTask++
	l.tasks = append(l.tasks, Task{ID: l.nextTask, Mission: mission, Workspace: workspace,
		VerifyCommand: verifyCommand, Status: "pending", CreatedAt: now()})
	if len(l.tasks) > maxTasks {
		l.tasks = append([]Task(nil), l.tasks[len(l.tasks)-maxTasks:]...)
	}
	return l.nextTask
}

// UpdateTask changes only status and/or attempts; nil leaves a field alone.
func (l *Ledger) UpdateTask(taskID int64, status *string, attempts *int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.find(taskID)
	if t == nil {
		return
	}
	if status != nil {
		t.Status = *status
	}
	if attempts != nil {
		t.Attempts = *attempts
	}
}

// Append records one event and returns its id. taskID/peer may be nil.
func (l *Ledger) Append(kind string, taskID *int64, peer string, payload map[string]any) int64 {
	if payload == nil {
		payload = map[string]any{}
	}
	// A JSON round trip gives every reader the same plain shape and detaches the stored copy.
	raw, err := json.Marshal(payload)
	if err != nil {
		raw, _ = json.Marshal(map[string]any{"unserializable": fmt.Sprint(payload)})
	}
	var stored map[string]any
	if json.Unmarshal(raw, &stored) != nil || stored == nil {
		stored = map[string]any{}
	}
	e := Event{TS: now(), Kind: kind, Payload: stored}
	if taskID != nil {
		id := *taskID
		e.TaskID = &id
	}
	if peer != "" {
		e.Peer = &peer
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextEvent++
	e.ID = l.nextEvent
	l.events = append(l.events, e)
	if len(l.events) > maxEvents {
		l.events = append([]Event(nil), l.events[len(l.events)-maxEvents:]...)
	}
	return e.ID
}

// Recent returns newest-first events of one kind across all tasks.
func (l *Ledger) Recent(kind string, limit int) []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []Event{}
	for i := len(l.events) - 1; i >= 0 && len(out) < limit; i-- {
		if l.events[i].Kind == kind {
			out = append(out, l.events[i])
		}
	}
	return out
}

// Events returns events with id > after in id order, optionally for one task.
// HasApproval reports whether a Codex approval request with this id was raised for this user.
func (l *Ledger) HasApproval(approvalID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.events {
		if e.Kind == "codex" && e.Payload["type"] == "approval_request" && e.Payload["approvalId"] == approvalID {
			return true
		}
	}
	return false
}

func (l *Ledger) Events(after int64, taskID *int64, limit int) []Event {
	if limit <= 0 {
		limit = 500
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []Event{}
	for _, e := range l.events {
		if e.ID <= after || (taskID != nil && (e.TaskID == nil || *e.TaskID != *taskID)) {
			continue
		}
		out = append(out, e)
		if len(out) == limit {
			break
		}
	}
	return out
}

// Tasks returns all retained tasks, newest first.
func (l *Ledger) Tasks() []Task {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Task, 0, len(l.tasks))
	for i := len(l.tasks) - 1; i >= 0; i-- {
		out = append(out, l.tasks[i])
	}
	return out
}

func (l *Ledger) Task(taskID int64) (Task, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t := l.find(taskID); t != nil {
		return *t, nil
	}
	return Task{}, fmt.Errorf("task %d not found", taskID)
}

// Ledgers gives every user a private ledger, created on first use.
type Ledgers struct {
	mu sync.Mutex
	m  map[string]*Ledger
}

func NewLedgers() *Ledgers { return &Ledgers{m: map[string]*Ledger{}} }

func (s *Ledgers) For(user string) *Ledger {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.m[user]
	if l == nil {
		l = NewMemoryLedger()
		s.m[user] = l
	}
	return l
}
