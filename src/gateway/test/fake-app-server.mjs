// Minimal fake `codex app-server`: speaks the same newline-delimited JSON-RPC.
import { createInterface } from "node:readline";

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") out({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") out({ id: msg.id, result: { thread: { id: "t1" } } });
  else if (msg.method === "turn/start") {
    out({ id: msg.id, result: { turn: { id: "u1" } } });
    out({ method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "u1", itemId: "i1", delta: "hi" } });
    out({ id: 99, method: "item/commandExecution/requestApproval", params: { command: "rm -rf x" } });
  } else if (msg.id === 99 && msg.method === undefined) {
    const status = msg.result?.decision === "accept" ? "completed" : "failed";
    out({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t1",
        turnId: "u1",
        tokenUsage: { total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 } },
      },
    });
    out({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status, error: null } } });
  }
});
