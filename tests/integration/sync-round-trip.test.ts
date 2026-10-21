import { describe, expect, it } from 'vitest';
import { addTask, updateTask } from '../../src/domain/reducers/task.js';
import {
  SYNC_FILE_LIMITS,
  SYNC_FILE_NAMES,
  SyncLayout,
  type SingleFileSyncEnvelope,
  type SplitOpsEnvelope,
} from '../../src/domain/sync/sync-file.js';
import {
  ConcurrencyError,
  ReadOnlyModeError,
  SyncFormatError,
  UnsafeOperationError,
} from '../../src/domain/errors.js';
import { decodeSyncFile, encodeSyncFile } from '../../src/infrastructure/codec/sync-file-codec.js';
import {
  createHarness,
  FIXTURE_RAW,
  readEnvelope,
  seedSingleFile,
  seedSplitFiles,
} from '../support/workspace-harness.js';
import { FIXED_NOW } from '../support/fakes.js';

/**
 * The whole sync stack over an in-memory store: real codec, real layout
 * detection, real conditional writes, real retry. Only the transport is fake.
 */

describe('single-file layout', () => {
  it('reads the fixture and reports the layout', async () => {
    const { workspace } = createHarness(seedSingleFile);
    const view = await workspace.read();

    expect(view.snapshot.layout).toBe(SyncLayout.Single);
    expect(view.snapshot.syncVersion).toBe(114);
    expect(view.snapshot.schemaVersion).toBe(4);
    expect(view.snapshot.recentOps).toHaveLength(344);
    expect(view.state.task.ids.length).toBeGreaterThan(0);
  });

  it('writes a task back in a shape Super Productivity can read', async () => {
    const { store, workspace } = createHarness(seedSingleFile);

    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Written by the MCP server' }, ctx),
    );

    const envelope = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    expect(envelope.version).toBe(2);
    expect(envelope.syncVersion).toBe(115);
    expect(envelope.schemaVersion).toBe(4);
    expect(envelope.clientId).toBe('M_TESTCLIENT');
  });

  it('advances the vector clock so other devices accept the write', async () => {
    // A write whose clock did not dominate the file's would be read as
    // concurrent — a conflict — rather than as the newer state.
    const { store, workspace } = createHarness(seedSingleFile);
    const before = await workspace.read();

    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Task' }, ctx),
    );

    const envelope = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    for (const [clientId, value] of Object.entries(before.snapshot.vectorClock)) {
      expect(envelope.vectorClock[clientId]).toBeGreaterThanOrEqual(value);
    }
    expect(envelope.vectorClock['M_TESTCLIENT']).toBe(1);
  });

  it('appends the operation to the log with this upload’s syncVersion', async () => {
    const { store, workspace } = createHarness(seedSingleFile);

    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Task' }, ctx),
    );

    const envelope = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    expect(envelope.recentOps).toHaveLength(345);
    const appended = envelope.recentOps.at(-1);
    expect(appended?.a).toBe('HA');
    expect(appended?.sv).toBe(115);
    expect(appended?.c).toBe('M_TESTCLIENT');
  });

  it('preserves every part of the file it does not manage', async () => {
    // This server rewrites the whole file, so anything it forgets is data the
    // user loses. Archives, config, boards and plugin data must survive.
    const { store, workspace } = createHarness(seedSingleFile);
    const before = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );

    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Task' }, ctx),
    );

    const after = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    expect(after.archiveYoung).toEqual(before.archiveYoung);
    expect(after.archiveOld).toEqual(before.archiveOld);
    expect(after.state['globalConfig']).toEqual(before.state['globalConfig']);
    expect(after.state['boards']).toEqual(before.state['boards']);
    expect(after.state['timeTracking']).toEqual(before.state['timeTracking']);
    expect(after.state['simpleCounter']).toEqual(before.state['simpleCounter']);
    expect(after.state['pluginMetadata']).toEqual(before.state['pluginMetadata']);
  });

  it('refreshes the .bak copy before overwriting the primary file', async () => {
    const { store, workspace } = createHarness(seedSingleFile);

    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Task' }, ctx),
    );

    // The backup must hold the *previous* content — that is the whole point of
    // writing it — and must be written before the primary.
    expect(store.contents(SYNC_FILE_NAMES.singleBackup)).toBe(FIXTURE_RAW);

    const writes = store.calls.filter((call) => call.method === 'write');
    expect(writes.map((call) => call.path)).toEqual([
      SYNC_FILE_NAMES.singleBackup,
      SYNC_FILE_NAMES.single,
    ]);
  });

  it('still commits when the backup copy cannot be written', async () => {
    // A failed *secondary* copy must not block the user's edit.
    const { workspace } = createHarness((s) => {
      seedSingleFile(s);
      s.failWritesFor.add(SYNC_FILE_NAMES.singleBackup);
    });

    await expect(
      workspace.mutate('add_task', (state, ctx) =>
        addTask(state, { title: 'Task' }, ctx),
      ),
    ).resolves.toMatchObject({ commit: { syncVersion: 115 } });
  });

  it('round-trips a task through a write and a fresh read', async () => {
    const { workspace } = createHarness(seedSingleFile);

    const { result } = await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Buy oat milk', timeEstimate: 900_000 }, ctx),
    );

    const view = await workspace.read({ forceRefresh: true });
    const stored = view.state.task.entities[result.task.id];
    expect(stored?.title).toBe('Buy oat milk');
    expect(stored?.timeEstimate).toBe(900_000);
  });
});

