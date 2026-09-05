/**
 * The sector and region vocabulary.
 *
 * These are the labels, marks and tints every screen reaches for once the world
 * has more than one industry in it, so what this file pins is that they are
 * *total* and *honest*:
 *
 * 1. every sector and every region has a mark the app can actually draw —
 *    `SECTOR_META.icon` is a plain string in contracts, and a typo there would
 *    otherwise render an empty square on eight screens;
 * 2. the tints are six different colours, because their whole job is to say
 *    "different from each other";
 * 3. the accessors are total, so a world-version-1 rival that arrives as a
 *    `Partial<Company>` with neither field still renders;
 * 4. `readingTone` points the right way — a cheap talent market is a low index
 *    and a good thing, and colour is what carries that.
 */

import { describe, expect, it } from 'vitest';
import { REGIONS, REGION_INDEX_BASELINE, REGION_META, SECTORS, SECTOR_META } from '@frontier/contracts';
import { ICON_NAMES } from './icons';
import {
  SECTOR_TINT,
  readingTone,
  regionIcon,
  regionLabel,
  regionOf,
  regionReadings,
  regionsPresent,
  sectorIcon,
  sectorLabel,
  sectorOf,
  sectorsPresent,
} from './sector';

describe('sector and region marks', () => {
  it('names an icon the app can draw for every sector and every region', () => {
    for (const sector of SECTORS) {
      expect(ICON_NAMES, `${sector} icon`).toContain(sectorIcon(sector));
      // And the contract's own string is the one being used, not a fallback.
      expect(sectorIcon(sector), `${sector} falls back`).toBe(SECTOR_META[sector].icon);
    }
    for (const region of REGIONS) {
      expect(ICON_NAMES, `${region} icon`).toContain(regionIcon(region));
      expect(regionIcon(region), `${region} falls back`).toBe(REGION_META[region].icon);
    }
  });

  it('gives every sector its own tint', () => {
    const tints = SECTORS.map((sector) => SECTOR_TINT[sector]);
    expect(new Set(tints).size).toBe(SECTORS.length);
  });

  it('labels from the contract table and never from an id', () => {
    for (const sector of SECTORS) expect(sectorLabel(sector)).toBe(SECTOR_META[sector].label);
    for (const region of REGIONS) expect(regionLabel(region)).toBe(REGION_META[region].label);
  });
});

describe('total accessors', () => {
  it('reads a company that carries both fields', () => {
    expect(sectorOf({ sector: 'energy' })).toBe('energy');
    expect(regionOf({ region: 'east_asia' })).toBe('east_asia');
  });

  it('falls back for a world-version-1 record that carries neither', () => {
    expect(sectorOf({})).toBe('ai');
    expect(regionOf({})).toBe('north_america');
  });

  it('ignores a value that is not a sector or a region', () => {
    expect(sectorOf({ sector: 'shipping' as never })).toBe('ai');
    expect(regionOf({ region: 'antarctica' as never })).toBe('north_america');
  });
});

describe('what is present', () => {
  it('returns the distinct sectors in presentation order, not first-seen order', () => {
    const companies = [{ sector: 'consumer' as const }, { sector: 'ai' as const }, { sector: 'consumer' as const }];
    expect(sectorsPresent(companies)).toEqual(['ai', 'consumer']);
  });

  it('reports exactly one sector for a world that has one, which is what turns the grouping off', () => {
    expect(sectorsPresent([{}, {}, {}])).toEqual(['ai']);
    expect(regionsPresent([{}, {}])).toEqual(['north_america']);
  });

  it('is empty for an empty list', () => {
    expect(sectorsPresent([])).toEqual([]);
    expect(regionsPresent([])).toEqual([]);
  });
});

describe('region readings', () => {
  it('reads every index off the contract table', () => {
    const readings = regionReadings('south_asia', 'consumer');
    const values = new Map(readings.map((entry) => [entry.label, entry.value]));
    const meta = REGION_META.south_asia;
    expect(values.get('Talent cost')).toBe(meta.talentCostIndex);
    expect(values.get('Energy cost')).toBe(meta.energyCostIndex);
    expect(values.get('Capital depth')).toBe(meta.capitalDepth);
    expect(values.get('Procurement')).toBe(meta.procurementAppetite);
    expect(values.get('Fit for consumer')).toBe(meta.sectorAffinities.consumer);
  });

  it('colours a cheap cost green and a dear one red', () => {
    expect(readingTone({ label: 'Talent cost', value: 55, invert: true, hint: '' })).toBe('gain');
    expect(readingTone({ label: 'Talent cost', value: 130, invert: true, hint: '' })).toBe('loss');
  });

  it('colours deep capital green and thin capital red', () => {
    expect(readingTone({ label: 'Capital depth', value: 145, invert: false, hint: '' })).toBe('gain');
    expect(readingTone({ label: 'Capital depth', value: 60, invert: false, hint: '' })).toBe('loss');
  });

  it('leaves the baseline uncoloured in both directions', () => {
    expect(readingTone({ label: 'x', value: REGION_INDEX_BASELINE, invert: false, hint: '' })).toBe('neutral');
    expect(readingTone({ label: 'x', value: REGION_INDEX_BASELINE, invert: true, hint: '' })).toBe('neutral');
  });

  it('gives every region a full set of readings for every sector', () => {
    for (const region of REGIONS) {
      for (const sector of SECTORS) {
        const readings = regionReadings(region, sector);
        expect(readings, `${region}/${sector}`).toHaveLength(5);
        for (const reading of readings) expect(Number.isFinite(reading.value)).toBe(true);
      }
    }
  });
});
