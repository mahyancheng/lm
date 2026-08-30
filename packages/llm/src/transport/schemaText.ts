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
 *
 * The `api` transport needs a second, narrower rendering: the structured-output
 * endpoint accepts only a small keyword set, so `structuredOutputSchemaFor`
 * puts a schema through the same transformation the SDK's `zodOutputFormat`
 * applies before sending it. The prompt-facing rendering above stays untouched:
 * a model reading a schema in words benefits from the very bounds the endpoint
 * refuses as keywords.
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

/* -------------------------------------------------------------------------- */
/*  Structured-output narrowing                                                */
/* -------------------------------------------------------------------------- */

/**
 * The `format` values the structured-output endpoint keeps on a string node.
 * Taken verbatim from `SUPPORTED_STRING_FORMATS` in the installed SDK's
 * `lib/transform-json-schema`.
 */
const SUPPORTED_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

type JsonSchemaNode = { [key: string]: unknown };

function isNode(value: unknown): value is JsonSchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function take(node: JsonSchemaNode, key: string): unknown {
  const value = node[key];
  delete node[key];
  return value;
}

/**
 * Narrow a JSON Schema to the keyword set the structured-output endpoint
 * accepts, exactly as `zodOutputFormat` does.
 *
 * This is the transformation `@anthropic-ai/sdk`'s `zodOutputFormat` runs
 * before handing a schema to `output_config.format` — we cannot call it
 * directly because that helper is typed against zod 4 while
 * `@frontier/contracts` is pinned to zod 3 (see transport/api.ts). The rules,
 * replicated from the installed `lib/transform-json-schema`:
 *
 * - a `$ref` node is passed through alone;
 * - `$defs` are transformed recursively (this package inlines rather than
 *   `$ref`s, so in practice there are none);
 * - exactly one of `type` / `anyOf` / `oneOf` / `allOf` survives, with `oneOf`
 *   rewritten to `anyOf`;
 * - objects are forced strict: `additionalProperties: false`, properties
 *   transformed recursively, `required` preserved;
 * - a string keeps `format` only from the supported list;
 * - an array keeps `minItems` only when it is 0 or 1;
 * - **every other keyword is folded into `description`**, so a bound the
 *   endpoint will not accept as a keyword still reaches the model as prose
 *   rather than being silently dropped.
 *
 * Two normalisations happen first, both of them differences between what
 * `zod-to-json-schema` renders for draft-07 and what zod 4's own
 * `toJSONSchema` (which is what `zodOutputFormat` transforms) renders:
 *
 * - `$schema` is stripped rather than folded — a draft marker is noise in a
 *   description and says nothing to the model;
 * - a union `type: ["string", "null"]` becomes `anyOf`, which is the only form
 *   the transform's own output ever takes.
 */
export function transformJsonSchema(input: JsonSchemaNode): JsonSchemaNode {
  const working = clone(input);
  delete working['$schema'];
  return transformNode(working);
}

function clone(node: JsonSchemaNode): JsonSchemaNode {
  return JSON.parse(JSON.stringify(node)) as JsonSchemaNode;
}

/**
 * `{ type: ["string", "null"], ...bounds }` → `{ anyOf: [{ type: "string",
 * ...bounds }, { type: "null" }] }`. Bounds go with the variant they constrain;
 * nothing constrains null.
 */
function splitUnionType(node: JsonSchemaNode, types: readonly unknown[]): JsonSchemaNode {
  const rest = clone(node);
  delete rest['type'];
  const description = take(rest, 'description');
  const title = take(rest, 'title');

  const rebuilt: JsonSchemaNode = {
    anyOf: types.map((type) => (type === 'null' ? { type } : { type, ...clone(rest) })),
  };
  if (description !== undefined) rebuilt['description'] = description;
  if (title !== undefined) rebuilt['title'] = title;
  return rebuilt;
}

function transformNode(node: JsonSchemaNode): JsonSchemaNode {
  const declaredType = node['type'];
  if (Array.isArray(declaredType)) return transformNode(splitUnionType(node, declaredType));

  const strict: JsonSchemaNode = {};

  const ref = take(node, '$ref');
  if (ref !== undefined) {
    strict['$ref'] = ref;
    return strict;
  }

  const defs = take(node, '$defs');
  if (isNode(defs)) {
    const strictDefs: JsonSchemaNode = {};
    strict['$defs'] = strictDefs;
    for (const [name, defSchema] of Object.entries(defs)) {
      if (isNode(defSchema)) strictDefs[name] = transformNode(defSchema);
    }
  }

  const type = take(node, 'type');
  const anyOf = take(node, 'anyOf');
  const oneOf = take(node, 'oneOf');
  const allOf = take(node, 'allOf');
  const branch = Array.isArray(anyOf) ? anyOf : Array.isArray(oneOf) ? oneOf : null;

  if (branch !== null) {
    strict['anyOf'] = branch.map((variant) => (isNode(variant) ? transformNode(variant) : variant));
  } else if (Array.isArray(allOf)) {
    strict['allOf'] = allOf.map((entry) => (isNode(entry) ? transformNode(entry) : entry));
  } else {
    if (type === undefined) {
      throw new Error('a JSON Schema node needs a type unless it uses anyOf, oneOf or allOf');
    }
    strict['type'] = type;
  }

  const description = take(node, 'description');
  if (description !== undefined) strict['description'] = description;
  const title = take(node, 'title');
  if (title !== undefined) strict['title'] = title;

  if (type === 'object') {
    const properties = take(node, 'properties');
    const entries = isNode(properties) ? Object.entries(properties) : [];
    strict['properties'] = Object.fromEntries(entries.map(([key, value]) => [key, isNode(value) ? transformNode(value) : value]));
    take(node, 'additionalProperties');
    strict['additionalProperties'] = false;
    const required = take(node, 'required');
    if (required !== undefined) strict['required'] = required;
  } else if (type === 'string') {
    const format = take(node, 'format');
    if (typeof format === 'string' && SUPPORTED_STRING_FORMATS.has(format)) strict['format'] = format;
    else if (format !== undefined) node['format'] = format;
  } else if (type === 'array') {
    const items = take(node, 'items');
    if (isNode(items)) strict['items'] = transformNode(items);
    else if (items !== undefined) strict['items'] = items;
    const minItems = take(node, 'minItems');
    if (minItems === 0 || minItems === 1) strict['minItems'] = minItems;
    else if (minItems !== undefined) node['minItems'] = minItems;
  }

  const leftovers = Object.entries(node);
  if (leftovers.length > 0) {
    const existing = strict['description'];
    const folded = `{${leftovers.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')}}`;
    strict['description'] = typeof existing === 'string' && existing.length > 0 ? `${existing}\n\n${folded}` : folded;
  }

  return strict;
}

/**
 * JSON Schema for `schema`, narrowed for a structured-output request. This is
 * what `zodOutputFormat` would have produced.
 */
export function structuredOutputSchemaFor(schema: z.ZodType<unknown>): { [key: string]: unknown } {
  return transformJsonSchema(jsonSchemaObjectFor(schema));
}
