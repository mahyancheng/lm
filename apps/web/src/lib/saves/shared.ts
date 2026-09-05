/**
 * The save-sync vocabulary both sides speak: names, slots, caps, the envelope
 * and the conflict rule.
 *
 * **Pure and environment-free.** No `fs`, no `localStorage`, no clock, no
 * `fetch`. That is the whole reason this file exists: `./store` imports
 * `node:fs` at module scope, so a browser bundle that wanted `isNewer` — and
 * the sync layer needs exactly that, to reconcile a 409 by the same rule the
 * server applied — would drag the filesystem into the client. Splitting the
 * rule out is not a second source of truth; it is the *one* source, imported by
 * the server store and by the browser alike.
 *
 * `./store` re-exports every name here, so nothing that already imported these
 * from the store had to change.
 */

import type { WorldVersion } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Names, slots and caps                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The largest save file the host will store, in bytes of its JSON.
 *
 * A hundred-quarter session with a checkpoint is a few hundred kilobytes, so
 * this is roughly an order of magnitude of headroom — enough that no honest
 * game is ever refused, small enough that a broken client cannot fill the Pi's
 * card one PUT at a time.
 */
export const MAX_SAVE_BYTES = 4 * 1024 * 1024;

/** Profiles one host will hold. A 33rd is refused rather than quietly evicting someone. */
export const MAX_PROFILES = 32;

/** The four slots, in the order a picker shows them. `autosave` is the sync target; 1–3 are the player's. */
export const SAVE_SLOTS = ['autosave', '1', '2', '3'] as const;
export type SaveSlot = (typeof SAVE_SLOTS)[number];

/** Slots per profile, stated as a number because the README quotes it as a cap. */
export const MAX_SLOTS_PER_PROFILE = SAVE_SLOTS.length;

/**
 * A profile slug: lowercase, 2–32 characters, starting alphanumeric.
 *
 * The pattern is also the path safety argument. A slug can contain no `.`, no
 * `/` and no `\`, so `join(root, profile)` cannot escape the root however the
 * value arrived — the validation is the traversal defence, not a separate one.
 */
export const PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Names a profile may not take, because the routes spell them.
 *
 * `/api/saves/profiles` is the listing, and Next matches a static segment
 * before `[profile]`, so a profile called `profiles` would be a profile nobody
 * could ever address. Refusing the name is how that stays impossible rather
 * than becoming a support question.
 */
export const RESERVED_PROFILE_SLUGS: readonly string[] = ['profiles'];

export function isProfileSlug(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_SLUG_PATTERN.test(value) && !RESERVED_PROFILE_SLUGS.includes(value);
}

export function isSaveSlot(value: unknown): value is SaveSlot {
  return typeof value === 'string' && (SAVE_SLOTS as readonly string[]).includes(value);
}

/**
 * The slug for a typed name, or null when nothing usable is left.
 *
 * Lowercased, non-alphanumerics collapsed to single hyphens, trimmed of
 * leading and trailing hyphens, truncated to 32. "YC" becomes `yc`; "Mum's
 * Laptop!!" becomes `mum-s-laptop`. A name that reduces to fewer than two
 * characters has no slug, and the caller asks for another.
 */
export function profileSlug(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return isProfileSlug(slug) ? slug : null;
}

/** What a profile's display name may be, before it is stored beside the slug. */
export const MAX_DISPLAY_NAME = 64;

