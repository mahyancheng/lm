/**
 * The state machine behind the "AI · Claude" section of Settings.
 *
 * Pure, and separated from the drawer for the same reason every other logic
 * module in this app is: the interface is a rendering of a decision, and the
 * decision is what is worth testing. Nothing here fetches, and nothing here
 * touches the DOM.
 *
 * Seven answers, and the ones after the third are the ones that are easy to get
 * wrong:
 *
 * | Phase | When | What the player sees |
 * |---|---|---|
 * | `loading` | the status call is in flight | nothing but the section heading |
 * | `configured` | a credential is in force | the masked row, Test, Replace and Disconnect |
 * | `unconfigured` | a server answered, no credential | the guide, Connect-with-Claude, and the paste field |
 * | `no-server` | nothing answered at all | one quiet line, and no form |
 * | `restricted` | a server answered and this caller may not write | one line saying who may |
 * | `disabled` | this deployment takes no pasted credential at all | one line saying what to do instead |
 * | `locked` | the deployment offers the secret gate and this caller has not unlocked it | the "unlock setup" field |
 *
 * `no-server` exists because this app is also shipped as a static artifact with
 * no backend behind it. There, `/api/llm/token` is not a failing endpoint — it
 * is not an endpoint. Rendering a paste field into that build would be a
 * promise the page cannot keep, so it says what is true instead: the demo runs
 * on the deterministic rules, and a live model needs a server.
 *
 * `disabled` exists because a dev server binds every interface. Reached over
 * the network rather than from the machine it runs on, the credential form is
 * not a convenience — it is a way for a stranger to spend the owner's Claude
 * subscription — so the server refuses and this says so plainly, with the two
 * things that do work.
 *
 * `locked` is the public-deployment answer to `disabled`: the operator set
 * `LLM_SETUP_SECRET`, so setup *is* possible over the network — for whoever can
 * present that secret. The panel leads with a one-time unlock field; once the
 * secret is accepted the server discloses the descriptor and the phase becomes
 * `configured` or `unconfigured` like any other.
 *
 * The status the server sends comes in two shapes: the full descriptor for a
 * caller who could write the credential, and four public facts for everyone
 * else. `descriptor` is the narrowed half, and it is null exactly when this
 * caller was not told what the credential is.
 */

// Relative rather than `@/`: this module is imported directly by its test, and
// the path alias is a tsconfig/bundler concern the test runner does not share.
import {
  type CredentialSource,
  type OAuthFinishFailure,
  type TokenFetch,
  type TokenStatus,
  type TokenStatusFull,
  type TokenTestResult,
  type LlmTransportKind,
  isFullStatus,
} from '../../lib/llm/token';

export type TokenPanelPhase = 'loading' | 'configured' | 'unconfigured' | 'no-server' | 'restricted' | 'disabled' | 'locked';

export interface TokenPanelState {
  readonly phase: TokenPanelPhase;
  /** The quiet explanatory line for the phases that have no form. Empty otherwise. */
  readonly message: string;
  /** True when it is worth showing controls that write. The server still decides. */
  readonly canWrite: boolean;
  readonly status: TokenStatus | null;
  /** The descriptor half of the status, or null when this caller was not shown it. */
  readonly descriptor: TokenStatusFull | null;
}

/** The one line the static artifact build shows in place of the whole section. */
export const NO_SERVER_LINE = 'Needs a server deployment (pnpm dev) — the demo runs offline rules.';

const RESTRICTED_LINE = 'Only an administrator of this deployment can change the Claude credential.';

/** The two things that do work when the in-app path is closed. Both are actionable as written. */
export const DISABLED_LINE =
  'Token setup is disabled on network deployments — set CLAUDE_CODE_OAUTH_TOKEN in the environment, or run with LLM_TOKEN_SETUP=local.';

/** The lead line above the unlock field: this deployment takes a setup secret. */
export const LOCKED_LINE = 'This deployment is protected by a setup secret. Enter it to set up AI for this game.';

const BUSY_LINE = 'Too many checks in the last minute. Try again shortly.';

/**
 * What to render, from what the status call came back with.
 *
 * `null` means the call is still in flight — the caller passes the fetch result
 * it holds, and holds `null` until it has one.
 *
 * The order of the tests is the order of the questions: is there a server, did
 * it refuse, does it take a pasted credential at all, may *this* caller write
 * one, and only then — is one in force?
 */
