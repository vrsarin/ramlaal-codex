import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, signOut, userName, withStreamToken } from "./auth";

type LedgerEvent = { id: number; ts: number; task_id: number | null; peer: string | null; kind: string; payload: any };
type Task = { id: number; mission: string; status: string; attempts: number; workspace: string; cost_usd?: number };
type Settings = { workspace: string; verify_command: string; showDetails: boolean };

const api = async (path: string, init?: RequestInit) => {
  const headers = { ...(await authHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const r = await fetch(`/api${path}`, { ...init, headers });
  if (r.status === 401) throw new Error("unauthorized");
  return r.json();
};
const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

const SETTINGS_KEY = "ramlaal.settings";
const DEFAULTS: Settings = { workspace: "", verify_command: "", showDetails: false };
const loadSettings = (): Settings => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
};

function useLedger() {
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const refresh = () => api("/tasks").then((t) => { setTasks(t); setOnline(true); }).catch(() => setOnline(false));
    let es: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      es = new EventSource(withStreamToken("/api/stream"));
      es.onmessage = (m) => {
        const e: LedgerEvent = JSON.parse(m.data);
        setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
        refresh();
      };
      // Reconnect by hand: the browser would retry with the old, possibly expired, token in the URL.
      es.onerror = () => {
        setOnline(false);
        es.close();
        retry = setTimeout(open, 3000);
      };
    };
    open();
    refresh();
    return () => {
      clearTimeout(retry);
      es.close();
    };
  }, []);
  return { events, tasks, online };
}

// Plain-English line for a ledger event; null means "not worth showing".
function plain(e: LedgerEvent): string | null {
  const p = e.payload;
  switch (e.kind) {
    case "memory_retrieved":
      return p.ids.length ? `Recalled ${p.ids.length} lesson${p.ids.length > 1 ? "s" : ""} from earlier jobs.` : "Checked my notes; nothing relevant yet.";
    case "attempt_started": {
      const how = p.tier === "cheap" ? " (light, low-cost mode)" : p.tier === "strong" ? " (full-power mode)" : "";
      return p.attempt === 1 ? `Working on it${how}…` : `Trying again${how}, using what went wrong last time…`;
    }
    case "route_overridden": return "Skipping low-cost mode; it has struggled lately.";
    case "verify": return p.ok ? "The check passed." : "The check failed.";
    case "review": return p.approved ? "A second reviewer signed off." : `The reviewer wasn't satisfied: ${p.critique}`;
    case "review_skipped": return "The check passed and I'm confident, so I skipped the second review.";
    case "attempt_failed": return `That try didn't work: ${p.problem}`;
    case "memory_written": return "Saved a lesson so next time is faster.";
    case "memory_error": return "My memory store is unreachable; carrying on without it.";
    case "task_completed": return "Finished.";
    case "escalated": return p.reason === "a retry cannot fix this" ? "Stopping early: trying again wouldn't help." : "Giving up after several tries.";
    default: return null;
  }
}

function finalAnswer(evs: LedgerEvent[]): string {
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.kind === "codex" && e.peer === "worker" && e.payload.type === "item" && e.payload.item?.type === "agentMessage") {
      return String(e.payload.item.text ?? "").trim();
    }
  }
  return "";
}

function Typing() {
  return <span className="typing" aria-label="working"><i /><i /><i /></span>;
}

