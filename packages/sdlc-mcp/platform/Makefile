# docker compose lets exported shell variables override .env. A stale FORGEJO_OAUTH_CLIENT_ID left in a
# terminal (for example from sourcing an older .env) once made the container ignore the credentials
# just registered, so never pass these through from the caller's environment.
unexport FORGEJO_OAUTH_CLIENT_ID FORGEJO_OAUTH_CLIENT_SECRET FORGEJO_TOKEN_ENCRYPTION_KEY WIKIJS_TOKEN_ENCRYPTION_KEY FORGEJO_OAUTH_REDIRECT_URL WIKIJS_OAUTH_REDIRECT_URL

.PHONY: setup setup-mcp setup-gateway setup-home-assistant configure-home-assistant-sso test-home-assistant-sso test-home-assistant-discovery test-step-ca test-local-ca-init test-local-acme test-mcp-listeners test-gateway test-gateway-tls-policy register-forgejo-oauth test teardown reset

setup setup-mcp setup-gateway setup-home-assistant configure-home-assistant-sso register-forgejo-oauth:
	node deploy/setup/wizard.mjs

test-home-assistant-sso:
	node deploy/setup/checks.mjs home-sso

test-home-assistant-discovery:
	node deploy/setup/checks.mjs home-discovery

test-step-ca:
	node deploy/setup/checks.mjs step-ca

test-local-ca-init:
	node --test deploy/step-ca/init-ca.integration.test.mjs

test-local-acme:
	node --test deploy/step-ca/acme-hostnames.integration.test.mjs

test-mcp-listeners:
	node --test deploy/step-ca/mcp-listeners.integration.test.mjs

test-gateway:
	node deploy/setup/checks.mjs

test-gateway-tls-policy:
	node --test deploy/gateway/upstream-tls-policy.test.mjs

test:
	node --test deploy/wikijs/mcp-permission.test.mjs
	node --test deploy/gateway/wait-ready.test.mjs
	node --test deploy/gateway/check-security.test.mjs
	node --test deploy/gateway/builtin-scan-policy.test.mjs
	node --test deploy/gateway/registration-scan.test.mjs
	node --test deploy/gateway/mcp-upstreams.test.mjs
	node --test deploy/gateway/gateway-url.test.mjs
	node --test deploy/homeassistant/ensure-volumes.test.mjs
	node --test deploy/homeassistant/provider-selection.test.mjs deploy/homeassistant/browser-login.test.mjs deploy/homeassistant/mcp-configuration.test.mjs deploy/homeassistant/onboarding-status.test.mjs deploy/homeassistant/wait-onboarding.test.mjs
	node --test deploy/setup/teardown.test.mjs
	node --test deploy/setup/runtime-secrets.test.mjs
	node --test deploy/setup/local-ca.test.mjs
	node --test deploy/setup/trusted-fetch.test.mjs
	node --test deploy/setup/configuration.test.mjs deploy/setup/forgejo-oauth.test.mjs
	node --test deploy/setup/wait-oidc.test.mjs
	node --test deploy/setup/prerequisites.test.mjs
	node --test deploy/setup/wizard.test.mjs
	python3 -B deploy/gateway/reconcile-security.test.py
	python3 deploy/homeassistant/configure-oidc.test.py
	python3 -B deploy/homeassistant/identity/identity.test.py

teardown:
	node deploy/setup/teardown.mjs

reset: teardown setup
