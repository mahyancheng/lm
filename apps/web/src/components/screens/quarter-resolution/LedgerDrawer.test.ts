/**
 * The Ledger Drawer's id- and payload-scrubbing.
 *
 * The drawer prints `SimEvent` rows verbatim by design — the only screen in
 * the game that does — but "verbatim" means the committed fields, not the raw
 * engine ids inside them. `actorId`/`targetId` are real ids like
 * `cmp_aletheia`, and a string payload value can carry the same kind of id
 * (an event that names a counterparty inside its payload rather than its
 * actor/target). Both must resolve to plain names exactly the way a
 * resolution line's prose does, via `delintText` — never printed raw.
 *
 * These are unit tests over the two pure functions the drawer renders
 * through (`identityLabel`, `payloadRows`), not a full component render:
 * this repo's component tests probe hook/store state rather than rendered
 * DOM (see `useChiefOfStaff.test.tsx`), and there is no jsdom/happy-dom
 * dependency installed to render `Drawer` for real.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '@frontier/contracts';
import { createWorld2Session } from '@frontier/simulation';
import { identityLabel, payloadRows } from './LedgerDrawer';

const SNAKE_TOKEN_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

function session(): SessionState {
  return createWorld2Session();
}

describe('identityLabel', () => {
  const state = session();

  it('resolves a real company id to its name', () => {
    const company = state.companies[0];
    if (company === undefined) throw new Error('world-2 session has no companies');
    expect(identityLabel(company.id, state)).toBe(company.name);
  });

  it('resolves a real character id to its name', () => {
    const character = state.characters[0];
    if (character === undefined) throw new Error('world-2 session has no characters');
    expect(identityLabel(character.id, state)).toBe(character.name);
  });

  it('renders a null actor/target as an em dash, never as the literal null', () => {
    expect(identityLabel(null, state)).toBe('—');
  });

  it('never lets a raw id-shaped string through unresolved', () => {
    // A row can name an id the session no longer carries (e.g. an
    // acquired-away subsidiary); the backstop still strips the shape.
    expect(identityLabel('cmp_longgoneco', state)).not.toContain('cmp_longgoneco');
  });
});

describe('payloadRows', () => {
  const state = session();

  it('resolves a company id inside a string payload value to its name', () => {
    const company = state.companies[0];
    if (company === undefined) throw new Error('world-2 session has no companies');
    const rows = payloadRows({ counterparty: company.id }, state);
    expect(rows).toEqual([['counterparty', company.name]]);
  });

  it('humanises an unmapped snake_case token inside a string payload value', () => {
    const rows = payloadRows({ reason: 'bubble_concern triggered the sale' }, state);
    const [, value] = rows[0] ?? ['', ''];
    expect(value).not.toMatch(SNAKE_TOKEN_RE);
    expect(value).toContain('Bubble concern');
  });

  it('leaves a non-string value as JSON, untouched by delinting', () => {
    const rows = payloadRows({ amount: 1250, tags: ['seed', 'priority'] }, state);
    expect(rows).toEqual([
      ['amount', '1250'],
      ['tags', JSON.stringify(['seed', 'priority'])],
    ]);
  });

  it('produces no rows for an empty payload', () => {
    expect(payloadRows({}, state)).toEqual([]);
  });
});
