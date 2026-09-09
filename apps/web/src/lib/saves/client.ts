/**
 * The browser's whole knowledge of `/api/saves`: five calls, each bounded.
 *
 * **Client-safe.** It imports `./shared` (pure types and the conflict rule) and
 * nothing else — never `./store`, which opens `node:fs`.
 *
 * Two rules shape every function here:
 *
 * 1. **Nothing throws.** A request that times out, is refused, or comes back as
 *    something other than the shape it promised resolves to
 *    `{ ok: false, reason: 'unreachable' | … }`. The tailnet drops out when a
 *    phone walks out of range, and a save layer that threw on that would take
 *    the game with it. Server saves are an addition; their absence is the
 *    state the game already knows how to be in.
 * 2. **Nothing is trusted.** The responses are parsed defensively — an envelope
 *    is only an envelope if it carries a numeric `revision` and a `file` — so a
 *    proxy's error page cannot become a save.
 *
 * Every call takes a timeout because the alternative on a flaky tailnet is a
 * pending promise that never settles and a sync layer that never retries.
 */

import {
  type ProfileListing,
  type SaveEnvelope,
  type SaveSlot,
  type SaveSummaryEnvelope,
  isProfileSlug,
  isSaveSlot,
} from './shared';

/* -------------------------------------------------------------------------- */
/*  Results                                                                    */
/* -------------------------------------------------------------------------- */

/** Why a call did not produce what was asked for. */
export type SavesFailure =
  /** The request never completed: offline, timed out, DNS, a reset tailnet. */
  | 'unreachable'
  /** The host answered, but does not do server saves (`SAVE_DIR` unset or unusable). */
  | 'saves_disabled'
  /** The slot is empty. Not an error at the call site that expects it. */
  | 'no_save'
  /** The server holds a different version than the one this write named. */
  | 'stale_revision'
  /** An unconditional write the conflict rule refused: what we sent is not newer. */
  | 'older_save'
  | 'rate_limited'
  | 'save_too_large'
  | 'profile_limit'
  | 'forbidden'
  | 'invalid_request'
  | 'server_error'
  /** A 2xx whose body was not the shape the route promises. */
  | 'malformed';

export type SavesResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: SavesFailure;
      /** HTTP status, or null when the request never reached a server. */
      readonly status: number | null;
      /** The server's summary of what it holds, on a 409. Never carries a file. */
      readonly current?: SaveSummaryEnvelope;
      /** Seconds the server asked us to wait, on a 429. */
      readonly retryAfterSeconds?: number;
    };

/** Did this failure happen because the host could not be reached at all? */
export function isOffline<T>(result: SavesResult<T>): boolean {
  return !result.ok && result.reason === 'unreachable';
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface SavesClientOptions {
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request ceiling. A read is cheap; a 4 MB PUT over Wi-Fi is not. */
  readonly readTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  /** Prefixed to every path. Empty in the browser, where the app is the origin. */
  readonly baseUrl?: string;
}

const DEFAULT_READ_TIMEOUT_MS = 6_000;
const DEFAULT_WRITE_TIMEOUT_MS = 20_000;

export interface SavesClient {
  /** Every profile this host holds. `enabled: false` is the signal to stay on `localStorage`. */
  profiles(): Promise<SavesResult<{ enabled: boolean; profiles: ProfileListing[] }>>;
  /** One profile's four slot summaries. An unknown profile answers four empty rows. */
  listSlots(profile: string): Promise<SavesResult<{ exists: boolean; displayName: string; slots: SaveSummaryEnvelope[] }>>;
  /** One stored save, file included. */
  get(profile: string, slot: SaveSlot): Promise<SavesResult<SaveEnvelope>>;
  put(profile: string, slot: SaveSlot, file: unknown, options?: PutOptions): Promise<SavesResult<SaveEnvelope>>;
  remove(profile: string, slot: SaveSlot): Promise<SavesResult<{ deleted: boolean }>>;
}

export interface PutOptions {
  /**
   * The revision this write applies to. Sent on every ordinary push: it is what
   * turns "store this" into "store this over the version I have seen", so two
   * devices conflict loudly instead of overwriting each other quietly.
   */
  readonly ifRevision?: number;
  readonly displayName?: string;
}

/* -------------------------------------------------------------------------- */
/*  Parsing what came back                                                     */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A slot summary, or null when the object is not one.
 *
 * `revision` is the required field because it is the one the sync layer makes
 * decisions with; an object without it cannot be conditioned on and so is not a
 * summary this client will hand onwards.
 */
function parseSummary(value: unknown, fallbackProfile: string): SaveSummaryEnvelope | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const revision = int(raw.revision);
  if (revision === null) return null;
  const slot = raw.slot;
  if (!isSaveSlot(slot)) return null;
  return {
    profile: str(raw.profile) ?? fallbackProfile,
    slot,
    revision,
    updatedAtIso: str(raw.updatedAtIso) ?? '',
    savedQuarter: int(raw.savedQuarter),
    savedAtIso: str(raw.savedAtIso),
    worldVersion: (raw.worldVersion ?? null) as SaveSummaryEnvelope['worldVersion'],
    companyName: str(raw.companyName),
    founderName: str(raw.founderName),
    byteLength: int(raw.byteLength) ?? 0,
  };
}

function parseEnvelope(value: unknown, fallbackProfile: string): SaveEnvelope | null {
  const raw = asRecord(value);
  if (raw === null || raw.file === undefined) return null;
  const summary = parseSummary(raw, fallbackProfile);
  return summary === null ? null : { ...summary, file: raw.file };
}

