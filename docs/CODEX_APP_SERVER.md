# Codex app-server backend

Frontier Capital uses the Codex CLI app-server over its default stdio JSONL transport. It is a local, long-lived backend integration, not a Responses API client and it does not accept browser-pasted ChatGPT credentials.

## In-app managed login

After the app starts, open **Settings → Connect ChatGPT**. The game starts the
supported device-code ceremony inside its managed app-server integration and
opens the browser verification page. Do not run a CLI login or copy credentials
into environment variables, files, or the game settings UI. The app-server
stores managed login state in `CODEX_HOME` and refreshes it there when needed.

`CODEX_HOME` is a clean, integration-specific directory, not the operator's
usual Codex profile. Start it without inherited configuration, extensions,
MCP servers, custom skills, or project instructions. Codex may generate its
own bundled system skills under `.system`; leave those CLI-owned files intact.
The app-server runs only against its dedicated empty workspace. The game health
probe and the running service use the same `CODEX_HOME`.

For Docker on the Pi, `CODEX_HOME=/home/node/.codex` is the persistent
`codex-home` volume. The image seeds that directory for the unprivileged `node`
user, and the app creates any missing workspace directory when Connect is used.

The image pins `@openai/codex@0.151.0-alpha.2`; upgrade only after checking the published package for `linux-arm64`, reviewing its app-server schema, and validating an in-app login and game turn. `codex --version` is an optional deployment diagnostic. The image never attempts login during its build.

## State and migration

Game state and saves are unchanged. Codex mappings are stored in `codex-thread-map.json`, with every opaque game conversation key prefixed by `codex:`. The old `claude-session-map.json` stays in place and is never read by Codex. Claude session ids cannot be resumed as Codex thread ids.

Existing `LLM_TRANSPORT=claude-session` deployments are normalized to Codex app-server at startup. `CLAUDE_CODE_OAUTH_TOKEN`, `LLM_MODEL`, and `ANTHROPIC_*` are legacy settings and do not authenticate or choose a Codex model. Set `CODEX_MODEL` only when the account has an approved model name; otherwise omit it and let the logged-in CLI select one.

The game derives each mapping from role, game, principal, and conversation identity, so each game and principal stays isolated. The company strategist and CEO continue to use their shared company dialogue key. Existing app review, queue, validation, and simulation authority remain the decision makers.

## Operational constraints

Codex runs with its restricted workspace policy and has no unrestricted-host or sandbox-bypass configuration. Keep app-server on stdio inside the web process; do not expose its WebSocket listener to NPCs or the network. The dedicated Codex home must be writable for managed auth and thread rollouts, mode `0700`, and must never be mounted over an old Claude profile.

The mapping store serializes file mutations in one process. Run one web process per volume; a multi-instance deployment needs a shared, transaction-safe map.

Source: [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
