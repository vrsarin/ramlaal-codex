# Ramlaal Integration with Codex

Integrate Ram laal with Codex CLI and integrate litellm as llm router using jev as decision boundary.

## Features

1. [x] Codex CLI as harness
1. [x] Axion Memory as custom context/memory layer for Codex CLI
1. [x] Litellm as LLM provider
1. [ ] Jev as LLM router

## SDLC MCP services

Ramlaal is a client of the independently released Forgejo and Wiki.js SDLC MCP servers. Their source is not embedded in this repository. Public images are published by `forgejo-wikijs-sdlc-mcp`:

- `ghcr.io/vrsarin/forgejo-mcp-server`
- `ghcr.io/vrsarin/wikijs-sdlc-mcp-server`

The optional `compose.sdlc-mcp.yaml` overlay pulls and runs both services without adding a source-level dependency:

```bash
docker compose -f docker-compose.yaml -f compose.sdlc-mcp.yaml --profile sdlc-mcp pull
docker compose -f docker-compose.yaml -f compose.sdlc-mcp.yaml --profile sdlc-mcp up -d
```

Copy `.env.example` to `.env`, set distinct MCP client tokens and narrowly scoped provider tokens, and configure provider URLs before enabling the profile. The local endpoints default to `http://localhost:3010/mcp` and `http://localhost:3011/mcp`; containers on the Compose network use `http://forgejo-mcp:3000/mcp` and `http://wikijs-sdlc-mcp:3000/mcp`.

The overlay appends the configuration in `packages/sdlc-mcp` to Ramlaal's generated Codex homes. It supplies MCP bearer credentials and bot-scoped provider credentials through the gateway environment, so the Codex worker can call both servers without writing secrets to TOML. See the package README for the verification sequence and credential boundary.

Use `main` only for development. Pin a semantic-version tag or immutable digest for shared deployments, and leave `SDLC_ENABLE_WRITES=false` until the read-only path has been verified.

## Self-healing, self-learning swarm (scaffold)

