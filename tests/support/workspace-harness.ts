import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../../src/application/workspace.js';
import { SyncFileGateway } from '../../src/infrastructure/sync/sync-file-gateway.js';
import { encodeSyncFile } from '../../src/infrastructure/codec/sync-file-codec.js';
import { SYNC_FILE_LIMITS, SYNC_FILE_NAMES } from '../../src/domain/sync/sync-file.js';
import type { AppState } from '../../src/domain/model/app-state.js';
import { InMemoryFileStore } from './in-memory-file-store.js';
import {
  FakeClock,
  FakeIdGenerator,
  FIXED_NOW,
  FIXED_TODAY,
  silentLogger,
} from './fakes.js';

/**
 * Wires the real gateway and workspace over an in-memory store.
 *
 * Everything below the network is genuine: the codec, the layout detection, the
 * operation-log replay, the conditional-write retry. Only the transport is
 * substituted, so an integration test proves the behaviour that actually ships.
 */

export const FIXTURE_RAW = readFileSync(
  fileURLToPath(new URL('../fixtures/sync-data.sample.json', import.meta.url)),
  'utf8',
);

export interface HarnessOptions {
  readonly writable?: boolean;
  readonly cacheTtlMs?: number;
  readonly encryptionPassword?: string;
  readonly compressUploads?: boolean;
  readonly clientId?: string;
  readonly maxWriteAttempts?: number;
}

export interface Harness {
  readonly store: InMemoryFileStore;
  readonly workspace: Workspace;
  readonly gateway: SyncFileGateway;
  readonly clock: FakeClock;
}

export const createHarness = (
  seed: (store: InMemoryFileStore) => void,
  options: HarnessOptions = {},
): Harness => {
  const store = new InMemoryFileStore();
  seed(store);

  const clock = new FakeClock(FIXED_NOW, FIXED_TODAY);
  const logger = silentLogger();

  const gateway = new SyncFileGateway({
    store,
    clock,
    logger,
    ...(options.encryptionPassword === undefined
      ? {}
      : { encryptionPassword: options.encryptionPassword }),
    ...(options.compressUploads === undefined
      ? {}
      : { compressUploads: options.compressUploads }),
  });

  const workspace = new Workspace({
    gateway,
    clock,
    ids: new FakeIdGenerator('mcp'),
    logger,
    clientId: options.clientId ?? 'M_TESTCLIENT',
    cacheTtlMs: options.cacheTtlMs ?? 0,
    writable: options.writable ?? true,
    ...(options.maxWriteAttempts === undefined
      ? {}
      : { maxWriteAttempts: options.maxWriteAttempts }),
  });

  return { store, workspace, gateway, clock };
};

/** Seeds the single-file layout from the real-world fixture. */
export const seedSingleFile = (store: InMemoryFileStore): void => {
  store.seed(SYNC_FILE_NAMES.single, FIXTURE_RAW);
};

/** Reads back whatever envelope currently sits at a path. */
export const readEnvelope = async <T>(
  store: InMemoryFileStore,
  path: string,
  encryptionPassword?: string,
): Promise<T> => {
  const raw = store.contents(path);
  if (raw === undefined) {
    throw new Error(`No file at ${path}`);
  }
  const { decodeSyncFile } =
    await import('../../src/infrastructure/codec/sync-file-codec.js');
  const decoded = await decodeSyncFile<T>(raw, {
    ...(encryptionPassword === undefined ? {} : { encryptionPassword }),
    expectEncrypted: encryptionPassword !== undefined,
  });
  return decoded.data;
};

export interface SplitSeedOptions {
  /** Operations placed in the ops file but not yet folded into the snapshot. */
  readonly pendingOps?: readonly Record<string, unknown>[];
  /** Ops-file syncVersion. Defaults to the snapshot's, meaning "current". */
  readonly opsSyncVersion?: number;
  /** Filename the snapshot pointer names. Defaults to `sync-state.json`. */
  readonly stateFileName?: string;
}

/**
 * Seeds the split layout, deriving both files from the same fixture state so a
 * split-layout test and a single-file test are comparing like with like.
 */
export const seedSplitFiles = async (
  store: InMemoryFileStore,
  state: AppState,
  options: SplitSeedOptions = {},
): Promise<void> => {
  const snapshotSyncVersion = 10;
  const opsSyncVersion = options.opsSyncVersion ?? snapshotSyncVersion;
  const stateFileName = options.stateFileName ?? SYNC_FILE_NAMES.state;

  const stateEnvelope = {
    version: SYNC_FILE_LIMITS.splitFileVersion,
    syncVersion: snapshotSyncVersion,
    schemaVersion: 4,
    vectorClock: { OTHER_DEVICE: 5 },
    lastModified: FIXED_NOW - 100_000,
    clientId: 'OTHER_DEVICE',
    state,
  };

  const opsEnvelope = {
    version: SYNC_FILE_LIMITS.splitFileVersion,
    syncVersion: opsSyncVersion,
    schemaVersion: 4,
    vectorClock: { OTHER_DEVICE: 5 + (options.pendingOps?.length ?? 0) },
    lastModified: FIXED_NOW - 50_000,
    clientId: 'OTHER_DEVICE',
    recentOps: options.pendingOps ?? [],
    snapshotRef: {
      syncVersion: snapshotSyncVersion,
      vectorClock: { OTHER_DEVICE: 5 },
      file: stateFileName,
    },
  };

  store.seed(
    stateFileName,
    await encodeSyncFile(stateEnvelope, {
      modelVersion: SYNC_FILE_LIMITS.splitFileVersion,
      compress: false,
    }),
  );
  store.seed(
    SYNC_FILE_NAMES.ops,
    await encodeSyncFile(opsEnvelope, {
      modelVersion: SYNC_FILE_LIMITS.splitFileVersion,
      compress: false,
    }),
  );
};
