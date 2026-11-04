ARG CADDY_IMAGE=caddy:2-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
ARG HOME_ASSISTANT_IMAGE=ghcr.io/home-assistant/home-assistant:2026.10.4@sha256:23f4dfbb69ce76315dbc4de7915504f1c2dcecd7ca2648113a493a385972e133
FROM ${CADDY_IMAGE} AS caddy
FROM ${HOME_ASSISTANT_IMAGE}
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY run-local-proxy.sh /etc/services.d/sdlc-proxy/run
RUN chmod 0755 /etc/services.d/sdlc-proxy/run
