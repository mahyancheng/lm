/**
 * @frontier/simulation — resolver/ledger.ts
 *
 * The append-only ledger and the resolution report, written by the same object
 * so that the invariant binding them cannot be broken by accident:
 *
 * > Every line on the Quarter Resolution screen references at least one
 * > committed ledger event. Nothing on that screen is narrative invention.
 *
 * ## The hash chain
 *
 * Every row carries the canonical state hash before and after it. Because
 * subsystems mutate the draft and *then* emit, the hash taken at emit time is
 * the "after" state, and the "before" is the previous row's "after". The chain
 * therefore starts at the pre-resolution hash and ends at the committed hash,
 * and a row inserted, removed or altered afterwards breaks it — which is exactly
 * what the `deterministic_replay` invariant checks at commit.
 *
 * Sequence numbers come from `SessionState.ledgerSequence`, which advances
 * monotonically and never rewinds. Ids are built from session, quarter and
 * sequence, so a replay reproduces them byte for byte.
 */

import type {
  ResolutionLine,
  ResolutionLineDraft,
  ResolutionPhase,
  ResolutionPhaseReport,
  ResolverContext,
  SeededRng,
  SessionState,
  SimEvent,
  SimEventDraft,
} from '@frontier/contracts';
import { RESOLUTION_PHASES, makeId } from '@frontier/contracts';

/** Report lines are capped by the schema; a long line is clipped, never dropped. */
const MAX_LINE_TEXT = 300;
const MAX_DELTA_LABEL = 40;

/**
 * Collects the quarter's ledger rows and report lines.
 *
 * One instance per `resolveQuarter` call. The draft it writes sequence numbers
 * into is the same draft the subsystems mutate.
 */
export class ResolutionRecorder {
  readonly events: SimEvent[] = [];

  private readonly linesByPhase = new Map<ResolutionPhase, ResolutionLine[]>();
  private phase: ResolutionPhase = 'world_events';
  private lastEventIdInPhase: string | null = null;
  private lastEventIdOverall: string | null = null;
  private lastHash: string;

  /** Lines a subsystem logged with no event to reference. Reported at commit. */
  private unreferencedLines = 0;

  readonly startSequence: number;

  constructor(
    private readonly draft: SessionState,
    private readonly hash: (value: unknown) => string,
    preResolutionHash: string,
  ) {
    this.lastHash = preResolutionHash;
    this.startSequence = draft.ledgerSequence;
  }

  /** Open a phase. Emitted rows and logged lines attribute to it from here. */
  beginPhase(phase: ResolutionPhase): void {
    this.phase = phase;
    this.lastEventIdInPhase = null;
  }

  /** The context handed to a subsystem for one phase. */
  contextFor(phase: ResolutionPhase, rng: SeededRng): ResolverContext {
    const quarter = this.draft.quarter;
    return {
      quarter,
      rng,
      emit: (draft: SimEventDraft) => this.emit(draft, phase),
      log: (line: ResolutionLineDraft) => this.log(line, phase),
    };
  }

  /** Append a ledger row. Returns the assigned event id. */
  emit(draft: SimEventDraft, phase: ResolutionPhase = this.phase): string {
    const sequence = this.draft.ledgerSequence;
    this.draft.ledgerSequence = sequence + 1;

    const eventId = makeId('evt', this.draft.sessionId, this.draft.quarter, sequence);
    const stateHashBefore = this.lastHash;
    const stateHashAfter = this.hash(this.draft);
    this.lastHash = stateHashAfter;

    const event: SimEvent = {
      eventId,
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      sequence,
      type: draft.type,
      actorId: draft.actorId,
      targetId: draft.targetId,
      payload: draft.payload,
      stateHashBefore,
      stateHashAfter,
      visibility: draft.visibility,
    };
    this.events.push(event);
    if (phase === this.phase) this.lastEventIdInPhase = eventId;
    this.lastEventIdOverall = eventId;
    return eventId;
  }

  /**
   * Add a line to the report.
   *
   * A line with no `refEventIds` inherits the most recent row emitted in its own
   * phase — the overwhelmingly common case, where a subsystem emits and then
   * describes what it just emitted. A line that can reference nothing at all is
   * dropped and counted, because a report line without a ledger row behind it is
   * precisely the thing this game does not do.
   */
  log(line: ResolutionLineDraft, phase: ResolutionPhase = this.phase): void {
    const refs = line.refEventIds !== undefined && line.refEventIds.length > 0
      ? line.refEventIds
      : this.lastEventIdInPhase !== null
        ? [this.lastEventIdInPhase]
        : this.lastEventIdOverall !== null
          ? [this.lastEventIdOverall]
          : [];

    if (refs.length === 0) {
      this.unreferencedLines += 1;
      return;
    }

    const target = line.phase ?? phase;
    const bucket = this.linesByPhase.get(target) ?? [];
    bucket.push({
      phase: target,
      text: clip(line.text, MAX_LINE_TEXT),
      deltaLabel: line.deltaLabel === null ? null : clip(line.deltaLabel, MAX_DELTA_LABEL),
      refEventIds: [...refs],
      tone: line.tone,
      subjectId: line.subjectId,
    });
    this.linesByPhase.set(target, bucket);
  }

  /** Lines recorded for one phase, in the order they were logged. */
  linesFor(phase: ResolutionPhase): readonly ResolutionLine[] {
    return this.linesByPhase.get(phase) ?? [];
  }

  /** Every line, in pipeline order. */
  allLines(): ResolutionLine[] {
    const out: ResolutionLine[] = [];
    for (const phase of RESOLUTION_PHASES) out.push(...this.linesFor(phase));
    return out;
  }

  /**
   * One report entry per phase that produced output.
   *
   * `durationMs` is always zero, and deliberately so: the engine is forbidden
   * from reading a clock, because a wall-clock reading inside `resolveQuarter`
   * would make the committed report differ between two runs of the same seed.
   * Timing belongs to `EnginePhaseTiming`, which is diagnostics and never state.
   */
  phaseReports(): ResolutionPhaseReport[] {
    const reports: ResolutionPhaseReport[] = [];
    for (const phase of RESOLUTION_PHASES) {
      const lines = this.linesFor(phase);
      if (lines.length === 0) continue;
      reports.push({ phase, lines: [...lines], durationMs: 0 });
    }
    return reports;
  }

  get droppedLineCount(): number {
    return this.unreferencedLines;
  }

  get currentHash(): string {
    return this.lastHash;
  }
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
