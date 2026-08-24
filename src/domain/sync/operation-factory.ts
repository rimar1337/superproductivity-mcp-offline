import type {
  CompactOperation,
  EntityType,
  OperationPayload,
  OpType,
} from './operation.js';
import { incrementVectorClock, type VectorClock } from './vector-clock.js';
import type { IdGenerator } from '../ports.js';

export interface OperationDraft {
  readonly actionCode: string;
  readonly opType: OpType;
  readonly entityType: EntityType;
  /** Primary entity id. */
  readonly entityId: string;
  /**
   * Every entity id the operation touches. Defaults to `[entityId]`.
   *
   * This is what Super Productivity's conflict detection keys off, so a
   * multi-entity operation that under-reports its ids is an operation that can
   * be accepted when it should have been flagged as conflicting.
   */
  readonly entityIds?: readonly string[];
  readonly actionPayload: Record<string, unknown>;
}

/**
 * Mints operations for one write batch.
 *
 * Statefulness here is deliberate and scoped: the factory carries the vector
 * clock forward across the batch, incrementing it once per operation exactly
 * as Super Productivity's local capture does. A batch that stamped every
 * operation with the same clock would make its own operations look concurrent
 * with each other, which is the one thing a causal ordering must never do.
 *
 * A factory instance belongs to a single read-modify-write attempt. When a
 * conditional write loses the race and the attempt is retried, a *new* factory
 * is built from the freshly downloaded clock — never reused — so the retry is
 * causally newer than the write that beat us rather than a stale replay of it.
 */
export class OperationFactory {
  #clock: VectorClock;

  constructor(
    baseClock: VectorClock,
    private readonly clientId: string,
    private readonly schemaVersion: number,
    private readonly ids: IdGenerator,
    private readonly now: () => number,
  ) {
    this.#clock = { ...baseClock };
  }

  /** The clock after every operation minted so far. */
  get vectorClock(): VectorClock {
    return { ...this.#clock };
  }

  create(draft: OperationDraft): CompactOperation {
    this.#clock = incrementVectorClock(this.#clock, this.clientId);

    const payload: OperationPayload = {
      actionPayload: draft.actionPayload,
      // Always present, always empty. Real operations in real sync files carry
      // this key; matching them exactly costs nothing and removes a whole class
      // of "some validator we never read rejects our shape" failure.
      entityChanges: [],
    };

    return {
      id: this.ids.operationId(),
      a: draft.actionCode,
      o: draft.opType,
      e: draft.entityType,
      d: draft.entityId,
      ds: [...(draft.entityIds ?? [draft.entityId])],
      p: payload,
      c: this.clientId,
      v: this.vectorClock,
      t: this.now(),
      s: this.schemaVersion,
    };
  }
}
