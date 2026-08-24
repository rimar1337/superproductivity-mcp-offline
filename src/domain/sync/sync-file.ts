import type { AppState } from '../model/app-state.js';
import type { CompactOperation } from './operation.js';
import type { VectorClock } from './vector-clock.js';

/**
 * The two remote layouts Super Productivity can leave in a sync folder, and the
 * envelope types for each.
 *
 * Which one a folder uses depends on when it was set up and whether "Surgical
 * sync" was enabled, so this server detects it at runtime rather than being
 * told. Both are supported; neither is migrated by us.
 *
 * @see `packages/sync-providers/src/file-based-sync-data.ts` upstream
 */

/** Remote filenames. These are a permanent contract between client versions. */
export const SYNC_FILE_NAMES = {
  /** Single-file layout: everything in one document. */
  single: 'sync-data.json',
  singleBackup: 'sync-data.json.bak',
  /** Split layout: the small, always-written commit point. */
  ops: 'sync-ops.json',
  opsBackup: 'sync-ops.json.bak',
  /** Split layout: the heavy snapshot, rewritten only on compaction. */
  state: 'sync-state.json',
  stateBackup: 'sync-state.json.bak',
  /** Prefix of immutable per-compaction snapshots, `sync-state__<sv>__<rnd>.json`. */
  generationalStatePrefix: 'sync-state__',
} as const;

export const SYNC_FILE_LIMITS = {
  /** Ops retained before Super Productivity compacts. We never exceed it. */
  maxRecentOps: 2000,
  /** Envelope version of the single-file layout. */
  singleFileVersion: 2,
  /** Envelope version of the split layout. */
  splitFileVersion: 3,
} as const;

/** The single-file envelope (`sync-data.json`, `version: 2`). */
export interface SingleFileSyncEnvelope {
  version: 2;
  syncVersion: number;
  schemaVersion: number;
  vectorClock: VectorClock;
  lastModified: number;
  clientId: string;
  state: AppState;
  archiveYoung?: unknown;
  archiveOld?: unknown;
  recentOps: CompactOperation[];
  oldestOpSyncVersion?: number;
  [unmodelledField: string]: unknown;
}

/** Pointer from the split ops file to the snapshot it was built against. */
export interface SnapshotRef {
  syncVersion: number;
  vectorClock: VectorClock;
  rev?: string;
  /** Immutable snapshot filename. Absent on files written by older clients. */
  file?: string;
}

/** The split ops file (`sync-ops.json`, `version: 3`) — the commit point. */
export interface SplitOpsEnvelope {
  version: 3;
  syncVersion: number;
  schemaVersion: number;
  vectorClock: VectorClock;
  lastModified: number;
  clientId: string;
  recentOps: CompactOperation[];
  oldestOpSyncVersion?: number;
  snapshotRef: SnapshotRef;
  migration?: { status: 'pending'; legacyRev: string };
  [unmodelledField: string]: unknown;
}

/** The split snapshot file (`sync-state.json`, `version: 3`). */
export interface SplitStateEnvelope {
  version: 3;
  syncVersion: number;
  schemaVersion: number;
  vectorClock: VectorClock;
  lastModified: number;
  clientId: string;
  state: AppState;
  archiveYoung?: unknown;
  archiveOld?: unknown;
  [unmodelledField: string]: unknown;
}

/**
 * The tombstone written over `sync-data.json` after a one-way migration to the
 * split layout.
 *
 * Recognising it is what turns "this file is unreadable garbage" into "your
 * folder moved to the split format, and here is where the real data lives".
 */
export interface SplitTombstone {
  version: 3;
  format: 'split';
  migratedAt: number;
  note: string;
}

export const SPLIT_TOMBSTONE_FORMAT = 'split';

/** Which layout a sync folder is using. */
export const SyncLayout = {
  Single: 'SINGLE_FILE',
  Split: 'SPLIT_FILE',
} as const;

export type SyncLayout = (typeof SyncLayout)[keyof typeof SyncLayout];

/**
 * A complete, decoded read of a sync folder, normalised across both layouts.
 *
 * `revisions` carries the ETags that made this snapshot, and they are what the
 * subsequent conditional write is checked against. Bundling them with the data
 * rather than re-fetching later is what closes the read-modify-write race: the
 * revision we validate against is provably the revision we read.
 */
export interface SyncSnapshot {
  readonly layout: SyncLayout;
  readonly state: AppState;
  readonly syncVersion: number;
  readonly schemaVersion: number;
  readonly vectorClock: VectorClock;
  readonly clientId: string;
  readonly lastModified: number;
  readonly recentOps: readonly CompactOperation[];
  readonly archiveYoung: unknown;
  readonly archiveOld: unknown;
  /** Present only for the split layout. */
  readonly snapshotRef: SnapshotRef | undefined;
  /** Fields of the envelope this version does not model, preserved verbatim. */
  readonly unmodelledEnvelopeFields: Readonly<Record<string, unknown>>;
  readonly revisions: SyncRevisions;
}

/** ETags of the files that produced a {@link SyncSnapshot}. */
export interface SyncRevisions {
  /** `sync-data.json` (single) or `sync-ops.json` (split). The commit point. */
  readonly commitPoint: string | null;
  /** `sync-state.json`, split layout only. */
  readonly state?: string | null;
  /** Filename the snapshot was actually read from, for split layouts. */
  readonly stateFileName?: string;
}