describe('concurrent writers', () => {
  it('re-applies the mutation on top of the other device’s change', async () => {
    // The central guarantee: a mutation is a function of what is on the server
    // now, so a write that loses the race is retried against the winner's
    // state rather than overwriting it.
    const { store, workspace } = createHarness(seedSingleFile);

    let interfered = false;
    store.beforeWrite = async (path) => {
      if (path !== SYNC_FILE_NAMES.single || interfered) {
        return;
      }
      interfered = true;
      // Another device commits between our read and our write.
      const current = await readEnvelope<SingleFileSyncEnvelope>(
        store,
        SYNC_FILE_NAMES.single,
      );
      const rival = {
        ...current,
        syncVersion: current.syncVersion + 1,
        clientId: 'RIVAL_DEVICE',
        vectorClock: { ...current.vectorClock, RIVAL_DEVICE: 1 },
        state: {
          ...current.state,
          tag: {
            ...current.state.tag,
            entities: {
              ...current.state.tag.entities,
              RIVAL_TAG: { id: 'RIVAL_TAG', title: 'From the rival', taskIds: [] },
            },
            ids: [...current.state.tag.ids, 'RIVAL_TAG'],
          },
        },
      };
      store.seed(
        SYNC_FILE_NAMES.single,
        await encodeSyncFile(rival, { modelVersion: 2, compress: false }),
      );
    };

    const outcome = await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Ours' }, ctx),
    );

    expect(outcome.attempts).toBe(2);

    const final = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    // Both survive: theirs because we re-read, ours because we re-applied.
    expect(final.state.tag.entities['RIVAL_TAG']).toBeDefined();
    expect(
      Object.values(final.state.task.entities).some((task) => task.title === 'Ours'),
    ).toBe(true);
    expect(final.syncVersion).toBe(116);
  });

  it('gives up cleanly, changing nothing, when contention never clears', async () => {
    const { store, workspace } = createHarness(seedSingleFile, { maxWriteAttempts: 2 });

    store.beforeWrite = async (path) => {
      if (path !== SYNC_FILE_NAMES.single) {
        return;
      }
      const current = await readEnvelope<SingleFileSyncEnvelope>(
        store,
        SYNC_FILE_NAMES.single,
      );
      store.seed(
        SYNC_FILE_NAMES.single,
        await encodeSyncFile(
          { ...current, syncVersion: current.syncVersion + 1 },
          { modelVersion: 2, compress: false },
        ),
      );
    };

    await expect(
      workspace.mutate('add_task', (state, ctx) =>
        addTask(state, { title: 'Ours' }, ctx),
      ),
    ).rejects.toThrow(ConcurrencyError);

    const final = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    expect(
      Object.values(final.state.task.entities).some((task) => task.title === 'Ours'),
    ).toBe(false);
  });

  it('serialises concurrent mutations so neither is lost', async () => {
    const { store, workspace } = createHarness(seedSingleFile);

    const [first, second] = await Promise.all([
      workspace.mutate('add_task', (state, ctx) => addTask(state, { title: 'One' }, ctx)),
      workspace.mutate('add_task', (state, ctx) => addTask(state, { title: 'Two' }, ctx)),
    ]);

    expect(first.commit.syncVersion).not.toBe(second.commit.syncVersion);

    const final = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    const titles = Object.values(final.state.task.entities).map((task) => task.title);
    expect(titles).toContain('One');
    expect(titles).toContain('Two');
  });
});