export function tokenPanelState(fetched: TokenFetch<TokenStatus> | null): TokenPanelState {
  if (fetched === null) return { phase: 'loading', message: '', canWrite: false, status: null, descriptor: null };

  if (fetched.kind === 'unreachable') {
    return { phase: 'no-server', message: NO_SERVER_LINE, canWrite: false, status: null, descriptor: null };
  }

  if (fetched.kind === 'refused') {
    return {
      phase: 'restricted',
      message: fetched.status === 429 ? BUSY_LINE : RESTRICTED_LINE,
      canWrite: false,
      status: null,
      descriptor: null,
    };
  }

  const status = fetched.value;
  const descriptor = isFullStatus(status) ? status : null;

  // Still worth rendering the headline: whether roles reach a model is a
  // public fact, and it is the fact the player came here to check.
  if (status.authGate === 'disabled') {
    return { phase: 'disabled', message: DISABLED_LINE, canWrite: false, status, descriptor };
  }

  // The secret gate before the generic withheld-descriptor refusal: on this
  // deployment a withheld descriptor is not "you may never write" — it is "you
  // have not unlocked yet". Lead with the unlock field rather than a dead end.
  // Once the secret is accepted the descriptor is disclosed and this falls
  // through to the live check below.
  if (status.authGate === 'secret' && descriptor === null) {
    return { phase: 'locked', message: LOCKED_LINE, canWrite: false, status, descriptor: null };
  }

  // The server tells a caller what the credential is on exactly the authority
  // that would let them change it, so a withheld descriptor *is* the refusal.
  if (descriptor === null) {
    return { phase: 'restricted', message: RESTRICTED_LINE, canWrite: false, status, descriptor: null };
  }

  // `available` without `configured` is a real state: a machine already logged
  // into Claude Code has no credential in this process but every role works.
  const live = status.configured || status.available;
  return { phase: live ? 'configured' : 'unconfigured', message: '', canWrite: true, status, descriptor };
}

/* -------------------------------------------------------------------------- */
/*  Pasting, in the two phases that can accept a credential                    */
/* -------------------------------------------------------------------------- */

/**
 * Which paste field the section is showing, if any.
 *
 * `guided` leads with the three-step install guide and belongs only to the
 * unconfigured phase — an operator who is already connected does not need to be
 * told to install Claude Code. `replace` is the same field with no preamble,
 * behind a disclosure, and it exists because a credential that has *expired*
 * looks exactly like a working one from the server's side: it can report what
 * it holds, not whether Anthropic still honours it. Without this, a stale
 * environment token showed "Live", Disconnect was rendered only for a runtime
 * credential, and the panel was a dead end escapable only by editing a dotfile
 * — which is the thing this whole feature exists to avoid.
 */
export type PasteMode = 'none' | 'guided' | 'replace';

export function pasteMode(state: TokenPanelState, replacing: boolean): PasteMode {
  if (state.phase === 'unconfigured') return 'guided';
  if (state.phase === 'configured' && replacing && state.canWrite) return 'replace';
  return 'none';
}

/**
 * The field's own label. It names both credentials the field accepts, so the
 * two paths are legible without reading the help text: an `sk-ant-api…` key is
 * live AI that works on this hosted game, and a subscription token is the one
 * that runs when the game is self-hosted.
 */
export function pasteFieldLabel(mode: PasteMode): string {
  return mode === 'replace' ? 'Paste a replacement token or API key' : 'Paste a token or API key';
}

/* -------------------------------------------------------------------------- */
/*  Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** How the transport is named to a player, who has never read `LLM_TRANSPORT`. */
export function transportLabel(kind: LlmTransportKind): string {
  if (kind === 'api') return 'Anthropic API';
  if (kind === 'none') return 'No transport';
  return 'Claude Code session';
}

/** Where the credential came from, as a chip. Null when there is nothing to attribute. */
export function sourceChip(source: CredentialSource): string | null {
  if (source === 'runtime') return 'set in app';
  if (source === 'env') return 'from env';
  return null;
}

/**
 * The masked credential row.
 *
 * Deliberately never falls back to printing anything but the mask: when there
 * is no mask there is no credential in this process, and saying so is more
 * useful than an empty string.
 */
export function credentialLine(status: TokenStatusFull): string {
  if (status.masked === null) {
    return status.available
      ? 'No token in this process — using the Claude Code login on this machine.'
      : 'No credential configured.';
  }
  const noun = status.kind === 'api_key' ? 'Anthropic API key' : 'Claude subscription token';
  return `${noun} ${status.masked}`;
}

/**
 * A `claude-session` credential is set, but this host is serverless and cannot
 * spawn the subprocess it needs.
 *
 * This is the case the panel must never gloss as "Live": the credential is real
 * and would work when self-hosted, but on this host it does not, so `available`
 * is false and the honest headline is "Subscription connected", not "Offline"
 * (which would imply nothing is set) and never a green "Live".
 */
export function isServerlessClaudeSession(status: TokenStatus): boolean {
  return status.transportKind === 'claude-session' && status.serverless && status.configured;
}