Inspired by [Agora v2](https://github.com/cwijayasundara/self-organizing-agents-v2): peers coordinate through an in-memory, per-user event ledger (nothing is persisted; a restart clears task state), and an independent reviewer gates every result.

| Component | Path | Tech | Role |
|---|---|---|---|
| Gateway | `src/gateway` | Node 22 (TS, no build) | Spawns `codex app-server` from the `@openai/codex` npm package, streams NDJSON events, brokers approvals |
| Orchestrator | `src/orchestrator` | Go (stdlib `net/http`) | In-memory per-user ledger, heal/learn loop, reviewer, SSE feed |
| Memory | `src/memory` | Go (`pgx` + pgvector, Ollama embeddings) | Stateless `/add` + `/search` service over Postgres/pgvector; plain vector similarity, no custom ranking. Replicas share one database, so many Ramlaal instances can use one memory |
| Observer UI | `src/ui` | React + Vite | Live ledger timeline, approvals, memory panel |

**Heal:** a failed attempt (agent error, failing `verify_command`, or reviewer rejection) is recorded and the retry gets the critique plus previously verified lessons. After `MAX_ATTEMPTS` the task is escalated.
**Learn:** Ramlaal acts as a general assistant: it answers questions, chats and does file or command work. A plain answer (`KIND: answer`) is not reviewed or verified. Work is verified and independently reviewed, and only an approved outcome is saved as a `lesson` or `procedure`. Separately, the assistant can share durable facts with `REMEMBER:` lines (preferences, project facts, procedures). Every memory is tagged with `instance` and `purpose` (`RAMLAAL_INSTANCE`, `RAMLAAL_PURPOSE`), and all instances using the same memory service recall each other's memories. Failed attempts stay in the ledger and are never written to memory.

**Swarm:** instances with different roles (e.g. home automation, code changes, network security) run as separate deployments that share one NATS server and one memory service. Each sets `RAMLAAL_INSTANCE`, `RAMLAAL_PURPOSE` and `RAMLAAL_CAPABILITIES` (comma separated, e.g. `home`) and `NATS_URL`. Instances announce themselves on `ramlaal.registry.announce` (heartbeat 5s, expiry after 3 misses) and serve A2A over gRPC (`SWARM_LISTEN`, default `:9000`; `SWARM_ADVERTISE`, default `<hostname>:9000`). A worker delegates with `DELEGATE: <capability> | <request>`; the call goes to a live peer with that capability, failing over to the next. Delegated requests cannot delegate again, and peer replies are treated as untrusted data. Events are published on `ramlaal.events.<instance>.<kind>`. The A2A agent card is at `/.well-known/agent-card.json` on the orchestrator HTTP port. gRPC is plaintext, so keep the swarm on a private network.

**Auth and per-user A2A:** every request is authenticated with a Keycloak (OIDC) JWT, and the user is the token `sub`. Set `AUTH_ISSUER` (the token `iss`, e.g. `http://localhost:8180/realms/ramlaal`), `AUTH_DISCOVERY_URL` (where the orchestrator reaches Keycloak), and optionally `AUTH_AUDIENCE`. With `AUTH_ISSUER` empty, auth is off and everyone is the single user `local` (dev only). A2A is served as JSON-RPC at `/a2a` and over gRPC (`SWARM_LISTEN`); tasks are scoped per user, and the REST API and SSE feed (`/stream`, which also accepts `?access_token=`) use the same per-user ledger. Instances call each other with a client-credentials token (`SWARM_CLIENT_ID`/`SWARM_CLIENT_SECRET`, realm role `swarm-peer`) and pass the user in `x-ramlaal-user`; only `swarm-peer` tokens may act on behalf of a user. Keycloak is part of the default `docker compose up` (UI at `http://localhost:8180`, admin `admin`/`admin`), with a static realm in `deploy/local/keycloak/ramlaal-realm.json`: user `dev`/`dev`, clients `ramlaal-ui` (public, PKCE) and `ramlaal-swarm` (service account with `swarm-peer`). Every component is protected by that realm: the web UI redirects to the Keycloak login (keycloak-js, PKCE; `VITE_KEYCLOAK_URL` at build time, empty disables it); the orchestrator accepts user tokens and `swarm-peer` tokens; the memory service and the gateway (which runs Codex) accept only `swarm-peer` service-account tokens, never end users, and the orchestrator calls them with its client-credentials token. `/approvals/{id}` only works for approvals raised for the calling user. LiteLLM keeps its master key and is only reached by the gateway; Ollama and NATS are internal. Compose enables auth by default; set `AUTH_ISSUER=` (empty) and build the UI with `VITE_KEYCLOAK_URL=` to run without it. Replace the dev client secret (`SWARM_CLIENT_SECRET`) and passwords before any real deployment. Memory is still a single shared user; per-user memory comes later. Start a second instance with e.g. `RAMLAAL_INSTANCE=home-1 RAMLAAL_CAPABILITIES=home docker compose -p home up orchestrator` against the same NATS.

Run everything: `make up` (UI on http://127.0.0.1:8081). In VS Code, choose **Full local stack (LiteLLM)** in Run and Debug to start the dependencies in Docker and launch the host-side orchestrator, gateway, and Vite UI. The host launch binds the A2A gRPC listener to port 19000 because Windows reserves port 9000 on some systems. Put task workspaces under `.data/workspaces` (`/workspaces` in the containers). Try the UI without a model via **See a quick demo**. The UI is a chat: type a request, the helper replies live; project folder and check command live under ⚙ Settings.
Tests: `make test`. Regenerate Codex protocol types with `npm run gen-types` in `src/gateway` after bumping `@openai/codex`.

Gateway env: `APPROVAL_MODE` = `auto` (ask the UI, deny on timeout), `deny`, or `allow` (only inside isolated sandboxes).

### Cost optimization

Small decisions are made by a swappable **decider** that returns a typed choice plus a confidence (`src/orchestrator/ramlaal/decider.py`); expensive Codex turns are kept for real work. Uncertain or failing deciders always fall back to the safe, more expensive path.

| Decision | Options | Effect |
|---|---|---|
| `route` | cheap / strong | Start on `MODEL_CHEAP`; go straight to `MODEL_STRONG` for hard missions or low confidence |
| `after_failure` | retry / escalate | Stop early (no wasted attempts) when a retry cannot help, e.g. bad credentials |
| `review` | required / skip | Opt-in via `SKIP_REVIEW_CONFIDENCE`; only after a passing `verify_command`, and skipped work is never memorized |

- A failed attempt always upgrades the next attempt to the strong tier.
- **Evolves:** every task records a `route_outcome`. If the cheap tier succeeds first try less than 60% of the time over the last 5+ cheap tasks, routing goes strong, re-probing cheap every 5th task.
- **Cost is measured, not guessed:** the gateway forwards Codex token usage, `MODEL_PRICES` (JSON, USD per million tokens, e.g. `{"gpt-mini":{"input":0.25,"cached_input":0.03,"output":2}}`) turns it into dollars, and the UI shows cost per job. `GET /stats` gives totals and cheap-tier success rates. Unpriced models count as $0.
- `DECIDER=rules` (default, free heuristics) or `DECIDER=llm` (any model behind LiteLLM, set `DECIDER_MODEL`; falls back to rules on error).
- **Jev** ([TypeSafe AI](https://typesafe.ai/), early access): `DECIDER=jev` is reserved and fails fast until an adapter implementing `Decider` is written against its API. Its typed, calibrated decisions map directly onto the table above.
- `MODEL_*` names must exist in `deploy/local/litellm/litellm.yaml`; the current `codex-local` (qwen2.5:0.5b) is too weak to drive Codex, so add a real cheap and strong pair.
- Running Codex on the host: "Full local stack" uses your own `~/.codex` login and default model; "Full local stack (LiteLLM)" points Codex at LiteLLM through `.data/codex-home`, which the `codex-config` compose service fills from `deploy/local/codex/config.toml` (needs `LITELLM_API_KEY` set and LiteLLM running on :4000). Either way every job goes through the orchestrator, so memory recall, verification, review and cost tracking apply. Don't put a `.codex/config.toml` with `model = "codex-local"` in a project folder: Codex ignores `model_provider` there and sends that model name to your ChatGPT account.

## Observability (traces + logs + LLM calls in one place)

`docker compose up -d otel` starts Grafana + Tempo + Loki (http://localhost:3000, admin/admin). The orchestrator, gateway, memory service and LiteLLM export OTLP to it (`OTEL_EXPORTER_OTLP_ENDPOINT`, default `http://otel:4318`; unset it to turn export off).

- One request = one trace: UI/HTTP -> orchestrator (`ramlaal.task` / `ramlaal.attempt`) -> gateway `/run` -> memory, and across instances via A2A gRPC (`swarm.delegate`) and NATS events, using W3C `traceparent`.
- Filter by `service.instance.id` / `ramlaal.instance` to see which instance handled each hop. Logs carry `trace_id`, so Tempo spans link to Loki logs.
- LiteLLM emits its LLM-call spans (model, tokens). The Codex child process gets `TRACEPARENT`; it only joins the trace if Codex honors it.
- Point `OTEL_EXPORTER_OTLP_ENDPOINT` at SigNoz or a collector (fan-out to Phoenix) to use those instead; no code changes needed.
