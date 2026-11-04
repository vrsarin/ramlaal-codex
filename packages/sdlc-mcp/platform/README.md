# SDLC MCP integration environment

This directory is owned by Ramlaal and contains the full-system integration environment for the standalone SDLC MCP servers. It is intentionally not part of the MCP server repository.

The environment pulls the published Forgejo, Wiki.js, and Home Assistant MCP images. It also owns the supporting Forgejo, Wiki.js, Keycloak, MCP Gateway, Home Assistant, certificate authority, and end-to-end verification assets needed to exercise those images as Ramlaal will use them.

Run commands from this directory so Compose resolves `.env` and relative mounts consistently:

```bash
cp .env.example .env
make test
make setup
```

`ENABLE_OIDC=false` and `ENABLE_TLS=false` are isolated-development settings only. Shared test and production environments must enable both controls and pin released MCP image digests rather than the moving `main` tag.

The bundle is transitional while its realm, gateway, and network definitions are consolidated into Ramlaal's root deployment topology. The canonical lightweight Ramlaal integration remains `compose.sdlc-mcp.yaml` in the repository root.
