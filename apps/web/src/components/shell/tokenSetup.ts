/**
 * The state machine behind the "AI · Claude" section of Settings.
 *
 * Pure, and separated from the drawer for the same reason every other logic
 * module in this app is: the interface is a rendering of a decision, and the
 * decision is what is worth testing. Nothing here fetches, and nothing here
 * touches the DOM.
 *
 * Four answers, and the fourth is the one that is easy to get wrong:
 *
 * | Phase | When | What the player sees |
 * |---|---|---|
 * | `loading` | the status call is in flight | nothing but the section heading |
 * | `configured` | a credential is in force | the masked row, Test and Disconnect |
 * | `unconfigured` | a server answered, no credential | the three-step guide and the paste field |
 * | `no-server` | nothing answered at all | one quiet line, and no form |
 *
 * `no-server` exists because this app is also shipped as a static artifact with
 * no backend behind it. There, `/api/llm/token` is not a failing endpoint — it
 * is not an endpoint. Rendering a paste field into that build would be a
 * promise the page cannot keep, so it says what is true instead: the demo runs
 * on the deterministic rules, and a live model needs a server.
 */

// Relative rather than `@/`: this module is imported directly by its test, and
// the path alias is a tsconfig/bundler concern the test runner does not share.
import type { CredentialSource, TokenFetch, TokenStatus, TokenTestResult, LlmTransportKind } from '../../lib/llm/token';

export type TokenPanelPhase = 'loading' | 'configured' | 'unconfigured' | 'no-server' | 'restricted';

export interface TokenPanelState {
  readonly phase: TokenPanelPhase;
  /** The quiet explanatory line for the phases that have no form. Empty otherwise. */
  readonly message: string;
  /** True when it is worth showing controls that write. The server still decides. */
  readonly canWrite: boolean;
  readonly status: TokenStatus | null;
}

/** The one line the static artifact build shows in place of the whole section. */
export const NO_SERVER_LINE = 'Needs a server deployment (pnpm dev) — the demo runs offline rules.';

const RESTRICTED_LINE = 'Only an administrator of this deployment can change the Claude credential.';

const BUSY_LINE = 'Too many checks in the last minute. Try again shortly.';

/**
 * What to render, from what the status call came back with.
 *
 * `null` means the call is still in flight — the caller passes the fetch result
 * it holds, and holds `null` until it has one.
 */
export function tokenPanelState(fetched: TokenFetch<TokenStatus> | null): TokenPanelState {
  if (fetched === null) return { phase: 'loading', message: '', canWrite: false, status: null };

  if (fetched.kind === 'unreachable') {
    return { phase: 'no-server', message: NO_SERVER_LINE, canWrite: false, status: null };
  }

  if (fetched.kind === 'refused') {
    return {
      phase: 'restricted',
      message: fetched.status === 429 ? BUSY_LINE : RESTRICTED_LINE,
      canWrite: false,
      status: null,
    };
  }

  const status = fetched.value;
  // `available` without `configured` is a real state: a machine already logged
  // into Claude Code has no credential in this process but every role works.
  const live = status.configured || status.available;
  return { phase: live ? 'configured' : 'unconfigured', message: '', canWrite: true, status };
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
export function credentialLine(status: TokenStatus): string {
  if (status.masked === null) {
    return status.available
      ? 'No token in this process — using the Claude Code login on this machine.'
      : 'No credential configured.';
  }
  const noun = status.kind === 'api_key' ? 'Anthropic API key' : 'Claude subscription token';
  return `${noun} ${status.masked}`;
}

/** The live/offline headline, with the model when there is one. */
export function statusHeadline(status: TokenStatus | null): string {
  if (status === null || !status.available) return 'Offline';
  return status.model === null ? 'Live' : `Live · ${status.model}`;
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

/** One sentence for a refused write, in the player's terms rather than the wire's. */
export function refusalLine(status: number, reason: string): string {
  if (status === 401) return 'Sign in to change the Claude credential on this deployment.';
  if (status === 403) return RESTRICTED_LINE;
  if (status === 429) return BUSY_LINE;
  return reason;
}
