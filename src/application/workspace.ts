import { ConcurrencyError, ReadOnlyModeError } from '../domain/errors.js';
import type { AppState } from '../domain/model/app-state.js';
import type { Clock, IdGenerator, Logger } from '../domain/ports.js';
import type { ReducerContext } from '../domain/reducers/context.js';
import type { MutationResult } from '../domain/sync/operation.js';
import { OperationFactory } from '../domain/sync/operation-factory.js';
import type { SyncSnapshot } from '../domain/sync/sync-file.js';
import type {
  CommitResult,
  ReadDiagnostics,
  SyncFileGateway,
} from '../infrastructure/sync/sync-file-gateway.js';

/**
 * The one place the rest of the server goes to read or change the user's data.
 *
 * It exists to make a single guarantee cheap to rely on: **a mutation is a
 * function of the state that is actually on the server right now.**
 *
 * Getting that guarantee needs two things working together.
 *
 * *Read-modify-write, not read-then-write.* Callers hand in a mutation as a
 * function rather than fetching state, computing a change and asking for it to
 * be saved. That difference is what makes the retry below correct: when a
 * conditional write loses the race, the mutation is re-run against the newly
 * downloaded state, so the other device's change survives and ours applies on
 * top of it. Re-uploading a locally computed result would silently erase theirs.
 *
 * *A cache that never feeds a write.* Reads may be served from a short-lived
 * cache; a mutation always begins with a fresh fetch. A cached read is a
 * slightly old answer to a question, which is fine. A cached write baseline is
 * a lost update.
 */

export interface WorkspaceOptions {
  readonly gateway: SyncFileGateway;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly clientId: string;
  readonly cacheTtlMs: number;
  readonly writable: boolean;
  /** Attempts before a contended write gives up. */
  readonly maxWriteAttempts?: number;
}

export interface WorkspaceView {
  readonly state: AppState;
  readonly snapshot: SyncSnapshot;
  readonly diagnostics: ReadDiagnostics;
  /** Whether this view came from the cache rather than the network. */
  readonly fromCache: boolean;
}

export type Mutation<TResult> = (
  state: AppState,
  context: ReducerContext,
) => MutationResult<AppState> & TResult;

export interface MutationOutcome<TResult> {
  readonly result: TResult;
  readonly commit: CommitResult;
  readonly attempts: number;
}

const DEFAULT_MAX_WRITE_ATTEMPTS = 4;

export class Workspace {
  readonly #gateway: SyncFileGateway;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #logger: Logger;
  readonly #clientId: string;
  readonly #cacheTtlMs: number;
  readonly #writable: boolean;
  readonly #maxWriteAttempts: number;

