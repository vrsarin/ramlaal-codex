# SDLC MCP integration package

This package connects Ramlaal's Codex worker to the independently published Forgejo Workflow and Wiki.js SDLC MCP servers. The root `compose.sdlc-mcp.yaml` overlay deploys the servers and appends the host or container configuration fragment to the corresponding generated Codex home.

The `platform/` directory owns the migrated full-system integration environment: Keycloak, MCP Gateway, provider applications, local PKI, and their end-to-end tests. Those assets live here rather than in the standalone server repository because Ramlaal is the deployment consumer.

The integration has two credential layers:

1. `FORGEJO_MCP_BEARER_TOKEN` and `WIKIJS_SDLC_MCP_BEARER_TOKEN` authenticate the Ramlaal client to each MCP server. Each value must appear in the corresponding `*_MCP_CLIENT_TOKENS` JSON map.
2. `FORGEJO_ACCESS_TOKEN` and `WIKIJS_ACCESS_TOKEN` are sent through environment-backed provider headers. They identify the narrowly scoped bot account used for provider operations.

No credential is stored in this package or written to generated `config.toml` files. The Codex gateway receives the values from its process environment.

## Start

Copy `.env.example` to `.env`, fill the SDLC variables, and keep `SDLC_ENABLE_WRITES=false` for the first integration pass. `ENABLE_OIDC=false` and `ENABLE_TLS=false` provide the isolated development mode. Test and production deployments should enable both and choose `TLS_MODE=letsencrypt` or `static`. Then run:

```bash
docker compose -f docker-compose.yaml -f compose.sdlc-mcp.yaml --profile sdlc-mcp config --quiet
docker compose -f docker-compose.yaml -f compose.sdlc-mcp.yaml --profile sdlc-mcp pull
docker compose -f docker-compose.yaml -f compose.sdlc-mcp.yaml --profile sdlc-mcp up -d
```

The MCP servers are optional from Codex's perspective, so a temporary server outage does not prevent Ramlaal from starting. Tool calls still require a live connection.

For test and production, replace the moving `:main` image references with the immutable `ghcr.io/...@sha256:...` digests emitted by the successful release workflow. The overlay runs both MCP services with a read-only root filesystem, every Linux capability dropped, `no-new-privileges`, a PID limit, and a non-executable temporary filesystem. Do not weaken those controls to work around certificate or data permissions; mount only the required `/data` volume and read-only certificate files.

## Initial verification

Use read-only provider credentials and ask Ramlaal to:

1. call `get_service_status` on both MCP servers;
2. call `get_repository` for an entry in `SDLC_ALLOWED_REPOSITORIES`;
3. call `discover_wikijs_capabilities` and confirm the returned Wiki.js tools match the bot's page permissions.

Only consider setting `SDLC_ENABLE_WRITES=true` after those checks pass. Forgejo write tools additionally require the repository allowlist, an explicit confirmation, a reason, and provider read-back verification.

## Boundary

The server images and contracts remain owned by `forgejo-wikijs-sdlc-mcp`. This package owns Ramlaal-side deployment, identity and gateway integration, end-to-end platform tests, and Codex client configuration. It deliberately does not copy MCP server source or provider logic into this repository.
