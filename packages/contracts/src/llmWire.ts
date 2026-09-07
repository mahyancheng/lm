/** Saved actions retain optional extension fields for replay compatibility.
 * On the model wire those fields are required and nullable. Convert only at
 * the transport boundary; never add null keys to old canonical state. */
import { z } from 'zod';

const cache = new WeakMap<z.ZodTypeAny, z.ZodTypeAny>();
export function llmWireSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const cached = cache.get(schema);
  if (cached) return cached;
  let wire: z.ZodTypeAny = schema;
  if (schema instanceof z.ZodOptional) wire = llmWireSchema(schema.unwrap()).nullable();
  else if (schema instanceof z.ZodNullable) wire = llmWireSchema(schema.unwrap()).nullable();
  else if (schema instanceof z.ZodObject) wire = schema.extend(Object.fromEntries(Object.entries(schema.shape as z.ZodRawShape).map(([key, child]) => [key, llmWireSchema(child)])));
  else if (schema instanceof z.ZodArray) wire = new z.ZodArray({ ...schema._def, type: llmWireSchema(schema.element) });
  else if (schema instanceof z.ZodDiscriminatedUnion) wire = z.discriminatedUnion(schema.discriminator, schema.options.map((option: z.ZodTypeAny) => llmWireSchema(option)) as [z.ZodDiscriminatedUnionOption<string>, ...z.ZodDiscriminatedUnionOption<string>[]]);
  else if (schema instanceof z.ZodUnion) wire = z.union(schema.options.map((option: z.ZodTypeAny) => llmWireSchema(option)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  if (schema.description) wire = wire.describe(schema.description);
  cache.set(schema, wire);
  return wire;
}

/** Drop null only where the canonical schema explicitly permits absence.
 * Ordinary nullable keys (including ids) remain intact. Canonical validation
 * still rejects malformed fields and invalid action variants afterward. */
export function fromLlmWire(schema: z.ZodTypeAny, value: unknown): unknown {
  if (schema instanceof z.ZodOptional) return value === null ? undefined : fromLlmWire(schema.unwrap(), value);
  if (schema instanceof z.ZodNullable) return value === null ? null : fromLlmWire(schema.unwrap(), value);
  if (schema instanceof z.ZodArray && Array.isArray(value)) return value.map((entry) => fromLlmWire(schema.element, entry));
  if (schema instanceof z.ZodDiscriminatedUnion && value && typeof value === 'object') {
    const discriminator = (value as Record<string, unknown>)[schema.discriminator];
    const option = typeof discriminator === 'string' ? schema.optionsMap.get(discriminator) : undefined;
    return option ? fromLlmWire(option, value) : value;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options as z.ZodTypeAny[]) {
      const candidate = fromLlmWire(option, value);
      if (option.safeParse(candidate).success) return candidate;
    }
    return value;
  }
  if (schema instanceof z.ZodObject && value && typeof value === 'object' && !Array.isArray(value)) {
    const result = { ...value } as Record<string, unknown>;
    for (const [key, child] of Object.entries(schema.shape as z.ZodRawShape)) {
      if (!(key in result)) continue;
      const normalized = fromLlmWire(child, result[key]);
      if (normalized === undefined && child instanceof z.ZodOptional) delete result[key];
      else result[key] = normalized;
    }
    return result;
  }
  return value;
}
