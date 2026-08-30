/**
 * @frontier/llm — transport/json.ts
 *
 * Robust extraction of one JSON object from a model reply.
 *
 * The `claude-session` transport prompts for bare JSON, but a Claude Code
 * session is a conversational surface and occasionally wraps its answer: a
 * fenced code block, a sentence of preamble, a trailing "Let me know if…".
 * Rejecting those outright would burn a retry on a reply that is perfectly
 * good underneath, so the extractor is deliberately forgiving about the
 * packaging and completely unforgiving about the content — whatever it finds
 * is still parsed by zod before it can become an engine input.
 *
 * The scan is brace-balanced and string-aware, so an object containing `"}"`
 * inside a string value (a rationale, a post body) survives intact.
 */

/** Result of pulling a JSON value out of arbitrary model text. */
export type JsonExtraction = { ok: true; value: unknown; source: string } | { ok: false; reason: string };

const FENCE = /^\s*```(?:json|jsonc|json5)?\s*\n([\s\S]*?)\n?\s*```\s*$/;

/** Strip a single wrapping code fence, if the whole reply is one. */
export function stripCodeFence(text: string): string {
  const match = FENCE.exec(text);
  const inner = match?.[1];
  return inner === undefined ? text : inner;
}

/**
 * The first balanced `{...}` in `text`, honouring string literals and escapes,
 * or null when there is no complete object.
 */
export function firstBalancedObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue; // stray closer before any opener
      depth -= 1;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pull one JSON object out of a model reply.
 *
 * Order: parse the whole reply, then the de-fenced reply, then the first
 * balanced object inside it. Anything that parses to a non-object (a bare
 * string, a number, an array) is refused — every LLM-facing schema in
 * `@frontier/contracts` is an object at the root.
 */
export function extractJsonObject(text: string): JsonExtraction {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'the reply was empty' };

  candidates.push(trimmed);
  const defenced = stripCodeFence(trimmed).trim();
  if (defenced !== trimmed && defenced.length > 0) candidates.push(defenced);

  for (const source of [trimmed, defenced]) {
    const balanced = firstBalancedObject(source);
    if (balanced !== null && !candidates.includes(balanced)) candidates.push(balanced);
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed, source: candidate };
    }
  }

  return { ok: false, reason: 'no complete JSON object could be extracted from the reply' };
}
