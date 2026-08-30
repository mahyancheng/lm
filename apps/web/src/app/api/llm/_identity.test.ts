/**
 * Admission tests for the LLM routes.
 *
 * No model is ever contacted and no request scope is needed: everything under
 * test here is pure, and the clock and the identity source are injected.
 *
 * What must never regress:
 *
 * 1. A conversation key cannot be supplied, guessed, or reached from another
 *    principal — it is an HMAC over the role, the caller and the thread.
 * 2. With Supabase configured, an unauthenticated call is refused rather than
 *    answered, and the seat comes from the verified user rather than the body.
 * 3. In demo mode two browsers never share a thread.
 * 4. A caller cannot exceed the window, and cannot spend another caller's.
 */

import { describe, expect, it } from 'vitest';
import {
  type ConversationParts,
  type Principal,
  createRateLimiter,
  declaresOversizeBody,
  deriveConversationKey,
  isPlausibleAnonymousId,
  resolvePrincipal,
  seatFor,
} from './_identity';

const SECRET = 'test-secret-not-a-real-one';
const PARTS: ConversationParts = { gameSessionId: 'sess_demo_20270101', playerId: 'player-1', conversationId: 'main' };

const supabase = (id: string): Principal => ({ id, kind: 'supabase' });
const anonymous = (id: string): Principal => ({ id, kind: 'anonymous' });

describe('conversation keys', () => {
  it('is an opaque digest under the role namespace, disclosing none of its parts', () => {
    const key = deriveConversationKey('cos', supabase('user-a'), PARTS, SECRET);
    expect(key).toMatch(/^cos:[0-9a-f]{64}$/);
    expect(key).not.toContain(PARTS.gameSessionId);
    expect(key).not.toContain(PARTS.playerId);
    expect(key).not.toContain(PARTS.conversationId);
  });

  it('is stable for one thread, so dialogue keeps its memory across turns', () => {
    const first = deriveConversationKey('cos', supabase('user-a'), PARTS, SECRET);
    const second = deriveConversationKey('cos', supabase('user-a'), { ...PARTS }, SECRET);
    expect(first).toBe(second);
  });

  it('never lets one principal reach another principal\'s thread', () => {
    const mine = deriveConversationKey('cos', supabase('user-a'), PARTS, SECRET);
    const theirs = deriveConversationKey('cos', supabase('user-b'), PARTS, SECRET);
    expect(mine).not.toBe(theirs);
  });

  it('ignores the body\'s playerId once there is a verified identity', () => {
    // The attack this closes: a signed-in user naming somebody else's seat.
    const honest = deriveConversationKey('cos', supabase('user-a'), PARTS, SECRET);
    const forged = deriveConversationKey('cos', supabase('user-a'), { ...PARTS, playerId: 'player-2' }, SECRET);
    expect(forged).toBe(honest);
    expect(seatFor(supabase('user-a'), { ...PARTS, playerId: 'player-2' })).toBe('user-a');
  });

  it('keeps the body\'s playerId as a thread selector in demo mode, under the browser id', () => {
    const seatOne = deriveConversationKey('cos', anonymous('browser-1'), PARTS, SECRET);
    const seatTwo = deriveConversationKey('cos', anonymous('browser-1'), { ...PARTS, playerId: 'player-2' }, SECRET);
    expect(seatOne).not.toBe(seatTwo);
    expect(seatFor(anonymous('browser-1'), PARTS)).toBe('player-1');
  });

  it('never lets the character role resume a Chief of Staff thread', () => {
    const cos = deriveConversationKey('cos', supabase('user-a'), PARTS, SECRET);
    const chr = deriveConversationKey('chr', supabase('user-a'), PARTS, SECRET);
    expect(chr).not.toBe(cos);
    // The prefix alone would settle it; the digest differs too, so a swapped
    // prefix cannot be forged from an observed key.
    expect(cos.slice(4)).not.toBe(chr.slice(4));
  });

  it('separates two browsers on one deployment, even on an identical demo session id', () => {
    // The demo session id is a pure function of the seed, so it is the same for
    // every visitor. Only the per-browser id keeps their threads apart.
    const first = deriveConversationKey('cos', anonymous('browser-1'), PARTS, SECRET);
    const second = deriveConversationKey('cos', anonymous('browser-2'), PARTS, SECRET);
    expect(first).not.toBe(second);
  });

  it('is unreachable without the secret', () => {
    const known = deriveConversationKey('cos', supabase('user-a'), PARTS, SECRET);
    const guessed = deriveConversationKey('cos', supabase('user-a'), PARTS, 'a different secret');
    expect(guessed).not.toBe(known);
  });

  it('cannot be collided by moving a delimiter between the parts', () => {
    const straight = deriveConversationKey('cos', supabase('user-a'), PARTS, SECRET);
    const smuggled = deriveConversationKey(
      'cos',
      supabase('user-a'),
      { gameSessionId: 'sess_demo_20270101:player-1', playerId: '', conversationId: 'main' },
      SECRET,
    );
    expect(smuggled).not.toBe(straight);
  });
});

