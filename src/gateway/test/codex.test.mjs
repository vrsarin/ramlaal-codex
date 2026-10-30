import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runTurn } from "../src/codex.ts";

const spec = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url))],
};

async function collect(decision) {
  const events = [];
  const broker = { request: async () => decision };
  for await (const e of runTurn(spec, { prompt: "p", cwd: process.cwd() }, broker)) events.push(e);
  return events;
}

test("streams deltas and surfaces approval, accepted", async () => {
  const ev = await collect("accept");
  assert.deepEqual(ev.map((e) => e.type), ["thread_started", "delta", "approval_request", "usage", "turn_completed"]);
  assert.deepEqual(ev.find((e) => e.type === "usage"), { type: "usage", inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 });
  assert.equal(ev.at(-1).status, "completed");
});

test("declined approval is reported by the turn", async () => {
  const ev = await collect("decline");
  assert.equal(ev.at(-1).status, "failed");
});