describe('read caching', () => {
  it('serves a cached read but never a cached write baseline', async () => {
    // A cached read is a slightly old answer. A cached write baseline is a
    // lost update, so mutations always refetch.
    const { store, workspace } = createHarness(seedSingleFile, { cacheTtlMs: 60_000 });

    await workspace.read();
    const cached = await workspace.read();
    expect(cached.fromCache).toBe(true);

    const readsBefore = store.calls.filter(
      (call) => call.method === 'read' && call.path === SYNC_FILE_NAMES.single,
    ).length;

    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Task' }, ctx),
    );

    const readsAfter = store.calls.filter(
      (call) => call.method === 'read' && call.path === SYNC_FILE_NAMES.single,
    ).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  });

  it('serves the just-written state without another round trip', async () => {
    // Re-downloading here would cost 200 KB to read back something we already
    // hold — and could pick up another device's later change and report it as
    // the outcome of *this* edit.
    const { store, workspace } = createHarness(seedSingleFile, { cacheTtlMs: 60_000 });
    await workspace.read();

    const { result, commit } = await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Fresh' }, ctx),
    );

    const readsBefore = store.calls.filter((call) => call.method === 'read').length;
    const view = await workspace.read();
    const readsAfter = store.calls.filter((call) => call.method === 'read').length;

    expect(readsAfter).toBe(readsBefore);
    expect(view.state.task.entities[result.task.id]?.title).toBe('Fresh');
    // The cached snapshot must carry the revision a later conditional write
    // has to match, or the next mutation would be checked against a stale one.
    expect(view.snapshot.syncVersion).toBe(commit.syncVersion);
    expect(view.snapshot.revisions.commitPoint).toBe(commit.rev);
    expect(view.snapshot.vectorClock['M_TESTCLIENT']).toBe(1);
  });

  it('drops the cache when a write loses the race, so nothing stale survives', async () => {
    const { store, workspace } = createHarness(seedSingleFile, {
      cacheTtlMs: 60_000,
      maxWriteAttempts: 1,
    });
    await workspace.read();

    store.beforeWrite = async (path) => {
      if (path !== SYNC_FILE_NAMES.single) {
        return;
      }
      const current = await readEnvelope<SingleFileSyncEnvelope>(
        store,
        SYNC_FILE_NAMES.single,
      );
      store.seed(
        SYNC_FILE_NAMES.single,
        await encodeSyncFile(
          { ...current, syncVersion: current.syncVersion + 1 },
          { modelVersion: 2, compress: false },
        ),
      );
    };

    await expect(
      workspace.mutate('add_task', (state, ctx) =>
        addTask(state, { title: 'Lost' }, ctx),
      ),
    ).rejects.toThrow(ConcurrencyError);

    expect((await workspace.read()).fromCache).toBe(false);
  });

  it('expires the cache once its TTL passes', async () => {
    const { workspace, clock } = createHarness(seedSingleFile, { cacheTtlMs: 1_000 });
    await workspace.read();
    clock.advanceTo(FIXED_NOW + 2_000);
    expect((await workspace.read()).fromCache).toBe(false);
  });
});