/**
 * A credential pasted or connected in-app lives in one process. On a serverless
 * host every function instance is a separate process, so an in-app credential
 * reaches only the instance that received it — other instances still fall back.
 * The panel says so, and points at the durable fix (an environment variable),
 * rather than showing a flat "Live" that holds only some of the time.
 *
 * Only relevant to a runtime-sourced credential on a serverless host; an
 * environment credential is on every instance already, and a self-hosted single
 * process has no such split.
 */
export function runtimeServerlessCaveat(status: TokenStatus): string | null {
  if (!status.serverless) return null;
  if (!isFullStatus(status) || status.source !== 'runtime') return null;
  return 'Set in-app, this reaches only one server instance — other requests fall back. For steady live AI on a hosted deployment, set the key as an environment variable instead.';
}

/**
 * The live/offline headline, with the model when there is one.
 *
 * The model name is part of the descriptor, so a caller who was not shown the
 * descriptor gets the plain headline. That is the right subtraction: whether
 * the game is live is a public fact; which model the operator is paying for is
 * not necessarily.
 */
export function statusHeadline(status: TokenStatus | null): string {
  if (status === null) return 'Offline';
  if (!status.available) return isServerlessClaudeSession(status) ? 'Subscription connected' : 'Offline';
  const model = isFullStatus(status) ? status.model : null;
  return model === null ? 'Live' : `Live · ${model}`;
}

/** The dot beside the headline: a live model, a caveat to read, or plain idle. */
export type StatusTone = 'live' | 'caution' | 'idle';

export function statusDotTone(status: TokenStatus | null): StatusTone {
  if (status?.available === true) return 'live';
  if (status !== null && isServerlessClaudeSession(status)) return 'caution';
  return 'idle';
}

/**
 * The one honest sentence a serverless deployment owes a subscription
 * credential, or null when there is nothing to caveat.
 *
 * It names both truths at once: the token is connected and will run when the
 * game is self-hosted, and live AI *on this hosted game* wants an API key, which
 * is the transport a serverless function can actually use.
 */
export function serverlessNotice(status: TokenStatus | null): string | null {
  if (status === null || !isServerlessClaudeSession(status)) return null;
  return 'Subscription connected — runs when self-hosted. For live AI on this hosted game, use an API key (sk-ant-api…).';
}

/* -------------------------------------------------------------------------- */
/*  Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/** One sentence for a finished connection test, success or failure. */
export function testResultLine(result: TokenTestResult): string {
  if (result.ok) {
    const base = `Answered in ${result.latencyMs} ms on ${result.modelId}.`;
    return result.note === undefined ? base : `${base} ${result.note}`;
  }
  switch (result.failure) {
    case 'bad_token':
      return 'That credential was refused. Run `claude setup-token` again and paste the new value.';
    case 'rate_limited':
      return 'Rate limited by the model provider. The credential is fine — wait a minute and retry.';
    case 'transport_unavailable':
      return 'No credential is configured on the server, so there is nothing to test.';
    default:
      return `Could not reach the model: ${result.detail}`;
  }
}

/**
 * One sentence for a refused write, in the player's terms rather than the
 * wire's.
 *
 * The reason is consulted before the status because three of the refusals a
 * hardened write gate produces are indistinguishable by status alone, and the
 * instruction each calls for is completely different: reload the page, set an
 * environment variable, or find an administrator.
 */
export function refusalLine(status: number, reason: string): string {
  switch (reason) {
    case 'setup_disabled':
      return DISABLED_LINE;
    case 'setup_secret_required':
      return 'That setup secret was not accepted. Enter the secret this deployment was configured with.';
    case 'cookie_required':
      return 'This browser has no session cookie for this deployment yet. Re-check, then try again.';
    case 'cross_site':
    case 'origin_unverified':
    case 'unsupported_media_type':
      return 'That request did not look like it came from this page. Reload the app and try again.';
    default:
      break;
  }
  if (status === 401) return 'Sign in to change the Claude credential on this deployment.';
  if (status === 403) return RESTRICTED_LINE;
  if (status === 429) return BUSY_LINE;
  return reason;
}

/**
 * One sentence for a failed in-app subscription connect, in the player's terms.
 *
 * Each failure calls for a different next step: approve faster, start over with
 * the newest link, or fall back to pasting a token. The `detail` the server
 * built is already actionable for the flow-level failures, so those pass it
 * through rather than paper over it.
 */
export function oauthFailureLine(failure: OAuthFinishFailure, detail: string): string {
  switch (failure) {
    case 'expired_code':
      return 'That code was not accepted — it may have expired. Start again and approve within a few minutes.';
    case 'bad_state':
    case 'expired_flow':
    case 'invalid_request':
      return detail;
    case 'network':
      return `Could not reach Claude to finish connecting: ${detail}`;
    case 'exchange_failed':
    default:
      return `The connection could not be completed: ${detail}. You can paste a token from \`claude setup-token\` instead.`;
  }
}
