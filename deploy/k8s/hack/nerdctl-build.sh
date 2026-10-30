#!/bin/sh
# Skaffold custom builder for Rancher Desktop with the containerd engine: builds straight into the
# k8s.io namespace so the cluster can use the image without a registry or a push.
#
# Skaffold verifies and re-tags local builds through the `docker` CLI, which has no access to containerd, and it
# deploys the tag `<image>:<docker image ID>`. So this script (1) builds the real image with nerdctl, (2) creates an
# empty, per-image marker in the docker daemon so skaffold has an ID to work with, and (3) gives the real
# containerd image that same ID-based tag. The marker is never run.
# If Rancher Desktop is switched to the dockerd (moby) engine, drop this script and use skaffold's `docker` builder.
#
# Usage (from skaffold): nerdctl-build.sh <dockerfile relative to the build context> [build args...]
set -eu
dockerfile="$1"
shift
args=""
for a in "$@"; do args="$args --build-arg $a"; done
cd "$BUILD_CONTEXT"
# shellcheck disable=SC2086
nerdctl --namespace k8s.io build -t "$IMAGE" -f "$dockerfile" $args .

printf 'FROM scratch\nLABEL ramlaal.marker="%s"\n' "$IMAGE" | docker build -q -t "$IMAGE" - >/dev/null
id=$(docker image inspect -f '{{.Id}}' "$IMAGE")
nerdctl --namespace k8s.io tag "$IMAGE" "${IMAGE%%:*}:${id#sha256:}"
