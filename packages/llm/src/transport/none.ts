/**
 * @frontier/llm — transport/none.ts
 *
 * No model at all.
 *
 * `LLM_TRANSPORT=none` is what demo mode runs on, which is why demo mode needs
 * no credentials of any kind. Every call returns `output: null` with the
 * `disabled`-tagged skip marker, so the role layer engages the deterministic
 * fallback for that role and the quarter resolves exactly as it would during a
 * real outage. That is the point: an LLM outage is a degraded quarter, never a
 * blocked one, and this transport lets every test exercise the degraded path.
 *
 * Nothing here reads a clock or a random number, so a session driven entirely
 * by the null transport is byte-for-byte reproducible.
 */

import type { LlmCompletion, LlmCompletionRequest, LlmTransport } from './types';
import { LLM_SKIPPED_ISSUE, validationFailed } from './types';

export interface NullTransportConfig {
  /** Model id recorded on run records. Defaults to `'none'`. */
  readonly modelId?: string;
  /** Called on every skipped request, for demo-mode diagnostics. */
  readonly onSkip?: (req: LlmCompletionRequest<unknown>) => void;
}

export function createNullTransport(config: NullTransportConfig = {}): LlmTransport {
  const modelId = config.modelId ?? 'none';
  return {
    kind: 'none',
    async complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
      config.onSkip?.(req as LlmCompletionRequest<unknown>);
      return {
        output: null,
        raw: '',
        validation: validationFailed(req.schemaName, [LLM_SKIPPED_ISSUE]),
        modelId,
        latencyMs: 0,
        tokens: null,
        claudeSessionId: null,
      };
    },
  };
}