describe('read-only mode', () => {
  it('refuses a write before touching the network, naming the operation', async () => {
    const { store, workspace } = createHarness(seedSingleFile, { writable: false });

    await expect(
      workspace.mutate('add_task', (state, ctx) =>
        addTask(state, { title: 'Nope' }, ctx),
      ),
    ).rejects.toThrow(ReadOnlyModeError);

    expect(store.calls.filter((call) => call.method === 'write')).toHaveLength(0);
  });

  it('still reads', async () => {
    const { workspace } = createHarness(seedSingleFile, { writable: false });
    await expect(workspace.read()).resolves.toMatchObject({
      snapshot: { layout: SyncLayout.Single },
    });
  });
});

describe('encryption', () => {
  it('round-trips through an encrypted, compressed remote', async () => {
    const password = 'a strong sync password';
    const harness = createHarness(() => undefined, {
      encryptionPassword: password,
      compressUploads: true,
    });

    harness.store.seed(
      SYNC_FILE_NAMES.single,
      await encodeSyncFile(JSON.parse(FIXTURE_RAW.slice(6)), {
        modelVersion: 2,
        compress: true,
        encryptionPassword: password,
      }),
    );

    const { result } = await harness.workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Secret task' }, ctx),
    );

    // What lands on the remote must still be sealed, not quietly downgraded.
    expect(harness.store.contents(SYNC_FILE_NAMES.single)?.startsWith('pf_CE2__')).toBe(
      true,
    );
    expect(harness.store.contents(SYNC_FILE_NAMES.single)).not.toContain('Secret task');

    const view = await harness.workspace.read({ forceRefresh: true });
    expect(view.state.task.entities[result.task.id]?.title).toBe('Secret task');
  });

  it('refuses a plaintext remote when encryption is configured', async () => {
    // An attacker who can write to the remote can strip the encryption flag.
    const harness = createHarness(seedSingleFile, {
      encryptionPassword: 'a strong sync password',
    });
    await expect(harness.workspace.read()).rejects.toThrow(/plaintext/);
  });
});

