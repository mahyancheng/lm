/**
 * Optional bridge to the Pi's canonical command service.
 *
 * The browser supports a local demo only while this service is unavailable.
 * Once registration succeeds, the revision token makes the server the only
 * resolver for that session.
 */
import type { QuarterResolutionOutcome } from '@frontier/contracts';
import type { SaveFile } from './saveFile';

const revisions = new Map<string, number>();

export function canonicalSessionRevision(sessionId: string): number | null {
  return revisions.get(sessionId) ?? null;
}

/** Record a revision returned by another canonical endpoint, such as dialogue. */
export function noteCanonicalSessionRevision(sessionId: string, revision: number | null): void {
  if (revision !== null && Number.isInteger(revision) && revision >= 0 && revision >= (revisions.get(sessionId) ?? -1)) revisions.set(sessionId, revision);
}

/** Register a replay-compatible save with the server; failure means offline. */
export async function syncCanonicalGameSession(file: SaveFile, sessionId: string): Promise<number | null> {
  try {
    const response = await fetch('/api/game/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const body = await response.json() as { ok?: unknown; revision?: unknown; sessionId?: unknown; reason?: unknown };
    const revision = typeof body.revision === 'number' && Number.isInteger(body.revision) ? body.revision : null;
    const returnedSessionId = typeof body.sessionId === 'string' ? body.sessionId : sessionId;
    if (revision !== null && returnedSessionId === sessionId) noteCanonicalSessionRevision(returnedSessionId, revision);
    // Registration is deliberately create-only: on reload, a 409 for this
    // owner is evidence of an existing canonical record, never permission to
    // overwrite it. Its revision is still the token needed for resolve.
    if (response.ok && body.ok === true) return revision;
    return body.reason === 'already_registered' && returnedSessionId === sessionId ? revision : null;
  } catch {
    return null;
  }
}

export interface CanonicalResolveResult {
  readonly status: 'resolved' | 'duplicate' | 'stale' | 'forbidden' | 'missing' | 'unavailable';
  readonly revision: number | null;
  readonly file: SaveFile | null;
  readonly outcome: QuarterResolutionOutcome | null;
}

export async function resolveCanonicalGameQuarter(sessionId: string, requestId: string, playerActions: readonly unknown[], onProgress?: (message: string) => void): Promise<CanonicalResolveResult | null> {
  const revision = canonicalSessionRevision(sessionId);
  if (revision === null) return null;
  const unavailable: CanonicalResolveResult = { status: 'unavailable', revision, file: null, outcome: null };
  const body = JSON.stringify({ sessionId, expectedRevision: revision, requestId, playerActions });
  const statusUrl = `/api/game/resolve?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(requestId)}`;
  let start = true;
  let failures = 0;
  while (failures < 5) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(start ? '/api/game/resolve' : statusUrl, start
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal }
        : { cache: 'no-store', signal: controller.signal });
      clearTimeout(timeout);
      if (!start && response.status === 404) {
        // A restart can lose the observer job, but canonical receipts survive.
        // Re-submit the exact id and actions; the service returns the receipt.
        start = true;
        failures += 1;
      } else if (response.status === 429 || response.status >= 500) {
        failures += 1;
        onProgress?.('Reconnecting to quarter progress. Your moves are preserved.');
      } else {
        const result = await response.json() as Omit<Partial<CanonicalResolveResult>, 'status'> & { status?: string; progress?: string };
        if (result.status === 'pending') {
          failures = 0;
          start = false;
          onProgress?.(result.progress ?? 'Resolving the quarter');
        } else {
          const status = result.status;
          if (status !== 'resolved' && status !== 'duplicate' && status !== 'stale' && status !== 'forbidden' && status !== 'missing') return unavailable;
          const nextRevision = typeof result.revision === 'number' && Number.isInteger(result.revision) ? result.revision : null;
          if (nextRevision !== null) noteCanonicalSessionRevision(sessionId, nextRevision);
          return { status, revision: nextRevision, file: result.file ?? null, outcome: result.outcome ?? null };
        }
      }
    } catch {
      // A lost POST response does not mean the server stopped. Look up the job
      // before re-submitting, rather than reporting a false authority refusal.
      start = false;
      failures += 1;
      onProgress?.('Reconnecting to quarter progress. Your moves are preserved.');
    } finally { clearTimeout(timeout); }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return unavailable;
}

export type CanonicalSessionBinding =
  | { readonly kind: 'bound'; readonly file: SaveFile; readonly revision: number }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'blocked' };

/**
 * Read an existing owner-bound canonical session first.  Only an explicit
 * `authority_disabled` registration response permits the browser demo path;
 * an unavailable, foreign, corrupt, or refused service never authorizes a
 * local fork of a session that may already be canonical.
 */
export async function bindCanonicalGameSession(local: SaveFile): Promise<CanonicalSessionBinding> {
  try {
    const loaded = await fetch(`/api/game/session?sessionId=${encodeURIComponent(local.checkpoint?.state.sessionId ?? '')}`, { cache: 'no-store' });
    if (loaded.ok) {
      const body = await loaded.json() as { ok?: unknown; revision?: unknown; file?: SaveFile };
      if (body.ok !== true || typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.file === undefined) return { kind: 'blocked' };
      const sessionId = body.file.checkpoint?.state.sessionId;
      if (sessionId === undefined || sessionId !== local.checkpoint?.state.sessionId) return { kind: 'blocked' };
      noteCanonicalSessionRevision(sessionId, body.revision);
      return { kind: 'bound', file: body.file, revision: body.revision };
    }
    if (loaded.status !== 404) return { kind: 'blocked' };
    const registered = await fetch('/api/game/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: local }) });
    const body = await registered.json() as { ok?: unknown; revision?: unknown; sessionId?: unknown; reason?: unknown };
    const revision = typeof body.revision === 'number' && Number.isInteger(body.revision) ? body.revision : null;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if ((registered.ok && body.ok === true || body.reason === 'already_registered') && sessionId === local.checkpoint?.state.sessionId && revision !== null) {
      // A concurrent tab may have registered or advanced this session between
      // GET and POST. Re-read before binding: a browser save is never a valid
      // substitute for the authority's current file.
      const reread = await fetch(`/api/game/session?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
      if (!reread.ok) return { kind: 'blocked' };
      const canonical = await reread.json() as { ok?: unknown; revision?: unknown; file?: SaveFile };
      if (canonical.ok !== true || typeof canonical.revision !== 'number' || !Number.isInteger(canonical.revision) || canonical.file === undefined || canonical.file.checkpoint?.state.sessionId !== sessionId) return { kind: 'blocked' };
      noteCanonicalSessionRevision(sessionId, canonical.revision);
      return { kind: 'bound', file: canonical.file, revision: canonical.revision };
    }
    return !registered.ok && body.reason === 'authority_disabled' ? { kind: 'disabled' } : { kind: 'blocked' };
  } catch { return { kind: 'blocked' }; }
}
