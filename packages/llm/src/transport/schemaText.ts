/**
 * @frontier/llm — transport/schemaText.ts
 *
 * One JSON Schema rendering, shared by every transport that has to describe a
 * contract to a model in words rather than through a provider's structured
 * output feature.
 *
 * `$refStrategy: 'none'` matters: the LLM-facing schemas in
 * `@frontier/contracts` reuse sub-schemas heavily (`ActionIntentSchema` alone
 * appears in three roles), and a `$ref`-laden document is measurably harder for
 * a model to follow than an inlined one. None of them are recursive, so
 * inlining always terminates.
 *
 * Renders are memoised per schema instance: the schemas are module-level
 * singletons, so a session pays this cost once per role rather than once per
 * quarter.
 */

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const cache = new WeakMap<object, string>();

/** JSON Schema for `schema`, as a compact JSON string. Deterministic and memoised. */
export function jsonSchemaTextFor(schema: z.ZodType<unknown>, name: string): string {
  const key = schema as unknown as object;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const rendered = JSON.stringify(zodToJsonSchema(schema, { name, target: 'jsonSchema7', $refStrategy: 'none' }));
  cache.set(key, rendered);
  return rendered;
}

/** JSON Schema for `schema` as a plain object, for providers that take one structurally. */
export function jsonSchemaObjectFor(schema: z.ZodType<unknown>): { [key: string]: unknown } {
  return zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as { [key: string]: unknown };
}