  #cache: { view: WorkspaceView; expiresAt: number } | null = null;
  /**
   * Serialises mutations within this process.
   *
   * Two concurrent tool calls would otherwise read the same revision, and one
   * would always lose the conditional write and have to retry. Queueing turns a
   * guaranteed retry into a cheap await.
   */
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceOptions) {
    this.#gateway = options.gateway;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#logger = options.logger.child({ component: 'workspace' });
    this.#clientId = options.clientId;
    this.#cacheTtlMs = options.cacheTtlMs;
    this.#writable = options.writable;
    this.#maxWriteAttempts = options.maxWriteAttempts ?? DEFAULT_MAX_WRITE_ATTEMPTS;
  }

  /** Reads the workspace, possibly from cache. */
  async read(options: { forceRefresh?: boolean } = {}): Promise<WorkspaceView> {
    if (options.forceRefresh !== true) {
      const cached = this.#cache;
      if (cached !== null && cached.expiresAt > this.#clock.now()) {
        return { ...cached.view, fromCache: true };
      }
    }

    const { snapshot, diagnostics } = await this.#gateway.read();
    const view: WorkspaceView = {
      state: snapshot.state,
      snapshot,
      diagnostics,
      fromCache: false,
    };

    if (this.#cacheTtlMs > 0) {
      this.#cache = { view, expiresAt: this.#clock.now() + this.#cacheTtlMs };
    }
    return view;
  }

  /** Drops any cached read. */
  invalidate(): void {
    this.#cache = null;
  }

  /**
   * Applies a mutation and commits it.
   *
   * `operationName` appears in the error when the server is read-only, so the
   * user is told which action was refused rather than just that something was.
   */
  async mutate<TResult>(
    operationName: string,
    mutation: Mutation<TResult>,
  ): Promise<MutationOutcome<TResult>> {
    if (!this.#writable) {
      throw new ReadOnlyModeError(operationName);
    }
    return this.#enqueue(() => this.#mutateNow(operationName, mutation));
  }

  async #mutateNow<TResult>(
    operationName: string,
    mutation: Mutation<TResult>,
  ): Promise<MutationOutcome<TResult>> {
    let lastConflict: ConcurrencyError | null = null;

    for (let attempt = 1; attempt <= this.#maxWriteAttempts; attempt += 1) {
      // Always fresh. A cached baseline is a lost update.
      const view = await this.read({ forceRefresh: true });
      const context = this.#buildContext(view.snapshot);

      // Domain errors (not found, validation) escape immediately: re-reading
      // and retrying cannot turn an invalid request into a valid one.
      const outcome = mutation(view.state, context);

      try {
        const commit = await this.#gateway.commit({
          base: view.snapshot,
          nextState: outcome.state,
          operations: outcome.operations,
        });
        this.#adoptCommittedState(view, outcome.state, commit);
        this.#logger.debug('Committed mutation', {
          operationName,
          attempt,
          syncVersion: commit.syncVersion,
          operations: commit.operationCount,
        });
        return { result: outcome, commit, attempts: attempt };
      } catch (error) {
        if (!(error instanceof ConcurrencyError)) {
          throw error;
        }
        lastConflict = error;
        this.invalidate();
        this.#logger.info('Another device wrote first; re-applying on fresh state', {
          operationName,
          attempt,
        });
        // Small jittered backoff: two peers retrying in lockstep would
        // otherwise keep colliding at the same instant.
        await sleep(50 * attempt + Math.floor(Math.random() * 50));
      }
    }

    throw new ConcurrencyError(
      `Gave up on "${operationName}" after ${this.#maxWriteAttempts} attempts: another ` +
        'device kept writing to the sync file first. Nothing was changed. ' +
        'Try again in a moment.',
      { cause: lastConflict },
    );
  }

  /**
   * Makes the just-committed state the cached view.
   *
   * Two reasons, and the second is the important one.
   *
   * It saves a round trip: a caller that reports what it wrote would otherwise
   * re-download 200 KB to read back something we already hold.
   *
   * And it keeps the answer *true to this write*. Re-reading could pick up a
   * change another device made in the intervening milliseconds, and reporting
   * that as the outcome of this edit would be a quiet lie — the user asked what
   * their edit did, not what the file happens to contain now.
   *
   * The snapshot is rebuilt from what the commit actually returned rather than
   * guessed at, so the cached revision is the one a subsequent conditional
   * write must match.
   */
  #adoptCommittedState(
    base: WorkspaceView,
    committedState: AppState,
    commit: CommitResult,
  ): void {
    if (this.#cacheTtlMs <= 0) {
      this.#cache = null;
      return;
    }

    this.#cache = {
      view: {
        state: committedState,
        snapshot: {
          ...base.snapshot,
          state: committedState,
          syncVersion: commit.syncVersion,
          vectorClock: commit.vectorClock,
          clientId: commit.clientId,
          lastModified: commit.lastModified,
          revisions: { ...base.snapshot.revisions, commitPoint: commit.rev },
        },
        diagnostics: base.diagnostics,
        fromCache: false,
      },
      expiresAt: this.#clock.now() + this.#cacheTtlMs,
    };
  }

  /**
   * Builds the reducer context for one attempt.
   *
   * A fresh {@link OperationFactory} per attempt, seeded from the clock we just
   * downloaded — never reused across attempts. Reusing one would stamp the
   * retry with a clock derived from state that has since been superseded,
   * making our own write look concurrent with the write that beat us instead of
   * causally after it.
   */
  #buildContext(snapshot: SyncSnapshot): ReducerContext {
    const now = this.#clock.now();
    return {
      now,
      today: this.#clock.today(),
      ids: this.#ids,
      operations: new OperationFactory(
        snapshot.vectorClock,
        this.#clientId,
        snapshot.schemaVersion,
        this.#ids,
        () => now,
      ),
    };
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writeQueue.then(task, task);
    // Keep the chain alive regardless of outcome; the caller owns the result.
    this.#writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
