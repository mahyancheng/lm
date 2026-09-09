/**
 * The build stamp.
 *
 * What must never regress:
 *
 * 1. **An unstamped build says `dev`, and never blank.** A footer with nothing
 *    in it is indistinguishable from a footer that broke, and the whole point
 *    of the stamp is answering "did the Pi update?" without ambiguity.
 * 2. **The short sha is the seven characters a person compares**, from a full
 *    forty-character sha or from something already short.
 * 3. **The time is UTC and locale-free.** The Pi, the phone reading it and a
 *    founder abroad must all be shown the same string.
 * 4. **Nothing unparseable ever reaches the page** as `Invalid Date`.
 */

import { describe, expect, it } from 'vitest';
import { DEV_BUILD, buildStamp, buildStampLine, formatBuildTime, shortSha } from './version';

const SHA = 'a09e1f0c4b2d8e6f1a3c5b7d9e0f2a4c6b8d0e2f';

describe('shortSha', () => {
  it('takes the seven characters a person compares', () => {
    expect(shortSha(SHA)).toBe('a09e1f0');
  });

  it('lower-cases and trims what CI handed it', () => {
    expect(shortSha('  A09E1F0C4B2D  ')).toBe('a09e1f0');
  });

  it('leaves a sha shorter than seven characters alone', () => {
    expect(shortSha('abc12')).toBe('abc12');
  });

  it('answers dev for every way of being unstamped', () => {
    expect(shortSha(undefined)).toBe(DEV_BUILD);
    expect(shortSha(null)).toBe(DEV_BUILD);
    expect(shortSha('')).toBe(DEV_BUILD);
    expect(shortSha('   ')).toBe(DEV_BUILD);
    expect(shortSha('dev')).toBe(DEV_BUILD);
  });
});

describe('formatBuildTime', () => {
  it('reads an ISO instant as a day, a month and a UTC clock', () => {
    expect(formatBuildTime('2026-09-03T12:17:04Z')).toBe('3 Sep 12:17 UTC');
  });

  it('pads the clock and never the day', () => {
    expect(formatBuildTime('2026-01-09T04:05:00Z')).toBe('9 Jan 04:05 UTC');
  });

  it('converts an offset to UTC rather than printing local time', () => {
    expect(formatBuildTime('2026-09-03T14:17:04+02:00')).toBe('3 Sep 12:17 UTC');
  });

  it('is null when nothing was stamped or the value will not parse', () => {
    expect(formatBuildTime(undefined)).toBeNull();
    expect(formatBuildTime('')).toBeNull();
    expect(formatBuildTime('the third of September')).toBeNull();
  });
});

describe('buildStamp', () => {
  it('carries the full sha, the short sha and the instant', () => {
    expect(buildStamp(SHA, '2026-09-03T12:17:04Z')).toEqual({
      sha: SHA,
      shortSha: 'a09e1f0',
      builtAt: '2026-09-03T12:17:04Z',
    });
  });

  it('falls back to dev with no build time at all', () => {
    expect(buildStamp(undefined, undefined)).toEqual({ sha: DEV_BUILD, shortSha: DEV_BUILD, builtAt: null });
  });

  it('drops a build time that will not parse rather than passing it on', () => {
    expect(buildStamp(SHA, 'not a date').builtAt).toBeNull();
  });
});

describe('buildStampLine', () => {
  it('is the one line every surface prints', () => {
    expect(buildStampLine(buildStamp(SHA, '2026-09-03T12:17:04Z'))).toBe('Build a09e1f0 · 3 Sep 12:17 UTC');
  });

  it('drops the date rather than printing an empty half', () => {
    expect(buildStampLine(buildStamp(SHA, undefined))).toBe('Build a09e1f0');
  });

  it('says dev on a machine that never stamped anything', () => {
    expect(buildStampLine(buildStamp(undefined, undefined))).toBe('Build dev');
  });
});
