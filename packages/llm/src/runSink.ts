/**
 * @frontier/llm — runSink.ts
 *
 * Where `AgentRunRecord`s go.
 *
 * Every important model result is logged: role, model, the exact context hash,
 * the state hash at call time, the parsed output verbatim, the validation
 * result, latency, tokens, whether a fallback ran and any error. That record is
 * what makes bugs reproducible and replays honest — a deterministic replay uses
 * the *recorded* structured output rather than re-calling a model, so a session
 * reproduces exactly even after the model has changed underneath it.
 *
 * Rows live in the service-role-only `agent_runs` table, which has no RLS
 * policy at all: raw model output and rejected proposals are never readable by
 * a client. The sink is injected so the gateway itself stays free of I/O —
 * demo mode collects into an array, production writes to Supabase.
 */

import type { AgentRunRecord } from '@frontier/contracts';

export interface RunSink {
  /** Record one completed model call. Must not throw and must not block resolution. */
  record(run: AgentRunRecord): void;
}

/** A sink that drops everything. The default when no sink is supplied. */
export function createNullRunSink(): RunSink {
  return {
    record(): void {
      /* intentionally empty */
    },
  };
}

export interface MemoryRunSink extends RunSink {
  readonly runs: readonly AgentRunRecord[];
  clear(): void;
}

/** In-process sink, for demo mode and tests. */
export function createMemoryRunSink(): MemoryRunSink {
  const runs: AgentRunRecord[] = [];
  return {
    runs,
    record(run: AgentRunRecord): void {
      runs.push(run);
    },
    clear(): void {
      runs.length = 0;
    },
  };
}

/**
 * Wrap a sink so a failing implementation can never take down a quarter.
 * A dropped diagnostic is always cheaper than a failed resolution.
 */
export function safeRunSink(sink: RunSink): RunSink {
  return {
    record(run: AgentRunRecord): void {
      try {
        sink.record(run);
      } catch {
        /* diagnostics must never break resolution */
      }
    },
  };
}