function parseListing(value: unknown): ProfileListing | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const profile = str(raw.profile);
  if (profile === null || !isProfileSlug(profile)) return null;
  const slots = Array.isArray(raw.slots)
    ? raw.slots.flatMap((entry) => {
        const summary = parseSummary(entry, profile);
        return summary === null ? [] : [summary];
      })
    : [];
  return {
    profile,
    displayName: str(raw.displayName) ?? profile,
    createdAtIso: str(raw.createdAtIso) ?? '',
    updatedAtIso: str(raw.updatedAtIso) ?? '',
    slots,
  };
}

/** The named reason a non-2xx carries, mapped onto this client's vocabulary. */
function failureOf(status: number, body: Record<string, unknown> | null): SavesFailure {
  const reason = body === null ? null : str(body.reason);
  switch (reason) {
    case 'saves_disabled':
    case 'no_save':
    case 'stale_revision':
    case 'older_save':
    case 'rate_limited':
    case 'save_too_large':
    case 'profile_limit':
      return reason;
    default:
      break;
  }
  if (status === 403) return 'forbidden';
  if (status === 404) return 'saves_disabled';
  if (status === 409) return 'stale_revision';
  if (status === 413) return 'save_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                 */
/* -------------------------------------------------------------------------- */

export function createSavesClient(options: SavesClientOptions = {}): SavesClient {
  const base = options.baseUrl ?? '';
  const readTimeout = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const writeTimeout = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;

  /**
   * One request, bounded, never throwing.
   *
   * The timeout is an `AbortController` rather than a `Promise.race`, so a
   * abandoned request is actually cancelled instead of merely ignored — a phone
   * that has left the tailnet must not accumulate four stalled 4 MB uploads.
   */
  async function send(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ readonly status: number; readonly body: Record<string, unknown> | null } | null> {
    const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (doFetch === null) return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer =
      controller === null ? null : setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await doFetch(`${base}${path}`, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        ...(controller === null ? {} : { signal: controller.signal }),
      });
      let body: Record<string, unknown> | null = null;
      try {
        body = asRecord(await response.json());
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function offline<T>(): SavesResult<T> {
    return { ok: false, reason: 'unreachable', status: null };
  }

  function refused<T>(status: number, body: Record<string, unknown> | null, profile: string): SavesResult<T> {
    const reason = failureOf(status, body);
    const current = body === null ? null : parseSummary(body.current, profile);
    const retry = body === null ? null : int(body.retryAfterSeconds);
    return {
      ok: false,
      reason,
      status,
      ...(current === null ? {} : { current }),
      ...(retry === null ? {} : { retryAfterSeconds: retry }),
    };
  }

  return {
    async profiles() {
      const answer = await send('/api/saves/profiles', { method: 'GET' }, readTimeout);
      if (answer === null) return offline();
      if (answer.status !== 200 || answer.body === null) return refused(answer.status, answer.body, '');
      const enabled = answer.body.enabled === true;
      const listings = Array.isArray(answer.body.profiles)
        ? answer.body.profiles.flatMap((entry) => {
            const listing = parseListing(entry);
            return listing === null ? [] : [listing];
          })
        : [];
      return { ok: true, value: { enabled, profiles: listings } };
    },

    async listSlots(profile: string) {
      if (!isProfileSlug(profile)) return { ok: false, reason: 'invalid_request', status: null };
      const answer = await send(`/api/saves/${profile}`, { method: 'GET' }, readTimeout);
      if (answer === null) return offline();
      if (answer.status !== 200 || answer.body === null) return refused(answer.status, answer.body, profile);
      const listing = parseListing({ ...answer.body, profile });
      if (listing === null) return { ok: false, reason: 'malformed', status: answer.status };
      return {
        ok: true,
        value: { exists: answer.body.exists === true, displayName: listing.displayName, slots: listing.slots },
      };
    },

    async get(profile: string, slot: SaveSlot) {
      if (!isProfileSlug(profile) || !isSaveSlot(slot)) return { ok: false, reason: 'invalid_request', status: null };
      const answer = await send(`/api/saves/${profile}/${slot}`, { method: 'GET' }, readTimeout);
      if (answer === null) return offline();
      if (answer.status !== 200 || answer.body === null) return refused(answer.status, answer.body, profile);
      const envelope = parseEnvelope(answer.body.envelope, profile);
      if (envelope === null) return { ok: false, reason: 'malformed', status: answer.status };
      return { ok: true, value: envelope };
    },

    async put(profile: string, slot: SaveSlot, file: unknown, put: PutOptions = {}) {
      if (!isProfileSlug(profile) || !isSaveSlot(slot)) return { ok: false, reason: 'invalid_request', status: null };
      let body: string;
      try {
        body = JSON.stringify({
          file,
          ...(put.ifRevision === undefined ? {} : { ifRevision: put.ifRevision }),
          ...(put.displayName === undefined ? {} : { displayName: put.displayName }),
        });
      } catch {
        return { ok: false, reason: 'invalid_request', status: null };
      }
      const answer = await send(
        `/api/saves/${profile}/${slot}`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body },
        writeTimeout,
      );
      if (answer === null) return offline();
      if (answer.status !== 200 || answer.body === null) return refused(answer.status, answer.body, profile);
      const envelope = parseEnvelope(answer.body.envelope, profile);
      if (envelope === null) return { ok: false, reason: 'malformed', status: answer.status };
      return { ok: true, value: envelope };
    },

    async remove(profile: string, slot: SaveSlot) {
      if (!isProfileSlug(profile) || !isSaveSlot(slot)) return { ok: false, reason: 'invalid_request', status: null };
      const answer = await send(`/api/saves/${profile}/${slot}`, { method: 'DELETE' }, writeTimeout);
      if (answer === null) return offline();
      if (answer.status !== 200 || answer.body === null) return refused(answer.status, answer.body, profile);
      return { ok: true, value: { deleted: answer.body.deleted === true } };
    },
  };
}