describe('split layout', () => {
  const baseState = async () => {
    const envelope = JSON.parse(FIXTURE_RAW.slice(6)) as SingleFileSyncEnvelope;
    return envelope.state;
  };

  it('detects the split layout and reads through the snapshot pointer', async () => {
    const state = await baseState();
    const { workspace } = createHarness(() => undefined);
    const harness = createHarness(() => undefined);
    await seedSplitFiles(harness.store, state);

    const view = await harness.workspace.read();
    expect(view.snapshot.layout).toBe(SyncLayout.Split);
    expect(view.snapshot.state.task.ids).toEqual(state.task.ids);
    void workspace;
  });

  it('replays operations the snapshot has not absorbed yet', async () => {
    // Between compactions the snapshot lags by up to 2000 operations. Reading
    // it alone would show a view that is potentially weeks out of date.
    const state = await baseState();
    const harness = createHarness(() => undefined);

    await seedSplitFiles(harness.store, state, {
      opsSyncVersion: 11,
      pendingOps: [
        {
          id: 'op-1',
          a: 'HA',
          o: 'CRT',
          e: 'TASK',
          d: 'replayed-task',
          ds: ['replayed-task'],
          c: 'OTHER_DEVICE',
          v: { OTHER_DEVICE: 6 },
          t: FIXED_NOW - 10_000,
          s: 4,
          sv: 11,
          p: {
            actionPayload: {
              task: {
                id: 'replayed-task',
                title: 'Added on another device',
                projectId: 'INBOX_PROJECT',
                isDone: false,
                tagIds: [],
                subTaskIds: [],
                timeSpentOnDay: {},
                timeSpent: 0,
                timeEstimate: 0,
                created: FIXED_NOW - 10_000,
                attachments: [],
              },
              workContextId: 'INBOX_PROJECT',
              workContextType: 'PROJECT',
              isAddToBacklog: false,
              isAddToBottom: true,
            },
            entityChanges: [],
          },
        },
      ],
    });

    const view = await harness.workspace.read();
    expect(view.state.task.entities['replayed-task']?.title).toBe(
      'Added on another device',
    );
    expect(view.diagnostics.replayedOperations).toBe(1);
    expect(view.diagnostics.unhandledActionCodes).toEqual([]);
  });

  it('reports operations it could not replay instead of hiding them', async () => {
    const state = await baseState();
    const harness = createHarness(() => undefined);

    await seedSplitFiles(harness.store, state, {
      opsSyncVersion: 11,
      pendingOps: [
        {
          id: 'op-x',
          a: 'ZZ_FUTURE_ACTION',
          o: 'UPD',
          e: 'TASK',
          d: 'whatever',
          c: 'OTHER_DEVICE',
          v: { OTHER_DEVICE: 6 },
          t: FIXED_NOW,
          s: 4,
          sv: 11,
          p: { actionPayload: {}, entityChanges: [] },
        },
      ],
    });

    const view = await harness.workspace.read();
    expect(view.diagnostics.unhandledActionCodes).toEqual(['ZZ_FUTURE_ACTION']);
  });

  it('appends to the ops file and leaves the snapshot untouched', async () => {
    // Rewriting sync-state.json means compaction, which would publish a
    // partially-replayed state as authoritative.
    const state = await baseState();
    const harness = createHarness(() => undefined);
    await seedSplitFiles(harness.store, state);

    const snapshotBefore = harness.store.contents(SYNC_FILE_NAMES.state);

    await harness.workspace.mutate('add_task', (s, ctx) =>
      addTask(s, { title: 'Split write' }, ctx),
    );

    expect(harness.store.contents(SYNC_FILE_NAMES.state)).toBe(snapshotBefore);

    const ops = await readEnvelope<SplitOpsEnvelope>(harness.store, SYNC_FILE_NAMES.ops);
    expect(ops.version).toBe(3);
    expect(ops.syncVersion).toBe(11);
    expect(ops.recentOps.at(-1)?.a).toBe('HA');
    expect(ops.snapshotRef.syncVersion).toBe(10);
  });

  it('refuses to write once the log needs compacting, and says what to do', async () => {
    const state = await baseState();
    const harness = createHarness(() => undefined);
    const full = Array.from({ length: SYNC_FILE_LIMITS.maxRecentOps }, (_, i) => ({
      id: `filler-${i}`,
      a: 'KS',
      o: 'UPD',
      e: 'TIME_TRACKING',
      c: 'OTHER_DEVICE',
      v: { OTHER_DEVICE: 5 },
      t: FIXED_NOW,
      s: 4,
      sv: 10,
      p: { actionPayload: {}, entityChanges: [] },
    }));
    await seedSplitFiles(harness.store, state, { pendingOps: full });

    await expect(
      harness.workspace.mutate('add_task', (s, ctx) =>
        addTask(s, { title: 'Too many' }, ctx),
      ),
    ).rejects.toThrow(UnsafeOperationError);
  });
});

