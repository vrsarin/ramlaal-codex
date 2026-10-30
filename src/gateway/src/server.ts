import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { runTurn, type ApprovalBroker, type SpawnSpec, type RunOptions } from "./codex.ts";
import { authConfigFromEnv, makeAuthenticator } from "./auth.ts";
import { inRequestSpan, log, shutdownTelemetry } from "./telemetry.ts";

const require = createRequire(import.meta.url);
const PORT = Number(process.env.GATEWAY_PORT ?? 8090);
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000);
// auto: approvals are surfaced to the UI; deny: decline everything; allow: accept (isolated sandboxes only)
const APPROVAL_MODE = process.env.APPROVAL_MODE ?? "auto";

// Same mapping compose uses: the shared .env holds LITELLM_MASTER_KEY, Codex reads LITELLM_API_KEY.
process.env.LITELLM_API_KEY ||= process.env.LITELLM_MASTER_KEY;
console.log(`gateway: CODEX_HOME=${process.env.CODEX_HOME ?? "(default ~/.codex)"} LITELLM_API_KEY=${process.env.LITELLM_API_KEY ? "set" : "MISSING"}`);

const spec: SpawnSpec = {
  command: process.execPath,
  args: [require.resolve("@openai/codex/bin/codex.js"), "app-server"],
  env: process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : undefined,
};

const waiting = new Map<string, (d: "accept" | "decline") => void>();

const broker: ApprovalBroker = {
  request(id) {
    if (APPROVAL_MODE === "deny") return Promise.resolve("decline");
    if (APPROVAL_MODE === "allow") return Promise.resolve("accept");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve("decline");
      }, APPROVAL_TIMEOUT_MS);
      waiting.set(id, (d) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(d);
      });
    });
  },
};

async function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const authConfig = authConfigFromEnv(process.env);
const authenticate = authConfig ? makeAuthenticator(authConfig) : undefined;
if (!authenticate) console.warn("WARNING: AUTH_ISSUER is not set: the gateway is unauthenticated");

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/health") return void handle(req, res, url);
  return void inRequestSpan(req.headers, `${req.method} ${url.pathname.startsWith("/approvals/") ? "/approvals/{id}" : url.pathname}`, () => handle(req, res, url));
});

async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    if (authenticate && !(req.method === "GET" && url.pathname === "/health") && !(await authenticate(req.headers.authorization))) {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200).end("ok");
    } else if (req.method === "POST" && url.pathname === "/run") {
      const opts = (await readJson(req)) as RunOptions;
      if (!opts.prompt || !opts.cwd) {
        res.writeHead(400).end(JSON.stringify({ error: "prompt and cwd are required" }));
        return;
      }
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      log("info", "codex turn started", { sandbox: opts.sandbox ?? "", model: opts.model ?? "" });
      for await (const ev of runTurn(spec, opts, broker, ac.signal)) {
        res.write(JSON.stringify(ev) + "\n");
      }
      log("info", "codex turn finished");
      res.end();
    } else if (req.method === "POST" && url.pathname.startsWith("/approvals/")) {
      const id = decodeURIComponent(url.pathname.slice("/approvals/".length));
      const { decision } = await readJson(req);
      const resolve = waiting.get(id);
      if (!resolve) {
        res.writeHead(404).end(JSON.stringify({ error: "unknown or expired approval" }));
        return;
      }
      resolve(decision === "accept" ? "accept" : "decline");
      res.writeHead(200).end("{}");
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    log("error", "request failed", { error: String(e) });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

server.listen(PORT, () => console.log(`gateway listening on :${PORT}`));
process.once("SIGTERM", () => void shutdownTelemetry().finally(() => process.exit(0)));
