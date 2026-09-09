# Company chat replies and recoverable failures

Company chat uses a canonical session, a persistent NPC conversation, and explicit human review of proposed actions. A successful HTTP response carries `turnId`, `output`, `fallbackUsed`, `receipts`, and `revision`. The general role wrapper returns only output/fallback and must not serialize this route: losing the canonical revision breaks the browser's view of saved conversation progress.

The message may contain up to 600 characters. The topic summary is bounded to 200 characters, while conversation history preserves the whole message. Failed requests display a recoverable error and preserve the user's draft and existing offer. Requests time out after 150 seconds; a timeout instructs the player to refresh and check for a saved reply before retrying.

Regression checks cover the real route response envelope, full-length messages, preserved drafts on send failures, and proposal review/queue behavior. A deployment probe on a disposable save copy must receive a real ChatGPT reply with canonical metadata, then replay the same turn ID and verify the reply and revision are unchanged. It must not advance or change the player's original game.

Releases build from the repository on GitHub-hosted `ubuntu-24.04-arm`, publish `linux/arm64` images to GHCR, and stamp the Git commit into `/api/version`. The Pi can pull `ghcr.io/mahyancheng/lm/frontier-capital:pi-<short-sha>` directly. Runtime credentials and game saves stay in their persistent volumes and are not build artifacts.
