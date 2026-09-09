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
 *
 * It is also position-blind: a reply may contain several top-level objects — a
 * thinking aside, a worked example, then the answer — and the *first* one is
 * not necessarily the intended one. Every balanced object is offered in turn
 * and the caller's `accept` predicate decides, so a decoy preamble can no
 * longer burn the one permitted repair.
 */

/** Result of pulling a JSON value out of arbitrary model text. */
export type JsonExtraction = { ok: true; value: unknown; source: string } | { ok: false; reason: string };

/** Decides whether an extracted object is the one the caller wanted. */
export type JsonCandidateFilter = (value: unknown) => boolean;

const FENCE = /^\s*```(?:json|jsonc|json5)?\s*\n([\s\S]*?)\n?\s*```\s*$/;

/** Strip a single wrapping code fence, if the whole reply is one. */
export function stripCodeFence(text: string): string {
  const match = FENCE.exec(text);
  const inner = match?.[1];
  return inner === undefined ? text : inner;
}

/**
 * Every balanced top-level `{...}` in `text`, in order, honouring string
 * literals and escapes. Nested objects are part of their parent, never yielded
 * on their own.
 */
export function balancedObjects(text: string): string[] {
  const found: string[] = [];
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
      if (depth === 0 && start >= 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/**
 * The first balanced `{...}` in `text`, or null when there is no complete
 * object.
 */
export function firstBalancedObject(text: string): string | null {
  return balancedObjects(text)[0] ?? null;
}

/**
 * Pull one JSON object out of a model reply.
 *
 * Order: the whole reply, the de-fenced reply, then **every** balanced object
 * inside either, in the order they appear. Anything that parses to a non-object
 * (a bare string, a number, an array) is refused — every LLM-facing schema in
 * `@frontier/contracts` is an object at the root.
 *
 * `accept` lets the caller keep looking past an object that parses but is not
 * the reply: the transport passes its zod schema, so `{"note":"decoy"} then
 * {…the real answer…}` resolves to the real answer instead of spending the one
 * permitted repair on packaging. The first candidate that parses is still
 * returned when nothing satisfies `accept`, so the caller reports a schema
 * violation against the model's most plausible answer rather than a bare
 * "no JSON found".
 */
export function extractJsonObject(text: string, accept?: JsonCandidateFilter): JsonExtraction {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'the reply was empty' };

  const push = (candidate: string): void => {
    if (candidate.length > 0 && !candidates.includes(candidate)) candidates.push(candidate);
  };

  push(trimmed);
  const defenced = stripCodeFence(trimmed).trim();
  push(defenced);
  for (const source of [trimmed, defenced]) for (const balanced of balancedObjects(source)) push(balanced);

  let firstParsed: JsonExtraction | null = null;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const extraction: JsonExtraction = { ok: true, value: parsed, source: candidate };
    if (accept === undefined || accept(parsed)) return extraction;
    firstParsed ??= extraction;
  }

  if (firstParsed !== null) return firstParsed;
  return { ok: false, reason: 'no complete JSON object could be extracted from the reply' };
}
