/**
 * @frontier/simulation — resolver/ledger.ts
 *
 * The append-only ledger and the resolution report, written by the same object
 * so that the invariant binding them cannot be broken by accident:
 *
 * > Every line on the Quarter Resolution screen references at least one
 * > committed ledger event. Nothing on that screen is narrative invention.
 *
 * ## The two hash chains
 *
 * A quarter writes hundreds of rows, and hashing the whole session state for
 * each of them made the state hash — not the economy — the cost of a quarter.
 * The chain is therefore split into the two things it was doing at once:
 *
 * - **Per phase, the state.** The canonical state is hashed once at each phase
 *   boundary. Every row a phase wrote carries that phase's opening hash as
 *   `stateHashBefore` and its closing hash as `stateHashAfter`, so the phase
 *   hashes still chain unbroken from the pre-resolution state to the committed
 *   one and a replay can still be localised to the phase that diverged.
 * - **Per row, the row.** `rowHash` is `fnv1a64(previousRowHash + the row,
 *   canonically serialised)`, seeded with the pre-resolution state hash. It
 *   costs a few hundred bytes of serialisation rather than a megabyte, and it
 *   is what makes a row inserted, removed, reordered or altered detectable —
 *   which is exactly what the `deterministic_replay` invariant checks at commit.
 *
 * Because a row's `stateHashAfter` is only known when its phase closes, rows are
 * stamped and chained at the phase boundary. `beginPhase` seals the phase before
 * it, and `seal` closes the last one; nothing reads a row before its own phase
 * has been sealed.
 *
 * Sequence numbers come from `SessionState.ledgerSequence`, which advances
 * monotonically and never rewinds. Ids are built from session, the quarter being
 * resolved and sequence, so a replay reproduces them byte for byte.
 */

import type {
  ResolutionLine,
  ResolutionLineDraft,
  NodeCostCache,
  ResolutionPhase,
  ResolutionPhaseReport,
  ResolverContext,
  SeededRng,
  SessionState,
  SimEvent,
  SimEventDraft,
} from '@frontier/contracts';
import { RESOLUTION_PHASES, makeId } from '@frontier/contracts';
import { fnv1a64, stableStringify } from '@frontier/shared';
import { createNodeCostCache } from '../graph/lines';

/** Report lines are capped by the schema; a long line is clipped, never dropped. */
const MAX_LINE_TEXT = 300;
const MAX_DELTA_LABEL = 40;

/* -------------------------------------------------------------------------- */
/*  The row chain                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The canonical serialisation of a row, for the row chain.
 *
 * `rowHash` itself is excluded — it is the output — and every other field is
 * included, so altering any of them after the fact breaks the chain.
 */
export function rowFingerprint(event: SimEvent): string {
  return stableStringify({
    eventId: event.eventId,
    sessionId: event.sessionId,
    quarter: event.quarter,
    sequence: event.sequence,
    type: event.type,
    actorId: event.actorId,
    targetId: event.targetId,
    payload: event.payload,
    stateHashBefore: event.stateHashBefore,
    stateHashAfter: event.stateHashAfter,
    visibility: event.visibility,
  });
}

/**
 * The next link of the row chain: cheap, order-dependent and tamper-evident.
 *
 * Seeded with the pre-resolution state hash, so a quarter's chain is bound to
 * the state it started from as well as to its own rows.
 */
