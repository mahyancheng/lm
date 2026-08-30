/**
 * The state machine behind the "AI · Claude" section of Settings.
 *
 * Pure, and separated from the drawer for the same reason every other logic
 * module in this app is: the interface is a rendering of a decision, and the
 * decision is what is worth testing. Nothing here fetches, and nothing here
 * touches the DOM.
 *
 * Six answers, and the ones after the third are the ones that are easy to get
 * wrong:
 *
 * | Phase | When | What the player sees |
 * |---|---|---|
 * | `loading` | the status call is in flight | nothing but the section heading |
 * | `configured` | a credential is in force | the masked row, Test, Replace and Disconnect |
 * | `unconfigured` | a server answered, no credential | the three-step guide and the paste field |
 * | `no-server` | nothing answered at all | one quiet line, and no form |
 * | `restricted` | a server answered and this caller may not write | one line saying who may |
 * | `disabled` | this deployment takes no pasted credential at all | one line saying what to do instead |
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
 * The status the server sends comes in two shapes: the full descriptor for a
 * caller who could write the credential, and four public facts for everyone
 * else. `descriptor` is the narrowed half, and it is null exactly when this
 * caller was not told what the credential is.
 */

// Relative rather than `@/`: this module is imported directly by its test, and
// the path alias is a tsconfig/bundler concern the test runner does not share.
import {
  type CredentialSource,
  type TokenFetch,
  type TokenStatus,
  type TokenStatusFull,
  type TokenTestResult,
  type LlmTransportKind,
  isFullStatus,
} from '../../lib/llm/token';

export type TokenPanelPhase = 'loading' | 'configured' | 'unconfigured' | 'no-server' | 'restricted' | 'disabled';

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

/** The field's own label, which is the only thing that differs between the two modes. */
export function pasteFieldLabel(mode: PasteMode): string {
  return mode === 'replace' ? 'Paste the replacement token' : 'Paste the token';
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
 * The live/offline headline, with the model when there is one.
 *
 * The model name is part of the descriptor, so a caller who was not shown the
 * descriptor gets the plain headline. That is the right subtraction: whether
 * the game is live is a public fact; which model the operator is paying for is
 * not necessarily.
 */
export function statusHeadline(status: TokenStatus | null): string {
  if (status === null || !status.available) return 'Offline';
  const model = isFullStatus(status) ? status.model : null;
  return model === null ? 'Live' : `Live · ${model}`;
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