function Reply({ task, evs, approvals, showDetails, onDecide }: {
  task: Task; evs: LedgerEvent[]; approvals: LedgerEvent[]; showDetails: boolean; onDecide: (id: string, d: "accept" | "decline") => void;
}) {
  const [open, setOpen] = useState(false);
  const steps = evs.map((e) => ({ e, text: plain(e) })).filter((s) => s.text);
  const latest = steps.at(-1)?.text ?? "Getting started…";
  const done = task.status === "completed";
  const failed = task.status === "escalated";
  const answer = finalAnswer(evs);
  const memoriesWritten = evs.filter((e) => e.kind === "memory_written");
  const learned = memoriesWritten.some((e) => ["lesson", "procedure"].includes(e.payload.memory_kind));
  const remembered = memoriesWritten.some((e) => e.payload.memory_kind === "fact");
  const lastProblem = [...evs].reverse().find((e) => e.kind === "attempt_failed")?.payload.problem;

  return (
    <div className="msg bot">
      {approvals.map((a) => (
        <div className="ask" key={a.id}>
          <b>May I {a.payload.kind === "command" ? "run this command" : "change a file"}?</b>
          <code>{String(a.payload.params.command ?? a.payload.params.reason ?? "See details")}</code>
          <div className="row">
            <button className="primary" onClick={() => onDecide(a.payload.approvalId, "accept")}>Yes, go ahead</button>
            <button onClick={() => onDecide(a.payload.approvalId, "decline")}>No</button>
          </div>
        </div>
      ))}

      {!done && !failed && <p className="live">{latest} <Typing /></p>}
      {done && <p>{answer || "All done."}</p>}
      {failed && (
        <p className="bad">
          I couldn't finish this on my own.{lastProblem ? ` The last problem was: ${lastProblem}` : ""} Could you take a look, or give me more detail and I'll try again?
        </p>
      )}
      {done && learned && <p className="note ok">✨ I saved a reviewed lesson to reuse next time.</p>}
      {done && remembered && <p className="note ok">📝 I saved a note for next time.</p>}
      {!!task.cost_usd && showDetails && <p className="note">Cost: ${task.cost_usd.toFixed(task.cost_usd < 0.01 ? 4 : 2)}</p>}

      <button className="link" onClick={() => setOpen(!open)}>{open ? "Hide" : "How I did it"}</button>
      {open && (
        <div className="story">
          <ul>{steps.map(({ e, text }) => <li key={e.id} className={e.kind}>{text}</li>)}</ul>
          {showDetails && (
            <pre>{evs.map((e) => `${e.kind} [${e.peer ?? "system"}] ${JSON.stringify(e.payload).slice(0, 300)}`).join("\n")}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ value, onChange, onClose, defaultWorkspace }: { value: Settings; onChange: (s: Settings) => void; onClose: () => void; defaultWorkspace: string }) {
  return (
    <aside className="settings">
      <header>
        <h2>Settings</h2>
        <button className="link" onClick={onClose}>Done</button>
      </header>
      <label>
        Project folder <span className="hint">(optional)</span>
        <span className="hint">Leave empty to work in the folder I was started in{defaultWorkspace ? `: ${defaultWorkspace}` : ""}.</span>
        <input placeholder={defaultWorkspace || "default folder"} value={value.workspace} onChange={(e) => onChange({ ...value, workspace: e.target.value })} />
      </label>
      <label>
        Check command <span className="hint">(optional)</span>
        <span className="hint">A command that passes when my work is right, like "pytest -q". Without it, I rely on a second reviewer only.</span>
        <input placeholder="pytest -q" value={value.verify_command} onChange={(e) => onChange({ ...value, verify_command: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={value.showDetails} onChange={(e) => onChange({ ...value, showDetails: e.target.checked })} />
        Show costs and technical details
      </label>
    </aside>
  );
}

export function App() {
  const { events, tasks, online } = useLedger();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState("");
  const [defaultWorkspace, setDefaultWorkspace] = useState("");
  useEffect(() => {
    api("/config").then((c) => setDefaultWorkspace(c?.default_workspace ?? "")).catch(() => {});
  }, []);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const byTask = useMemo(() => {
    const m = new Map<number, LedgerEvent[]>();
    for (const e of events) if (e.task_id !== null) m.set(e.task_id, [...(m.get(e.task_id) ?? []), e]);
    return m;
  }, [events]);
  const thread = useMemo(() => [...tasks].sort((a, b) => a.id - b.id), [tasks]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, tasks.length]);

  const approvalsFor = (id: number) =>
    (byTask.get(id) ?? []).filter((e) => e.kind === "codex" && e.payload.type === "approval_request" && !handled.has(e.payload.approvalId));

  const decide = async (id: string, decision: "accept" | "decline") => {
    setHandled((h) => new Set(h).add(id));
    await post(`/approvals/${encodeURIComponent(id)}`, { decision });
  };

  const send = async () => {
    const mission = draft.trim();
    if (!mission) return;
    setHint("");
    setDraft("");
    await post("/tasks", { mission, workspace: settings.workspace.trim() || null, verify_command: settings.verify_command.trim() || null });
  };

  return (
    <div className="chat">
      <header className="bar">
        <div>
          <b>Ramlaal</b>
          <span className="sub"> your self-improving coding helper</span>
        </div>
        <div>
          {userName() && <button className="link" onClick={signOut}>Sign out ({userName()})</button>}
          <button className="link" onClick={() => setShowSettings(!showSettings)}>⚙ Settings</button>
        </div>
      </header>

      {!online && <div className="banner">I can't reach the helper service. Make sure it's running, then refresh.</div>}
      {showSettings && <SettingsPanel value={settings} onChange={setSettings} onClose={() => setShowSettings(false)} defaultWorkspace={defaultWorkspace} />}

      <main className="thread">
        {thread.length === 0 && (
          <div className="welcome">
            <h1>Hi! What should I work on?</h1>
            <p>Describe it like you would to a colleague. I'll do the work, check it, get a second opinion, and remember what I learn.</p>
            <div className="row">
              <button onClick={() => post("/replay")}>See a quick demo</button>
              <button onClick={() => setShowSettings(true)}>Settings</button>
            </div>
          </div>
        )}
        {thread.map((t) => (
          <div key={t.id}>
            <div className="msg me">{t.mission}</div>
            <Reply task={t} evs={byTask.get(t.id) ?? []} approvals={approvalsFor(t.id)} showDetails={settings.showDetails} onDecide={decide} />
          </div>
        ))}
        <div ref={endRef} />
      </main>

      <footer className="composer">
        {hint && <p className="hint-bad">{hint}</p>}
        <div className="row">
          <textarea
            rows={2}
            placeholder="Describe what you want done…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="primary" onClick={send} disabled={!draft.trim()}>Send</button>
        </div>
        <p className="foot">Working in {settings.workspace || defaultWorkspace || "the folder I was started in"}</p>
      </footer>
    </div>
  );
}
