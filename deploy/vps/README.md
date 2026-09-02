# Running Frontier Capital on your own VPS

A VPS is the best home for the game: always on (no free-tier sleep), so the
in-app **Connect with Claude** subscription session persists, and your players
never wait through a cold start.

## Install (any Ubuntu 22.04+/Debian 12+ VPS, 1 GB RAM is enough)

Open your VPS console (SSH or the provider's web terminal) and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/mahyancheng/lm/claude/opus5-agents-vercel-supabase-kz1ehf/deploy/vps/install.sh | sudo bash
```

That is the whole install. At the end it prints the game's URL (your server's
IP on port 80) and the **AI unlock secret**. In the game: Settings → AI →
enter the secret → Connect with Claude, and live Sonnet runs on your
subscription with no API charges.

## Updating

Re-run the same command. It pulls the latest commit, rebuilds, and restarts
the service without touching your secrets.

## Useful commands

```sh
journalctl -u frontier-capital -f     # live server logs
systemctl restart frontier-capital    # restart
cat /etc/frontier-capital.env         # secrets (root only)
```

## Optional

- **A domain + HTTPS**: point your domain's A record at the VPS, then put
  Caddy in front (`apt install caddy`, a two-line Caddyfile reverse-proxying
  to :80 after moving the game to another port via `PORT=3000` in the env
  file and the service unit).
- **Pre-connected AI**: add `CLAUDE_CODE_OAUTH_TOKEN=...` to
  `/etc/frontier-capital.env` and restart, and the subscription session is
  live from boot without the in-app connect flow.
