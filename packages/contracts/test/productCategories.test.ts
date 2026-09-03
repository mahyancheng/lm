import { describe, expect, it } from 'vitest';
import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORIES_BY_ID,
  ProductCategorySchema,
  SECTORS,
  categoryById,
  defaultCategoryFor,
  productCategoriesFor,
  requiredSupplyGraphIsAcyclic,
  resolveCategory,
  PRODUCT_SEGMENTS,
} from '../src/index';

describe('the product category catalogue', () => {
  it('has at least 36 entries, every one a valid ProductCategory', () => {
    expect(PRODUCT_CATEGORIES.length).toBeGreaterThanOrEqual(36);
    for (const entry of PRODUCT_CATEGORIES) {
      expect(() => ProductCategorySchema.parse(entry)).not.toThrow();
    }
  });

  it('has unique ids', () => {
    const ids = PRODUCT_CATEGORIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries at least five lines per sector', () => {
    for (const sector of SECTORS) {
      expect(productCategoriesFor(sector).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('every sector\'s categories all declare that sector', () => {
    for (const sector of SECTORS) {
      for (const entry of productCategoriesFor(sector)) {
        expect(entry.sector).toBe(sector);
      }
    }
  });

  it('every input names a category that actually exists in the catalogue', () => {
    for (const entry of PRODUCT_CATEGORIES) {
      for (const input of entry.inputs) {
        expect(categoryById(input.categoryId), `${entry.id} names unknown input ${input.categoryId}`).toBeDefined();
        expect(input.categoryId).not.toBe(entry.id);
      }
    }
  });

  it('the required-edge supply graph is acyclic', () => {
    expect(requiredSupplyGraphIsAcyclic(PRODUCT_CATEGORIES)).toBe(true);
  });

  it('rejects an artificial required cycle', () => {
    const [a, b] = PRODUCT_CATEGORIES;
    if (a === undefined || b === undefined) throw new Error('catalogue too small for this test');
    const rigged = PRODUCT_CATEGORIES.map((entry) => {
      if (entry.id === a.id) return { ...entry, inputs: [...entry.inputs, { categoryId: b.id, share: 0.1, required: true }] };
      if (entry.id === b.id) return { ...entry, inputs: [...entry.inputs, { categoryId: a.id, share: 0.1, required: true }] };
      return entry;
    });
    expect(requiredSupplyGraphIsAcyclic(rigged)).toBe(false);
  });

  it('categoryById resolves every catalogue id and nothing else', () => {
    for (const entry of PRODUCT_CATEGORIES) expect(categoryById(entry.id)).toBe(entry);
    expect(categoryById('not_a_real_category')).toBeUndefined();
  });

  it('PRODUCT_CATEGORIES_BY_ID indexes every entry exactly once', () => {
    expect(Object.keys(PRODUCT_CATEGORIES_BY_ID).length).toBe(PRODUCT_CATEGORIES.length);
  });
});

describe('defaultCategoryFor', () => {
  it('is total over every (sector, segment) pair and always names a real category in that sector', () => {
    for (const sector of SECTORS) {
      for (const segment of PRODUCT_SEGMENTS) {
        const id = defaultCategoryFor(sector, segment);
        const entry = categoryById(id);
        expect(entry, `defaultCategoryFor(${sector}, ${segment}) named unknown category ${id}`).toBeDefined();
        expect(entry?.sector).toBe(sector);
      }
    }
  });

  it('is deterministic', () => {
    for (const sector of SECTORS) {
      for (const segment of PRODUCT_SEGMENTS) {
        expect(defaultCategoryFor(sector, segment)).toBe(defaultCategoryFor(sector, segment));
      }
    }
  });
});

describe('resolveCategory', () => {
  it('resolves a known id verbatim', () => {
    const entry = PRODUCT_CATEGORIES[0];
    if (entry === undefined) throw new Error('catalogue is empty');
    expect(resolveCategory(entry.id, entry.sector, entry.buyerSegment)).toBe(entry);
  });

  it('falls back to defaultCategoryFor for null, undefined or an unknown id', () => {
    for (const categoryId of [null, undefined, 'not_a_real_category'] as const) {
      const resolved = resolveCategory(categoryId, 'ai', 'developer_api');
      expect(resolved.id).toBe(defaultCategoryFor('ai', 'developer_api'));
    }
  });

  it('never returns undefined', () => {
    for (const sector of SECTORS) {
      for (const segment of PRODUCT_SEGMENTS) {
        expect(resolveCategory(null, sector, segment)).toBeDefined();
      }
    }
  });
});
