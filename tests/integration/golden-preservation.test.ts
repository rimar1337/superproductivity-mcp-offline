import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AppState } from '../../src/domain/model/app-state.js';
import { updateTask } from '../../src/domain/reducers/task.js';
import {
  SYNC_FILE_NAMES,
  type SingleFileSyncEnvelope,
} from '../../src/domain/sync/sync-file.js';
import { decodeSyncFile, encodeSyncFile } from '../../src/infrastructure/codec/sync-file-codec.js';
import { patchEventIcs } from '../../src/infrastructure/caldav/ics.js';
import type { UpdateEventInput } from '../../src/domain/caldav/event.js';
import { createHarness, FIXTURE_RAW } from '../support/workspace-harness.js';
import { FIXED_NOW } from '../support/fakes.js';

/**
 * Golden round-trip: one edit, and *nothing else may move*.
 *
 * This server rewrites the whole sync file on every write, so a field it
 * silently forgets is a field the user silently loses. Semantic assertions do
 * not catch that — only comparing the whole document before and after does.
 *
 * The set `SP_GOLDEN_SYNC_FILE` to run the same proof against a real
 * `sync-data.json` on this machine. That file is read, never copied into the
 * repo: it is someone's actual data, not a fixture.
 */

const decode = async (raw: string): Promise<SingleFileSyncEnvelope> =>
  (await decodeSyncFile<SingleFileSyncEnvelope>(raw, { expectEncrypted: false })).data;

const encode = (data: unknown): Promise<string> =>
  encodeSyncFile(data, { modelVersion: 2, compress: false });

const clone = <T>(value: T): T => structuredClone(value);

const firstTaskId = (state: AppState): string => {
  const id = state.task.ids[0];
  if (id === undefined) {
    throw new Error('fixture has no tasks');
  }
  return id;
};

/** Marks the document so we can prove unmodelled data survives verbatim. */
const addSentinels = (
  envelope: SingleFileSyncEnvelope,
): { envelope: SingleFileSyncEnvelope; taskId: string } => {
  const taskId = firstTaskId(envelope.state);
  const messy = clone(envelope) as SingleFileSyncEnvelope & Record<string, unknown>;
  messy['__mcpFutureEnvelopeField'] = { keep: ['me'] };
  (messy.state as unknown as Record<string, unknown>)['__mcpFutureRootSlice'] = 'keep';
  (messy.state.task.entities[taskId] as unknown as Record<string, unknown>)[
    '__mcpFutureTaskField'
  ] = { keep: true };
  return { envelope: messy, taskId };
};

const assertPreserved = (
  before: SingleFileSyncEnvelope,
  after: SingleFileSyncEnvelope,
  taskId: string,
): void => {
  // Envelope: same fields, unmodelled ones byte-identical.
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  expect(after.version).toBe(before.version);
  expect(after.schemaVersion).toBe(before.schemaVersion);
  expect(after.state).toBeDefined();

  // Archives are never touched by a task edit.
  expect(after.archiveYoung).toEqual(before.archiveYoung);
  expect(after.archiveOld).toEqual(before.archiveOld);

  // Every root slice except `task` is untouched.
  const beforeRoot = { ...before.state } as Record<string, unknown>;
  const afterRoot = { ...after.state } as Record<string, unknown>;
  delete beforeRoot['task'];
  delete afterRoot['task'];
  expect(afterRoot).toEqual(beforeRoot);

  // Every task except the edited one is untouched, and the edited one differs
  // only in the fields the edit names.
  const beforeTasks = before.state.task.entities;
  const afterTasks = after.state.task.entities;
  expect(Object.keys(afterTasks).sort()).toEqual(Object.keys(beforeTasks).sort());
  for (const id of Object.keys(beforeTasks)) {
    if (id !== taskId) {
      expect(afterTasks[id]).toEqual(beforeTasks[id]);
    }
  }

  const beforeTask = clone(beforeTasks[taskId]) as Record<string, unknown>;
  const afterTask = clone(afterTasks[taskId]) as Record<string, unknown>;
  delete beforeTask['title'];
  delete afterTask['title'];
  delete beforeTask['modified'];
  delete afterTask['modified'];
  expect(afterTask).toEqual(beforeTask);

  // The sentinels, wherever they lived.
  expect((after as unknown as Record<string, unknown>)['__mcpFutureEnvelopeField']).toEqual({
    keep: ['me'],
  });
  expect((after.state as unknown as Record<string, unknown>)['__mcpFutureRootSlice']).toBe(
    'keep',
  );
  expect(
    (afterTasks[taskId] as unknown as Record<string, unknown>)['__mcpFutureTaskField'],
  ).toEqual({ keep: true });
};