export function chainRowHash(previousRowHash: string, event: SimEvent): string {
  return fnv1a64(`${previousRowHash}|${rowFingerprint(event)}`);
}

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
  /** State hash at the close of the last phase that wrote to the ledger. */
  private lastHash: string;
  /** The last link of the row chain. Seeded with the pre-resolution hash. */
  private lastRowHash: string;
  /** Rows written by the open phase, awaiting its closing hash. */
  private pending: SimEvent[] = [];

  /** Lines a subsystem logged with no event to reference. Reported at commit. */
  private unreferencedLines = 0;

  /**
   * The unit-cost memo table for this one resolution, handed to every phase.
   *
   * Built here rather than by a phase because its lifetime is the resolution's
   * lifetime exactly: it must outlive one phase and must not outlive one
   * quarter. World 1 and world 2 never look at it.
   */
  readonly costCache: NodeCostCache;

  readonly startSequence: number;
  /**
   * The quarter being resolved, fixed at construction.
   *
   * Commit advances `draft.quarter`, so reading it per row would stamp the last
   * rows of a quarter — the commit and the snapshot — with the *next* quarter's
   * index. Event ids and phase contexts both come from here instead.
   */
  readonly resolutionQuarter: number;

  constructor(
    private readonly draft: SessionState,
    private readonly hash: (value: unknown) => string,
    preResolutionHash: string,
  ) {
    this.lastHash = preResolutionHash;
    this.lastRowHash = preResolutionHash;
    this.startSequence = draft.ledgerSequence;
    this.resolutionQuarter = draft.quarter;
    this.costCache = createNodeCostCache(draft);
  }

  /**
   * Open a phase, sealing the one before it. Emitted rows and logged lines
   * attribute to the new phase from here.
   *
   * Re-opening the phase that is already open — the resolver announces
   * `world_events` before the loop reaches it — continues that phase rather than
   * closing it, so the quarter's opening row belongs to the same group as the
   * rest of the phase and costs no extra state hash.
   */
  beginPhase(phase: ResolutionPhase): void {
    if (phase !== this.phase) this.seal();
    this.phase = phase;
    this.lastEventIdInPhase = null;
  }

  /**
   * Close the open phase: hash the state once, stamp it on every row the phase
   * wrote and extend the row chain over them in order.
   *
   * `knownHash` lets a caller that has just hashed the state for its own reasons
   * — the snapshot — hand the value in rather than pay for it twice. Idempotent
   * and free when the phase wrote nothing.
   */
  seal(knownHash?: string): void {
    if (this.pending.length === 0) return;
    const after = knownHash ?? this.hash(this.draft);
    for (const row of this.pending) {
      row.stateHashAfter = after;
      this.lastRowHash = chainRowHash(this.lastRowHash, row);
      row.rowHash = this.lastRowHash;
    }
    this.pending = [];
    this.lastHash = after;
  }

  /**
   * The context handed to a subsystem for one phase.
   *
   * Every phase of one resolution is handed the *same* cost cache, which is
   * what makes it a per-resolution memo table rather than a per-phase one: the
   * roll-up a phase does is still valid for the next phase of the same quarter,
   * and a module-level cache would leak between saves and break replay.
   */
  contextFor(phase: ResolutionPhase, rng: SeededRng): ResolverContext {
    return {
      quarter: this.resolutionQuarter,
      rng,
      costCache: this.costCache,
      emit: (draft: SimEventDraft) => this.emit(draft, phase),
      log: (line: ResolutionLineDraft) => this.log(line, phase),
    };
  }

  /**
   * Append a ledger row. Returns the assigned event id.
   *
   * The row's `stateHashAfter` and `rowHash` are written when its phase closes;
   * until then they are empty, and no consumer sees a row before that.
   */
  emit(draft: SimEventDraft, phase: ResolutionPhase = this.phase): string {
    const sequence = this.draft.ledgerSequence;
    this.draft.ledgerSequence = sequence + 1;

    const eventId = makeId('evt', this.draft.sessionId, this.resolutionQuarter, sequence);

    const event: SimEvent = {
      eventId,
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      sequence,
      type: draft.type,
      actorId: draft.actorId,
      targetId: draft.targetId,
      payload: draft.payload,
      stateHashBefore: this.lastHash,
      stateHashAfter: '',
      rowHash: '',
      visibility: draft.visibility,
    };
    this.events.push(event);
    this.pending.push(event);
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

  /** State hash at the close of the last sealed phase. */
  get currentHash(): string {
    return this.lastHash;
  }

  /** The last link of the row chain, over every sealed row. */
  get currentRowHash(): string {
    return this.lastRowHash;
  }
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
