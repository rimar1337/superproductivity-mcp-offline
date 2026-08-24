import {
  SyncFormatError,
  UnsafeOperationError,
  RemoteFileNotFoundError,
} from '../../domain/errors.js';
import type { AppState } from '../../domain/model/app-state.js';
import type { Clock, FileStore, Logger } from '../../domain/ports.js';
import type { CompactOperation } from '../../domain/sync/operation.js';
import {
  type SingleFileSyncEnvelope,
  type SplitOpsEnvelope,
  type SplitStateEnvelope,
  SPLIT_TOMBSTONE_FORMAT,
  SYNC_FILE_LIMITS,
  SYNC_FILE_NAMES,
  SyncLayout,
  type SyncSnapshot,
} from '../../domain/sync/sync-file.js';
import { mergeVectorClocks, type VectorClock } from '../../domain/sync/vector-clock.js';
import { decodeSyncFile, encodeSyncFile } from '../codec/sync-file-codec.js';
import { replayOperations } from './operation-replay.js';

/**
 * Reads and writes a sync folder, in whichever layout it happens to use.
 *
 * Super Productivity has shipped two remote layouts:
 *
 * - **Single file** — `sync-data.json` holds the snapshot, the archives and the
 *   operation log together. The default, and what most folders use.
 * - **Split** — `sync-ops.json` is the small commit point and `sync-state.json`
 *   the heavy snapshot, rewritten only on compaction. Opt-in ("Surgical sync").
 *
 * The layout is *detected*, never configured: a folder can be migrated by the
 * desktop app at any time, and asking the user to notice and update a setting
 * would turn a routine upgrade into a broken integration.
 *
 * Writing follows upstream's own procedure step for step, because the desktop
 * app's recovery paths assume it:
 *
 * 1. Copy the current remote content to `.bak` before overwriting anything, so
 *    an interrupted write leaves something recoverable.
 * 2. Write the primary file **conditionally**, on the revision we read.
 *
 * Step 2 is never downgraded to an unconditional write. Forcing a write is the
 * single action that can destroy another device's changes with no trace, and no
 * failure this class can encounter is worth that.
 */

export interface SyncFileGatewayOptions {
  readonly store: FileStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly encryptionPassword?: string | undefined;
  /** Whether to gzip what we write. Independent of what we can read. */
  readonly compressUploads?: boolean;
}

export interface CommitInput {
  /** The snapshot the mutation was computed against. Supplies the preconditions. */
  readonly base: SyncSnapshot;
  readonly nextState: AppState;
  readonly operations: readonly CompactOperation[];
}

export interface CommitResult {
  readonly syncVersion: number;
  readonly rev: string | null;
  readonly operationCount: number;
  /** The causal clock now on the remote. */
  readonly vectorClock: VectorClock;
  /** The client id recorded as the last writer. */
  readonly clientId: string;
  readonly lastModified: number;
}

/** A read that may be based on a partially-replayed operation log. */
export interface ReadDiagnostics {
  readonly replayedOperations: number;
  readonly skippedOperations: number;
  readonly unhandledActionCodes: readonly string[];
}

export interface SyncRead {
  readonly snapshot: SyncSnapshot;
  readonly diagnostics: ReadDiagnostics;
}

const NO_REPLAY: ReadDiagnostics = {
  replayedOperations: 0,
  skippedOperations: 0,
  unhandledActionCodes: [],
};

export class SyncFileGateway {
  readonly #store: FileStore;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #encryptionPassword: string | undefined;
  readonly #compressUploads: boolean;

  constructor(options: SyncFileGatewayOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#logger = options.logger.child({ component: 'sync-gateway' });
    this.#encryptionPassword = options.encryptionPassword;
    this.#compressUploads = options.compressUploads ?? false;
  }

  async read(): Promise<SyncRead> {
    const opsFile = await this.#tryRead(SYNC_FILE_NAMES.ops);
    return opsFile === null ? this.#readSingle() : this.#readSplit(opsFile);
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return input.base.layout === SyncLayout.Single
      ? this.#commitSingle(input)
      : this.#commitSplit(input);
  }

