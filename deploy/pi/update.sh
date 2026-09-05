#!/usr/bin/env bash
#
# Update the game on the Pi to the image GitHub Actions last built.
#
#   cd /home/ycmah/frontier-capital && git pull --ff-only && deploy/pi/update.sh
#
# Runs from the checkout's deploy/pi directory (it cds there itself). Validates
# the compose merge first — an overlay that adds a service instead of
# overriding `app` would otherwise "update" a container nobody is routed to
# and report success — then pulls, restarts the one service, waits for
# /api/llm/health, and prints both the image DIGEST now serving and the BUILD
# the container reports at /api/version: the tag is the same string before and
# after an update, so the digest is the evidence, and the build stamp is the
# same one a founder can read in the start page footer from a phone. Rolls back
# to the previous image (kept as frontier-capital:rollback) if health does not
# come up. Safe from any SSH app on a phone over the tailnet, or from the
# systemd timer in the README. Needs nothing from a Mac.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="ghcr.io/mahyancheng/lm/frontier-capital:pi"
SERVICE="app"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.ghcr.yml)
PORT="${PORT:-8110}"

# --- preflight: the merge must yield exactly the one service, and that one
# --- must carry the registry image, or the overlay is not doing its job.
merged="$("${COMPOSE[@]}" config 2>&1)" || { echo "!! compose config failed:" >&2; echo "$merged" >&2; exit 2; }
services="$(printf '%s\n' "$merged" | awk '/^services:/{s=1;next} s&&/^[^ ]/{s=0} s&&/^  [A-Za-z0-9_-]+:$/{print $1}' | tr -d ':')"
if [[ "$(printf '%s\n' "$services" | wc -l)" -ne 1 || "$services" != "$SERVICE" ]]; then
  echo "!! compose merge produced services [$(printf '%s ' $services)] — expected exactly '${SERVICE}'. Not updating." >&2
  exit 2
fi
printf '%s\n' "$merged" | grep -q "image: ${IMAGE}" || { echo "!! merged config does not run ${IMAGE}. Not updating." >&2; exit 2; }

digest_of() { docker image inspect --format '{{index .RepoDigests 0}}' "$1" 2>/dev/null || true; }
id_of() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

# What the container itself says it is. /api/version needs no auth, is never
# cached, and carries the same commit and build time the start page footer
# shows — so this line and the phone agree or something is wrong. Parsed with
# sed because the Pi has no jq, and an unstamped image answers "dev".
running_build() {
  local body short at
  body="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/version" 2>/dev/null || true)"
  short="$(printf '%s' "$body" | sed -n 's/.*"shortSha":"\([^"]*\)".*/\1/p')"
  at="$(printf '%s' "$body" | sed -n 's/.*"builtAt":"\([^"]*\)".*/\1/p')"
  if [[ -z "$short" ]]; then
    echo "build unknown — /api/version did not answer"
  else
    echo "running build ${short} (${at:-no build time stamped})"
  fi
}

running_id="$(docker inspect --format '{{.Image}}' frontier-capital 2>/dev/null || true)"
if [[ -n "$running_id" ]]; then
  docker tag "$running_id" frontier-capital:rollback
fi

echo "==> Pulling ${IMAGE}"
docker pull "${IMAGE}" >/dev/null
new_id="$(id_of "${IMAGE}")"
new_digest="$(digest_of "${IMAGE}")"
if [[ -n "$running_id" && "$new_id" == "$running_id" ]]; then
  echo "Already on the latest image: ${new_digest:-$new_id}"
  echo "  version:  $(running_build)"
  exit 0
fi

echo "==> Restarting ${SERVICE}"
"${COMPOSE[@]}" up -d --no-build "${SERVICE}"

echo "==> Waiting for health"
for _ in $(seq 1 40); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/llm/health" >/dev/null 2>&1; then
    checkout="$(git -C ../.. rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout')"
    echo "Live."
    echo "  image:    ${IMAGE}"
    echo "  digest:   ${new_digest:-<none: local image, no registry digest>}"
    echo "  image id: ${new_id}"
    echo "  checkout: ${checkout}"
    echo "  version:  $(running_build)"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done

echo "!! Health did not come up — rolling back" >&2
if docker image inspect frontier-capital:rollback >/dev/null 2>&1; then
  docker tag frontier-capital:rollback "${IMAGE}"
  "${COMPOSE[@]}" up -d --no-build "${SERVICE}"
  echo "Rolled back to image id $(id_of frontier-capital:rollback)" >&2
fi
exit 1