describe('malformed remotes', () => {
  it('explains a migration tombstone instead of blaming the file', async () => {
    const { workspace } = createHarness((store) => {
      store.seed(
        SYNC_FILE_NAMES.single,
        'pf_3__' +
          JSON.stringify({
            version: 3,
            format: 'split',
            migratedAt: FIXED_NOW,
            note: 'migrated',
          }),
      );
    });

    await expect(workspace.read()).rejects.toThrow(/split format/);
  });

  it('rejects a body that is not a sync file at all', async () => {
    const { workspace } = createHarness((store) => {
      store.seed(SYNC_FILE_NAMES.single, '<!DOCTYPE html><html>Login</html>');
    });
    await expect(workspace.read()).rejects.toThrow(SyncFormatError);
  });

  it('rejects an unknown envelope version rather than guessing', async () => {
    const { workspace } = createHarness((store) => {
      store.seed(SYNC_FILE_NAMES.single, `pf_2__${JSON.stringify({ version: 99 })}`);
    });
    await expect(workspace.read()).rejects.toThrow(/Unsupported/);
  });

  it('names the file in the error when decoding fails', async () => {
    const { workspace } = createHarness((store) => {
      store.seed(SYNC_FILE_NAMES.single, 'pf_2__{broken');
    });
    await expect(workspace.read()).rejects.toThrow(/sync-data\.json/);
  });
});

describe('servers without usable ETags', () => {
  it('falls back to a create precondition rather than writing blind', async () => {
    // With no validator there is no way to detect a concurrent change, so the
    // only safe precondition is one that fails when the file exists.
    const { store, workspace } = createHarness((s) => {
      seedSingleFile(s);
      s.omitRevisions = true;
    });

    await expect(
      workspace.mutate('add_task', (state, ctx) =>
        addTask(state, { title: 'Task' }, ctx),
      ),
    ).rejects.toThrow(ConcurrencyError);

    expect(store.contents(SYNC_FILE_NAMES.single)).toBe(FIXTURE_RAW);
  });
});

describe('updates against real fixture data', () => {
  it('completes an existing task and records it in the log', async () => {
    const { store, workspace } = createHarness(seedSingleFile);
    const view = await workspace.read();
    const target = view.state.task.ids.find(
      (id) => view.state.task.entities[id]?.isDone === false,
    );
    expect(target).toBeDefined();

    await workspace.mutate('complete_task', (state, ctx) =>
      updateTask(state, target!, { isDone: true }, ctx),
    );

    const envelope = await readEnvelope<SingleFileSyncEnvelope>(
      store,
      SYNC_FILE_NAMES.single,
    );
    expect(envelope.state.task.entities[target!]?.isDone).toBe(true);
    expect(envelope.state.task.entities[target!]?.doneOn).toBe(FIXED_NOW);

    const op = envelope.recentOps.at(-1);
    expect(op?.a).toBe('HU');
    expect(op?.d).toBe(target);
  });
});

describe('upload format fidelity', () => {
  it('writes a compressed remote back compressed', async () => {
    // Rewriting a pf_C… file as pf_… would not lose data, but it would change
    // the format the app chose without being asked to.
    const decoded = await decodeSyncFile<SingleFileSyncEnvelope>(FIXTURE_RAW, { expectEncrypted: false });
    const compressed = await encodeSyncFile(decoded.data, {
      modelVersion: 2,
      compress: true,
    });
    const { store, workspace } = createHarness((s) => {
      s.seed(SYNC_FILE_NAMES.single, compressed);
    });

    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Keeps the format' }, ctx),
    );

    const written = store.contents(SYNC_FILE_NAMES.single);
    expect(written?.startsWith('pf_C2__')).toBe(true);
    const after = await decodeSyncFile<SingleFileSyncEnvelope>(written!, { expectEncrypted: false });
    expect(after.wasCompressed).toBe(true);
  });

  it('does not compress an uncompressed remote', async () => {
    const { store, workspace } = createHarness(seedSingleFile);
    await workspace.mutate('add_task', (state, ctx) =>
      addTask(state, { title: 'Stays plain' }, ctx),
    );

    expect(store.contents(SYNC_FILE_NAMES.single)?.startsWith('pf_2__')).toBe(true);
  });
});
