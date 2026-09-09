/**
 * @frontier/llm — compose/render.ts
 *
 * Small deterministic text helpers shared by the seven composers.
 *
 * Everything here is pure: same input, same string, every time. That is what
 * makes `AgentRunRecord.contextHash` meaningful — two runs with the same hash
 * really did see the same words.
 */

/** What a composer produces: the two halves of one model call. */
export interface ComposedPrompt {
  /** Stable per role. Carries authority, boundaries and output discipline. */
  readonly system: string;
  /** Volatile per call. The dossier composed from canonical state. */
  readonly prompt: string;
}

/** A composer: a pure function from a pre-redacted input to a prompt pair. */
export type ContextComposer<TInput> = (input: TInput) => ComposedPrompt;

/** Join non-empty blocks with a blank line between them. */
export function joinBlocks(blocks: readonly (string | null)[]): string {
  return blocks.filter((block): block is string => block !== null && block.trim().length > 0).join('\n\n');
}

/** A titled section. Empty bodies render as `(none)` so absence is explicit rather than ambiguous. */
export function section(title: string, body: string): string {
  const trimmed = body.trim();
  return `## ${title}\n${trimmed.length > 0 ? trimmed : '(none)'}`;
}

/** A dash list. Returns an empty string for an empty list, so `section` renders `(none)`. */
export function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

/** A numbered list, for ordered material such as conversation history. */
export function numbered(lines: readonly string[]): string {
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

/** Hard character cap with an ellipsis, so a long free-text field cannot blow a context window. */
export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Fixed-precision number, so the same value always renders the same characters. */
export function num(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '0';
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return String(rounded === 0 ? 0 : rounded);
}

/** Signed number, so a delta reads as a delta. */
export function signed(value: number, decimals = 2): string {
  const rendered = num(Math.abs(value), decimals);
  if (value > 0) return `+${rendered}`;
  if (value < 0) return `-${rendered}`;
  return rendered;
}

/** `0.34` as `34%`. Percentages are always fractions in the contracts. */
export function pct(value: number, decimals = 0): string {
  return `${num(value * 100, decimals)}%`;
}

/** Dollars, abbreviated the way a briefing would write them. */
export function usd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${num(abs / 1e12, 2)}tn`;
  if (abs >= 1e9) return `${sign}$${num(abs / 1e9, 2)}bn`;
  if (abs >= 1e6) return `${sign}$${num(abs / 1e6, 1)}m`;
  if (abs >= 1e3) return `${sign}$${num(abs / 1e3, 1)}k`;
  return `${sign}$${num(abs, 0)}`;
}

/** The last `count` entries, oldest first. Used for bounded history windows. */
export function lastN<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  return items.length <= count ? [...items] : items.slice(items.length - count);
}

/** The JSON-only closing line every role system prompt ends with. */
export const OUTPUT_DISCIPLINE = [
  'Output discipline:',
  '- Reply with one JSON object and nothing else: no preamble, no commentary, no code fences.',
  '- Every field in the schema is required. Use null where the schema permits null; never omit a key.',
  '- Stay inside the stated numeric bounds. Values outside them are clamped or the whole proposal is discarded.',
  '- Never invent an identifier. Use only ids that appear in the dossier above.',
].join('\n');

/** The authority line that appears, in one form or another, in every role system prompt. */
export const AUTHORITY_PREAMBLE =
  'You are one narrow role inside a deterministic simulation. You propose; the engine decides. Nothing you write changes state directly: your output is validated against a schema, bounds-checked, clamped where necessary, and only then applied.';
