#!/usr/bin/env bash
#
# Frontier Capital — one-command VPS install.
#
# Paste this on a fresh Ubuntu/Debian VPS (root or sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/mahyancheng/lm/claude/opus5-agents-vercel-supabase-kz1ehf/deploy/vps/install.sh | sudo bash
#
# What it does: installs Node 22 + pnpm + git, clones this repo, builds the
# game, and runs it as a systemd service on port 80 — always on, no idle
# spin-down, so the in-app "Connect with Claude" subscription session persists
# until the process restarts. Re-running the script updates to the latest
# commit on the branch. It prints the game URL and the AI unlock secret at the
# end; the secret is kept in /etc/frontier-capital.env.
set -euo pipefail

REPO_URL="https://github.com/mahyancheng/lm"
BRANCH="claude/opus5-agents-vercel-supabase-kz1ehf"
APP_DIR="/opt/frontier-capital"
ENV_FILE="/etc/frontier-capital.env"
SERVICE="frontier-capital"
PORT="${PORT:-80}"

if [[ $(id -u) -ne 0 ]]; then
  echo "Run as root (or with sudo)." >&2
  exit 1
fi

echo "==> Installing prerequisites (git, curl, Node 22, pnpm)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null

echo "==> Fetching ${REPO_URL} (${BRANCH})"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch origin "${BRANCH}" --depth 1
  git -C "${APP_DIR}" checkout -B "${BRANCH}" "origin/${BRANCH}"
else
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

# Secrets are generated once and kept across updates. LLM_SETUP_SECRET unlocks
# the in-game AI panel; LLM_KEY_SECRET protects stored credentials. Optionally
# add CLAUDE_CODE_OAUTH_TOKEN=... to this file to pre-connect the subscription
# without using the in-app flow.
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "==> Generating ${ENV_FILE}"
  SETUP_SECRET="fc-$(head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
  KEY_SECRET="$(head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n')"
  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
NEXT_PUBLIC_DEMO_MODE=true
LLM_TRANSPORT=claude-session
LLM_MODEL=sonnet
LLM_SETUP_SECRET=${SETUP_SECRET}
LLM_KEY_SECRET=${KEY_SECRET}
LLM_STATE_DIR=/var/lib/frontier-capital
EOF
  chmod 600 "${ENV_FILE}"
fi
# The in-app Claude connection is sealed (AES-256-GCM under LLM_KEY_SECRET)
# into this directory so it survives restarts and updates. Older env files
# get the line appended so an update turns persistence on too.
grep -q '^LLM_STATE_DIR=' "${ENV_FILE}" || echo 'LLM_STATE_DIR=/var/lib/frontier-capital' >> "${ENV_FILE}"
install -d -o www-data -g www-data -m 0700 /var/lib/frontier-capital

echo "==> Installing workspace and building (a few minutes on a small VPS)"
cd "${APP_DIR}"
corepack prepare --activate >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm --filter @frontier/web build

echo "==> Installing systemd service ${SERVICE} on port ${PORT}"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Frontier Capital game server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
# Port 80 needs the capability; a plain user plus this beats running as root.
ExecStart=$(command -v pnpm) --filter @frontier/web exec next start -H 0.0.0.0 -p ${PORT}
Restart=always
RestartSec=3
User=www-data
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
chown -R www-data:www-data "${APP_DIR}"
systemctl daemon-reload
systemctl enable --now "${SERVICE}"
systemctl restart "${SERVICE}"

IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "======================================================================"
echo " Frontier Capital is up:  http://${IP}$( [[ "${PORT}" != "80" ]] && echo ":${PORT}" )"
echo " AI unlock secret:        $(grep '^LLM_SETUP_SECRET=' "${ENV_FILE}" | cut -d= -f2)"
echo " (In the game: Settings -> AI -> enter the secret -> Connect with Claude)"
echo " Update later:            re-run this same script"
echo " Logs:                    journalctl -u ${SERVICE} -f"
echo "======================================================================"
