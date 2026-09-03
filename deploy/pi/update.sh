#!/usr/bin/env bash
#
# Update the game on the Pi to the image GitHub Actions last built.
#
#   cd /home/ycmah/frontier-capital/deploy/pi && ./update.sh
#
# Pulls ghcr.io/mahyancheng/lm/frontier-capital:pi, restarts the one service,
# waits for /api/llm/health, and rolls back to the previous image if health
# does not come up. Keeps the previous image tagged `frontier-capital:rollback`.
# Safe to run from any SSH app on a phone over the tailnet, or from a systemd
# timer (see README). Needs nothing from a Mac.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="ghcr.io/mahyancheng/lm/frontier-capital:pi"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.ghcr.yml)
PORT="${PORT:-8110}"

current="$(docker inspect --format '{{.Image}}' frontier-capital 2>/dev/null || true)"
if [[ -n "$current" ]]; then
  docker tag "$current" frontier-capital:rollback
fi

echo "==> Pulling ${IMAGE}"
docker pull "${IMAGE}"
latest="$(docker inspect --format '{{.Id}}' "${IMAGE}")"
if [[ "$latest" == "$current" ]]; then
  echo "Already on the latest image."
  exit 0
fi

echo "==> Restarting"
"${COMPOSE[@]}" up -d

echo "==> Waiting for health"
for _ in $(seq 1 40); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/llm/health" >/dev/null 2>&1; then
    echo "Live: $(git -C ../.. rev-parse --short HEAD 2>/dev/null || echo "${IMAGE}")"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done

echo "!! Health did not come up — rolling back" >&2
if docker image inspect frontier-capital:rollback >/dev/null 2>&1; then
  docker tag frontier-capital:rollback "${IMAGE}"
  "${COMPOSE[@]}" up -d
fi
exit 1