const provesRoundTrip = async (raw: string): Promise<void> => {
  const original = await decode(raw);
  const { envelope: messy, taskId } = addSentinels(original);
  const seeded = await encode(messy);

  const { store, workspace } = createHarness((s) => {
    s.seed(SYNC_FILE_NAMES.single, seeded);
  });

  await workspace.mutate('update_task', (state, ctx) =>
    updateTask(state, taskId, { title: 'Renamed by the MCP server' }, ctx),
  );

  const written = store.contents(SYNC_FILE_NAMES.single);
  expect(written).toBeDefined();
  const after = await decode(written!);

  expect(after.state.task.entities[taskId]?.title).toBe('Renamed by the MCP server');
  assertPreserved(messy, after, taskId);

  // The log grew by exactly the one operation we performed.
  expect(after.recentOps).toHaveLength(messy.recentOps.length + 1);
};

describe('golden preservation (committed fixture)', () => {
  it('an edit changes only what it names', async () => {
    await provesRoundTrip(FIXTURE_RAW);
  });
});

const realFile = process.env['SP_GOLDEN_SYNC_FILE'];
describe.skipIf(realFile === undefined)('golden preservation (real sync-data.json)', () => {
  it('an edit changes only what it names', async () => {
    await provesRoundTrip(readFileSync(realFile!, 'utf8'));
  });
});

const MESSY_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example//EN',
  'BEGIN:VEVENT',
  'UID:event@example.com',
  'DTSTAMP:20260824T000000Z',
  'DTSTART:20260824T090000Z',
  'DTEND:20260824T100000Z',
  'SUMMARY:Original',
  'DESCRIPTION:Keep me',
  'LOCATION:Room 1',
  'CATEGORIES:Work,Deep',
  'ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED:mailto:alice@example.com',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'X-CUSTOM-PROP;X-PARAM=1:opaque-value',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('golden preservation (calendar)', () => {
  it('an ICS update rewrites only the properties it names', () => {
    const changes: UpdateEventInput = { summary: 'Renamed' };
    const patched = patchEventIcs(MESSY_ICS, changes, new Date(FIXED_NOW));

    expect(patched).toContain('SUMMARY:Renamed');
    // Everything else — alarms, attendees, categories, recurrence, opaque X-*.
    for (const line of [
      'DESCRIPTION:Keep me',
      'LOCATION:Room 1',
      'CATEGORIES:Work,Deep',
      'ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED:mailto:alice@example.com',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'X-CUSTOM-PROP;X-PARAM=1:opaque-value',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'UID:event@example.com',
      'DTSTART:20260824T090000Z',
      'DTEND:20260824T100000Z',
    ]) {
      expect(patched).toContain(line);
    }

    // Only the revision metadata moved: SUMMARY (requested) plus DTSTAMP and
    // SEQUENCE, which every RFC 5545 update touches. Remove those three and the
    // documents must be line-for-line identical.
    const volatile = /^(DTSTAMP|SEQUENCE|SUMMARY)[:;]/;
    const before = MESSY_ICS.split('\r\n');
    const after = patched.split(/\r?\n/);
    expect(after.filter((line) => line !== '' && !volatile.test(line))).toEqual(
      before.filter((line) => line !== '' && !volatile.test(line)),
    );
    expect(after.filter((line) => line.startsWith('SUMMARY:'))).toEqual([
      'SUMMARY:Renamed',
    ]);
    expect(after.filter((line) => line.startsWith('SEQUENCE:'))).toHaveLength(1);
  });
});