/** Trim and cap what the player typed, or null when nothing is left of it. */
export function displayNameOf(name: string): string | null {
  const trimmed = name.trim().slice(0, MAX_DISPLAY_NAME).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/* -------------------------------------------------------------------------- */
/*  The envelope                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One stored save: the player's file, plus what the server knows about it.
 *
 * `revision` is assigned by the server and increments by one per accepted
 * write. It is what makes a conditional PUT possible: a client that sends the
 * revision it last saw is telling the server "apply this to the version I
 * know", and a mismatch is a conflict to reconcile rather than a write to lose.
 */
export interface SaveEnvelope {
  readonly profile: string;
  readonly slot: SaveSlot;
  /** Server-assigned; +1 per accepted write. A slot that has never been written is revision 0. */
  readonly revision: number;
  /** The server's clock at the accepted write. Distinct from the client's `savedAtIso`. */
  readonly updatedAtIso: string;
  /** Copied out of the file so a slot row costs no parse. Null when the file states none. */
  readonly savedQuarter: number | null;
  readonly savedAtIso: string | null;
  readonly worldVersion: WorldVersion | null;
  readonly companyName: string | null;
  readonly founderName: string | null;
  /** Bytes of `JSON.stringify(file)`, as measured when it was accepted. */
  readonly byteLength: number;
  /** The save file, verbatim. */
  readonly file: unknown;
}

/** An envelope without the file: what a listing shows, and what a 409 hands back. */
export type SaveSummaryEnvelope = Omit<SaveEnvelope, 'file'>;

export function summaryOf(envelope: SaveEnvelope): SaveSummaryEnvelope {
  const { file: _file, ...summary } = envelope;
  return summary;
}

/** An empty slot, described so a picker can render four rows without special cases. */
export function emptySlot(profile: string, slot: SaveSlot): SaveSummaryEnvelope {
  return {
    profile,
    slot,
    revision: 0,
    updatedAtIso: '',
    savedQuarter: null,
    savedAtIso: null,
    worldVersion: null,
    companyName: null,
    founderName: null,
    byteLength: 0,
  };
}

/** Has this slot ever been written? `revision` is the only fact that answers it. */
export function slotOccupied(summary: SaveSummaryEnvelope | null): boolean {
  return summary !== null && summary.revision > 0;
}

/* -------------------------------------------------------------------------- */
/*  The conflict rule                                                          */
/* -------------------------------------------------------------------------- */

/** The two advisory facts the conflict rule orders saves by. */
export interface SaveOrder {
  readonly savedQuarter: number | null;
  readonly savedAtIso: string | null;
}

function quarterOf(order: SaveOrder): number {
  return typeof order.savedQuarter === 'number' && Number.isFinite(order.savedQuarter) ? order.savedQuarter : -1;
}

function stampOf(order: SaveOrder): number {
  if (order.savedAtIso === null) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(order.savedAtIso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * **A save is never overwritten by an older one.**
 *
 * "Older" is decided by `savedQuarter` first, then `savedAtIso`; ties go to the
 * server copy. Quarter leads because it is the only monotone fact about a
 * session — it counts decisions actually taken — while a timestamp is a clock
 * two devices need not agree on, and a phone whose date is a year out would
 * otherwise win every reconciliation.
 *
 * Strict: `isNewer(a, a)` is false. That is the tie going to the incumbent.
 */
export function isNewer(candidate: SaveOrder, incumbent: SaveOrder): boolean {
  const byQuarter = quarterOf(candidate) - quarterOf(incumbent);
  if (byQuarter !== 0) return byQuarter > 0;
  return stampOf(candidate) > stampOf(incumbent);
}

/* -------------------------------------------------------------------------- */
/*  Profiles                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProfileRecord {
  readonly profile: string;
  /** What the player typed, kept beside the slug so the interface can show it. */
  readonly displayName: string;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface ProfileListing extends ProfileRecord {
  readonly slots: SaveSummaryEnvelope[];
}

/* -------------------------------------------------------------------------- */
/*  Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every refusal a write can carry, and the status the route answers with.
 *
 * Named rather than free text because the client reacts to them: `stale_revision`
 * starts a reconciliation, `older_save` is already-reconciled and needs no
 * retry, `profile_limit` and `save_too_large` are for a person to read.
 */
export type SaveWriteReason =
  | 'invalid_profile'
  | 'invalid_slot'
  | 'invalid_save'
  | 'unsupported_save'
  | 'save_too_large'
  | 'profile_limit'
  | 'stale_revision'
  | 'older_save'
  | 'write_failed';

export type SaveWriteResult =
  | { readonly ok: true; readonly envelope: SaveEnvelope }
  | {
      readonly ok: false;
      readonly status: 400 | 409 | 413 | 500 | 507;
      readonly reason: SaveWriteReason;
      /** The version the server holds, on a conflict. Never carries the file. */
      readonly current?: SaveSummaryEnvelope;
    };
