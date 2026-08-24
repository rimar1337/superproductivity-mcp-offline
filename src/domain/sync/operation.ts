import type { VectorClock } from './vector-clock.js';

/**
 * The operation log entry, in the compact on-disk shape Super Productivity
 * writes into `recentOps`.
 *
 * Single-letter keys are not an optimisation we chose — they are the wire
 * format. Every field name here is load-bearing.
 *
 * @see `src/app/op-log/persistence/compact/compact-operation.types.ts` upstream
 */
export interface CompactOperation {
  /** UUID v7 — time-ordered, so ops sort chronologically by id alone. */
  id: string;
  /** Action code. @see ./action-codes.js */
  a: string;
  /** Operation type. */
  o: OpType;
  /** Entity type the operation targets. */
  e: EntityType;
  /** Primary entity id. */
  d?: string;
  /** Every entity id the operation touches, used for conflict detection. */
  ds?: string[];
  /** The NgRx action payload, wrapped as `{ actionPayload, entityChanges }`. */
  p: OperationPayload;
  /** Client id that authored the operation. */
  c: string;
  /** Vector clock at authoring time. */
  v: VectorClock;
  /** Authoring timestamp, epoch ms. */
  t: number;
  /** App data schema version. */
  s: number;
  /** Reason, for full-state operations only. */
  r?: string;
  /** Repair base server sequence, for repair operations only. */
  b?: number;
  /** syncVersion of the upload batch that carried this operation. */
  sv?: number;
}

/**
 * Payload envelope.
 *
 * `entityChanges` stays an empty array for everything this server emits: it is
 * used by Super Productivity's last-write-wins update path, which we do not
 * participate in. Omitting the key entirely is *not* equivalent — real ops in
 * real sync files always carry it, and matching them exactly is the cheapest
 * possible insurance against a validator we have not read.
 */
export interface OperationPayload {
  actionPayload: Record<string, unknown>;
  entityChanges: unknown[];
}

export const OpType = {
  Create: 'CRT',
  Update: 'UPD',
  Delete: 'DEL',
  Move: 'MOV',
  Batch: 'BATCH',
} as const;

export type OpType = (typeof OpType)[keyof typeof OpType];

export const EntityType = {
  Task: 'TASK',
  Project: 'PROJECT',
  Tag: 'TAG',
  Note: 'NOTE',
  GlobalConfig: 'GLOBAL_CONFIG',
  TimeTracking: 'TIME_TRACKING',
  All: 'ALL',
} as const;

export type EntityType = (typeof EntityType)[keyof typeof EntityType];

/**
 * A state change paired with the operation that describes it.
 *
 * This pairing is the core invariant of the whole server. Every mutation
 * produces exactly one of these, and the two halves must agree: the new state
 * is what *this device* will upload as its snapshot, and the operation is what
 * *every other device* will replay to reach the same place. If they disagree,
 * the user's devices quietly diverge.
 *
 * Keeping them in one return value — rather than mutating state here and
 * appending an op over there — is what makes that agreement checkable, and is
 * why every reducer in `src/domain/reducers` has this return type.
 */
export interface MutationResult<TState> {
  readonly state: TState;
  readonly operations: readonly CompactOperation[];
}
