import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { traceEnv } from "./telemetry.ts";

export type GatewayEvent =
  | { type: "thread_started"; threadId: string }
  | { type: "delta"; itemId: string; text: string }
  | { type: "item"; item: unknown }
  | { type: "diff"; diff: unknown }
  | { type: "usage"; inputTokens: number; cachedInputTokens: number; outputTokens: number }
  | { type: "approval_request"; approvalId: string; kind: string; params: unknown }
  | { type: "turn_completed"; status: string; error: unknown }
  | { type: "error"; message: string };

export interface RunOptions {
  prompt: string;
  cwd: string;
  sandbox?: "read-only" | "workspace-write";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  model?: string;
  config?: Record<string, unknown>;
}

export interface ApprovalBroker {
  request(approvalId: string): Promise<"accept" | "decline">;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

const APPROVAL_METHODS: Record<string, string> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file_change",
};

/** Drives one `codex app-server` process for a single thread/turn. */
export async function* runTurn(
  spec: SpawnSpec,
  opts: RunOptions,
  broker: ApprovalBroker,
  signal?: AbortSignal,
): AsyncGenerator<GatewayEvent> {
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...spec.env, ...traceEnv() },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const queue: GatewayEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (e: GatewayEvent) => {
    queue.push(e);
    wake?.();
  };

  let nextId = 0;
  const pending = new Map<number, Pending>();
  const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ method, id, params });
    });

  let stderrTail = "";
  child.stderr.on("data", (d) => (stderrTail = (stderrTail + d).slice(-2000)));

  const finish = () => {
    done = true;
    wake?.();
  };
  child.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error(`codex exited (${code}): ${stderrTail}`));
    pending.clear();
    if (!done) push({ type: "error", message: `codex exited (${code}): ${stderrTail}` });
    finish();
  });
  signal?.addEventListener("abort", () => child.kill());

  let threadId = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message ?? "rpc error"));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      const kind = APPROVAL_METHODS[msg.method];
      if (!kind) {
        // Unsupported server requests (user input, dynamic tools, ...) are declined, never hung.
        send({ id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
        return;
      }
      const approvalId = `${threadId}:${msg.id}`;
      push({ type: "approval_request", approvalId, kind, params: msg.params });
      broker
        .request(approvalId)
        .catch(() => "decline" as const)
        .then((decision) => send({ id: msg.id, result: { decision } }));
      return;
    }
    switch (msg.method) {
      case "item/agentMessage/delta":
        push({ type: "delta", itemId: msg.params.itemId, text: msg.params.delta });
        break;
      case "item/completed":
        push({ type: "item", item: msg.params.item });
        break;
      case "thread/tokenUsage/updated": {
        // cumulative for the thread; the consumer keeps the latest
        const t = msg.params.tokenUsage.total;
        push({
          type: "usage",
          inputTokens: t.inputTokens,
          cachedInputTokens: t.cachedInputTokens,
          outputTokens: t.outputTokens,
        });
        break;
      }
      case "turn/diff/updated":
        push({ type: "diff", diff: msg.params });
        break;
      case "turn/completed":
        push({
          type: "turn_completed",
          status: msg.params.turn.status,
          error: msg.params.turn.error,
        });
        finish();
        break;
      case "error":
        push({ type: "error", message: JSON.stringify(msg.params) });
        break;
    }
  });

  const start = (async () => {
    await call("initialize", {
      clientInfo: { name: "ramlaal-gateway", title: "Ramlaal Gateway", version: "0.1.0" },
      capabilities: null,
    });
    send({ method: "initialized", params: {} });
    const t = await call("thread/start", {
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? "workspace-write",
      approvalPolicy: opts.approvalPolicy ?? "on-request",
      model: opts.model ?? null,
      config: opts.config ?? null,
    });
    threadId = t.thread.id;
    push({ type: "thread_started", threadId });
    await call("turn/start", {
      threadId,
      input: [{ type: "text", text: opts.prompt, text_elements: [] }],
    });
  })().catch((e: Error) => {
    push({ type: "error", message: e.message });
    finish();
  });

  try {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
    while (queue.length) yield queue.shift()!;
  } finally {
    await Promise.race([start, Promise.resolve()]);
    child.kill();
  }
}