  // ─── single-file layout ────────────────────────────────────────────────────

  async #readSingle(): Promise<SyncRead> {
    const file = await this.#store.read(SYNC_FILE_NAMES.single);
    const decoded = await this.#decode<SingleFileSyncEnvelope>(
      file.content,
      SYNC_FILE_NAMES.single,
    );

    this.#assertNotTombstone(decoded);
    if (decoded.version !== SYNC_FILE_LIMITS.singleFileVersion) {
      throw new SyncFormatError(
        `Unsupported ${SYNC_FILE_NAMES.single} version ${String(decoded.version)}. ` +
          'Update this server, or open Super Productivity to migrate the folder.',
      );
    }

    const {
      version: _version,
      syncVersion,
      schemaVersion,
      vectorClock,
      lastModified,
      clientId,
      state,
      archiveYoung,
      archiveOld,
      recentOps,
      oldestOpSyncVersion: _oldest,
      ...unmodelled
    } = decoded;

    return {
      snapshot: {
        layout: SyncLayout.Single,
        state,
        syncVersion,
        schemaVersion,
        vectorClock,
        clientId,
        lastModified,
        recentOps: recentOps ?? [],
        archiveYoung,
        archiveOld,
        snapshotRef: undefined,
        unmodelledEnvelopeFields: unmodelled,
        revisions: { commitPoint: file.rev },
      },
      diagnostics: NO_REPLAY,
    };
  }

  async #commitSingle(input: CommitInput): Promise<CommitResult> {
    const { base } = input;
    const syncVersion = base.syncVersion + 1;
    const recentOps = mergeRecentOps(base.recentOps, input.operations, syncVersion);

    const vectorClock = mergeOperationClocks(base.vectorClock, input.operations);
    const clientId = currentClientId(input.operations, base.clientId);
    const lastModified = this.#clock.now();

    const envelope: SingleFileSyncEnvelope = {
      ...base.unmodelledEnvelopeFields,
      version: SYNC_FILE_LIMITS.singleFileVersion,
      syncVersion,
      schemaVersion: base.schemaVersion,
      vectorClock,
      lastModified,
      clientId,
      state: input.nextState,
      ...(base.archiveYoung === undefined ? {} : { archiveYoung: base.archiveYoung }),
      ...(base.archiveOld === undefined ? {} : { archiveOld: base.archiveOld }),
      recentOps,
      ...(recentOps[0]?.sv === undefined ? {} : { oldestOpSyncVersion: recentOps[0].sv }),
    };

    await this.#backupBeforeOverwrite(
      SYNC_FILE_NAMES.single,
      SYNC_FILE_NAMES.singleBackup,
    );

    const body = await this.#encode(envelope, SYNC_FILE_LIMITS.singleFileVersion);
    const { rev } = await this.#store.write(
      SYNC_FILE_NAMES.single,
      body,
      preconditionFor(base.revisions.commitPoint),
    );

    return {
      syncVersion,
      rev,
      operationCount: input.operations.length,
      vectorClock,
      clientId,
      lastModified,
    };
  }

  // ─── split layout ──────────────────────────────────────────────────────────

  async #readSplit(opsFile: { content: string; rev: string | null }): Promise<SyncRead> {
    const ops = await this.#decode<SplitOpsEnvelope>(
      opsFile.content,
      SYNC_FILE_NAMES.ops,
    );

    if (ops.migration?.status === 'pending') {
      throw new UnsafeOperationError(
        'The sync folder is mid-migration to the split format.',
        'Open Super Productivity and let it finish syncing, then try again.',
      );
    }

    // Prefer the immutable per-compaction snapshot the ops file points at. The
    // fixed `sync-state.json` is clobberable by a concurrent compactor, so the
    // pointer is the only name guaranteed to still hold the right snapshot.
    const stateFileName = ops.snapshotRef?.file ?? SYNC_FILE_NAMES.state;
    const stateFile = await this.#store.read(stateFileName);
    const stateEnvelope = await this.#decode<SplitStateEnvelope>(
      stateFile.content,
      stateFileName,
    );

    if (stateEnvelope.version !== SYNC_FILE_LIMITS.splitFileVersion) {
      throw new SyncFormatError(
        `Unsupported ${stateFileName} version ${String(stateEnvelope.version)}.`,
      );
    }

    // The snapshot is only current when the ops file has not advanced past it.
    // Otherwise the operations in between are what make the view accurate.
    const isSnapshotCurrent = ops.syncVersion === ops.snapshotRef?.syncVersion;
    const pendingOps = isSnapshotCurrent
      ? []
      : (ops.recentOps ?? []).filter(
          (op) => (op.sv ?? 0) > (ops.snapshotRef?.syncVersion ?? 0),
        );

    const replay = replayOperations(stateEnvelope.state, pendingOps, this.#clock.today());

    if (replay.unhandledActionCodes.length > 0) {
      this.#logger.warn('Some operations could not be replayed onto the snapshot', {
        unhandledActionCodes: replay.unhandledActionCodes,
        pendingOperations: pendingOps.length,
      });
    }

    const {
      version: _version,
      syncVersion,
      schemaVersion,
      vectorClock,
      lastModified,
      clientId,
      recentOps,
      snapshotRef,
      oldestOpSyncVersion: _oldest,
      migration: _migration,
      ...unmodelled
    } = ops;

    return {
      snapshot: {
        layout: SyncLayout.Split,
        state: replay.state,
        syncVersion,
        schemaVersion,
        vectorClock,
        clientId,
        lastModified,
        recentOps: recentOps ?? [],
        archiveYoung: stateEnvelope.archiveYoung,
        archiveOld: stateEnvelope.archiveOld,
        snapshotRef,
        unmodelledEnvelopeFields: unmodelled,
        revisions: {
          commitPoint: opsFile.rev,
          state: stateFile.rev,
          stateFileName,
        },
      },
      diagnostics: {
        replayedOperations: replay.appliedCount,
        skippedOperations: replay.ignoredCount,
        unhandledActionCodes: replay.unhandledActionCodes,
      },
    };
  }

  /**
   * Appends operations to the split commit point.
   *
   * `sync-state.json` is deliberately left alone. Rewriting it means compaction,
   * and compaction means declaring a new authoritative snapshot — which this
   * server cannot honestly do, because it replays only the operations it
   * understands. Publishing an approximate snapshot as authoritative would
   * discard whatever it failed to replay, permanently and silently.
   *
   * Appending is not a workaround for that: it is exactly what Super
   * Productivity does between compactions.
   */
  async #commitSplit(input: CommitInput): Promise<CommitResult> {
    const { base } = input;
    if (base.snapshotRef === undefined) {
      throw new SyncFormatError(
        `${SYNC_FILE_NAMES.ops} has no snapshot reference; the folder is not in a ` +
          'state this server can safely write to.',
      );
    }

    const syncVersion = base.syncVersion + 1;
    const recentOps = mergeRecentOps(base.recentOps, input.operations, syncVersion);

    if (base.recentOps.length + input.operations.length > SYNC_FILE_LIMITS.maxRecentOps) {
      throw new UnsafeOperationError(
        `The operation log has reached ${SYNC_FILE_LIMITS.maxRecentOps} entries and ` +
          'needs to be compacted before it can accept more.',
        'Open Super Productivity and let it sync once. It will compact the log, ' +
          'after which this server can write again.',
      );
    }

    const vectorClock = mergeOperationClocks(base.vectorClock, input.operations);
    const clientId = currentClientId(input.operations, base.clientId);
    const lastModified = this.#clock.now();

    const envelope: SplitOpsEnvelope = {
      ...base.unmodelledEnvelopeFields,
      version: SYNC_FILE_LIMITS.splitFileVersion,
      syncVersion,
      schemaVersion: base.schemaVersion,
      vectorClock,
      lastModified,
      clientId,
      recentOps,
      ...(recentOps[0]?.sv === undefined ? {} : { oldestOpSyncVersion: recentOps[0].sv }),
      snapshotRef: base.snapshotRef,
    };

    await this.#backupBeforeOverwrite(SYNC_FILE_NAMES.ops, SYNC_FILE_NAMES.opsBackup);

    const body = await this.#encode(envelope, SYNC_FILE_LIMITS.splitFileVersion);
    const { rev } = await this.#store.write(
      SYNC_FILE_NAMES.ops,
      body,
      preconditionFor(base.revisions.commitPoint),
    );

    return {
      syncVersion,
      rev,
      operationCount: input.operations.length,
      vectorClock,
      clientId,
      lastModified,
    };
  }

  // ─── shared ────────────────────────────────────────────────────────────────

  /**
   * Copies the current remote content aside before it is overwritten.
   *
   * Best-effort on purpose. A backup that cannot be written is worth a warning,
   * but refusing the user's edit because a *secondary* copy failed trades a
   * small risk for a certain failure.
   */
  async #backupBeforeOverwrite(source: string, backup: string): Promise<void> {
    try {
      const current = await this.#store.read(source);
      await this.#store.write(backup, current.content, { kind: 'overwrite' });
    } catch (error) {
      this.#logger.warn('Could not refresh the backup copy before writing', {
        source,
        backup,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #tryRead(path: string): Promise<{ content: string; rev: string | null } | null> {
    try {
      return await this.#store.read(path);
    } catch (error) {
      if (error instanceof RemoteFileNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async #decode<T>(raw: string, path: string): Promise<T> {
    try {
      const decoded = await decodeSyncFile<T>(raw, {
        encryptionPassword: this.#encryptionPassword,
        expectEncrypted: this.#encryptionPassword !== undefined,
      });
      return decoded.data;
    } catch (error) {
      if (error instanceof SyncFormatError) {
        throw new SyncFormatError(`${path}: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  async #encode(envelope: unknown, modelVersion: number): Promise<string> {
    return encodeSyncFile(envelope, {
      modelVersion,
      compress: this.#compressUploads,
      encryptionPassword: this.#encryptionPassword,
    });
  }

  /**
   * Recognises the tombstone the desktop app writes over `sync-data.json` after
   * migrating a folder to the split layout.
   *
   * Without this check the tombstone parses as a nonsensical envelope and the
   * error blames the file, when the real answer is "the data moved, and this
   * server should have looked at `sync-ops.json`".
   */
  #assertNotTombstone(decoded: { version?: unknown; format?: unknown }): void {
    if (
      decoded.version === SYNC_FILE_LIMITS.splitFileVersion &&
      decoded.format === SPLIT_TOMBSTONE_FORMAT
    ) {
      throw new SyncFormatError(
        `${SYNC_FILE_NAMES.single} is a migration tombstone: this folder now uses the ` +
          `split format, but ${SYNC_FILE_NAMES.ops} could not be read. ` +
          'Open Super Productivity and let it sync once to restore the folder.',
      );
    }
  }
}

/**
 * Appends new operations to the retained log, tagged with this upload's
 * `syncVersion`, and trims to the cap from the oldest end.
 */
const mergeRecentOps = (
  existing: readonly CompactOperation[],
  added: readonly CompactOperation[],
  syncVersion: number,
): CompactOperation[] => {
  const tagged = added.map((op) => ({ ...op, sv: syncVersion }));
  return [...existing, ...tagged].slice(-SYNC_FILE_LIMITS.maxRecentOps);
};

/** Folds every operation's clock into the file's, producing a dominating clock. */
const mergeOperationClocks = (
  base: VectorClock,
  operations: readonly CompactOperation[],
): VectorClock =>
  operations.reduce<VectorClock>((clock, op) => mergeVectorClocks(clock, op.v), base);

const currentClientId = (
  operations: readonly CompactOperation[],
  fallback: string,
): string => operations[0]?.c ?? fallback;

/**
 * Turns a revision into a write precondition.
 *
 * A server that gave us no usable validator leaves only `create`, which fails
 * if the file exists — and that failure is the correct outcome. Writing
 * unconditionally because we cannot check is how a concurrent edit disappears.
 */
const preconditionFor = (
  rev: string | null,
): { kind: 'match'; rev: string } | { kind: 'create' } =>
  rev === null ? { kind: 'create' } : { kind: 'match', rev };
