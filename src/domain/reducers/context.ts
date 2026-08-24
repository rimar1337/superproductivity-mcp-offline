import type { IdGenerator } from '../ports.js';
import type { OperationFactory } from '../sync/operation-factory.js';

/**
 * Everything a reducer needs that it must not reach out and fetch itself.
 *
 * Reducers are pure functions of `(state, input, context)`. Passing time and
 * identity in — rather than calling `Date.now()` or `nanoid()` inline — is what
 * makes a reducer's output byte-for-byte reproducible in a test, which is the
 * only practical way to assert that the state we upload and the operation other
 * devices replay describe the same change.
 */
export interface ReducerContext {
  /** Local date as `YYYY-MM-DD`. Decides Today membership. */
  readonly today: string;
  /** Epoch ms, frozen for the whole batch so one change has one timestamp. */
  readonly now: number;
  readonly operations: OperationFactory;
  readonly ids: IdGenerator;
}