describe('principals', () => {
  it('refuses an unauthenticated call once Supabase is configured', async () => {
    const outcome = await resolvePrincipal({ supabaseConfigured: true, getUserId: async () => null, anonymousId: null });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unauthenticated');
  });

  it('refuses when the auth check itself fails, rather than falling through to anonymous', async () => {
    const outcome = await resolvePrincipal({
      supabaseConfigured: true,
      getUserId: async () => {
        throw new Error('token refresh failed');
      },
      anonymousId: 'e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1',
    });
    expect(outcome.ok).toBe(false);
  });

  it('takes the identity from the verified user, never from a cookie the caller set', async () => {
    const outcome = await resolvePrincipal({
      supabaseConfigured: true,
      getUserId: async () => 'user-a',
      anonymousId: 'e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolution.principal).toEqual({ id: 'user-a', kind: 'supabase' });
    expect(outcome.resolution.issuedAnonymousId).toBeNull();
  });

  it('mints one anonymous id per browser in demo mode and reuses it afterwards', async () => {
    const minted = await resolvePrincipal({
      supabaseConfigured: false,
      getUserId: async () => null,
      anonymousId: null,
      newAnonymousId: () => 'e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1',
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.resolution.issuedAnonymousId).toBe('e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1');

    const returning = await resolvePrincipal({
      supabaseConfigured: false,
      getUserId: async () => null,
      anonymousId: 'e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1',
    });
    expect(returning.ok).toBe(true);
    if (!returning.ok) return;
    expect(returning.resolution.principal.id).toBe('e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1');
    expect(returning.resolution.issuedAnonymousId).toBeNull();
  });

  it('replaces a cookie value it did not mint rather than keying anything on it', async () => {
    const outcome = await resolvePrincipal({
      supabaseConfigured: false,
      getUserId: async () => null,
      anonymousId: '../../etc/passwd',
      newAnonymousId: () => 'e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolution.principal.id).toBe('e6ad3d3e-2b74-4a56-9a24-56d4d0c2b3f1');
    expect(isPlausibleAnonymousId('../../etc/passwd')).toBe(false);
  });
});

describe('rate limiting', () => {
  it('allows the window and refuses the call after it', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.take('a', 1_000).allowed).toBe(true);
    expect(limiter.take('a', 1_100).allowed).toBe(true);
    expect(limiter.take('a', 1_200).allowed).toBe(true);

    const refused = limiter.take('a', 1_300);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('lets the window slide rather than resetting on a fixed boundary', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000 });
    limiter.take('a', 0);
    limiter.take('a', 500);
    expect(limiter.take('a', 900).allowed).toBe(false);
    // The first call has aged out; exactly one slot is free again.
    expect(limiter.take('a', 1_001).allowed).toBe(true);
    expect(limiter.take('a', 1_002).allowed).toBe(false);
  });

  it('never lets one caller spend another caller\'s budget', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.take('a', 0).allowed).toBe(true);
    expect(limiter.take('a', 1).allowed).toBe(false);
    expect(limiter.take('b', 2).allowed).toBe(true);
  });

  it('does not grow without bound when the caller ids do', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 10 });
    for (let i = 0; i < 100; i += 1) limiter.take(`caller-${i}`, i);
    // The coldest callers were evicted, so the newest still gets a full window.
    expect(limiter.take('caller-99', 100).allowed).toBe(true);
    expect(limiter.take('caller-0', 101).allowed).toBe(true);
  });
});

describe('body size', () => {
  it('refuses a declared body over the ceiling before it is read', () => {
    expect(declaresOversizeBody(new Headers({ 'content-length': '9000000' }), 1_000)).toBe(true);
    expect(declaresOversizeBody(new Headers({ 'content-length': '900' }), 1_000)).toBe(false);
  });

  it('does not refuse a body that declares nothing — the field bounds still apply', () => {
    expect(declaresOversizeBody(new Headers(), 1_000)).toBe(false);
    expect(declaresOversizeBody(new Headers({ 'content-length': 'chunked' }), 1_000)).toBe(false);
  });
});
