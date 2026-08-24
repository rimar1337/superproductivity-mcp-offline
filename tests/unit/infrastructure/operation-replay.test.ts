import { describe, expect, it } from 'vitest';
import { replayOperations } from '../../../src/infrastructure/sync/operation-replay.js';
import type { CompactOperation } from '../../../src/domain/sync/operation.js';
import {
  FIXED_NOW,
  FIXED_TODAY,
  makeProject,
  makeState,
  makeTag,
  makeTask,
} from '../../support/fakes.js';

/**
 * Replay is what makes the split remote layout readable: between compactions
 * the snapshot lags by up to 2000 operations, and these are what close the gap.
 *
 * The behaviour under test is as much about *refusing* as applying. An
 * operation this version cannot reproduce faithfully must be reported, not
 * approximated, because a caller that believes it has a complete picture will
 * answer confidently from an incomplete one.
 */

const op = (overrides: Partial<CompactOperation> & { a: string }): CompactOperation => ({
  id: `op-${overrides.a}`,
  o: 'UPD',
  e: 'TASK',
  c: 'OTHER_DEVICE',
  v: { OTHER_DEVICE: 1 },
  t: FIXED_NOW,
  s: 4,
  p: { actionPayload: {}, entityChanges: [] },
  ...overrides,
});

const payload = (actionPayload: Record<string, unknown>): CompactOperation['p'] => ({
  actionPayload,
  entityChanges: [],
});

const taskPayload = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  projectId: 'INBOX_PROJECT',
  isDone: false,
  tagIds: [],
  subTaskIds: [],
  timeSpentOnDay: {},
  timeSpent: 0,
  timeEstimate: 0,
  created: FIXED_NOW,
  attachments: [],
  ...overrides,
});

describe('applying operations', () => {
  it('creates a task and files it into its project', () => {
    const result = replayOperations(
      makeState(),
      [
        op({
          a: 'HA',
          o: 'CRT',
          d: 't1',
          p: payload({
            task: taskPayload('t1'),
            isAddToBottom: true,
            isAddToBacklog: false,
          }),
        }),
      ],
      FIXED_TODAY,
    );

    expect(result.state.task.entities['t1']?.title).toBe('Task t1');
    expect(result.state.project.entities['INBOX_PROJECT']?.taskIds).toEqual(['t1']);
    expect(result.appliedCount).toBe(1);
  });

  it('routes a created task into the backlog when the project has one', () => {
    const base = makeState({
      projects: [makeProject({ id: 'p1', title: 'P', isEnableBacklog: true })],
    });
    const result = replayOperations(
      base,
      [
        op({
          a: 'HA',
          o: 'CRT',
          d: 't1',
          p: payload({
            task: taskPayload('t1', { projectId: 'p1' }),
            isAddToBacklog: true,
            isAddToBottom: true,
          }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.project.entities['p1']?.backlogTaskIds).toEqual(['t1']);
  });

  it('links a replayed subtask to its parent', () => {
    const base = makeState({ tasks: [makeTask({ id: 'parent' })] });
    const result = replayOperations(
      base,
      [
        op({
          a: 'TA',
          o: 'CRT',
          d: 's1',
          p: payload({ task: taskPayload('s1'), parentId: 'parent' }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.task.entities['parent']?.subTaskIds).toEqual(['s1']);
  });

  it('skips a subtask whose parent is not in this log window', () => {
    // Adding an orphan would be worse than skipping: it would show up as a
    // top-level task that does not exist anywhere else.
    const result = replayOperations(
      makeState(),
      [
        op({
          a: 'TA',
          o: 'CRT',
          p: payload({ task: taskPayload('s1'), parentId: 'missing' }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.task.entities['s1']).toBeUndefined();
    expect(result.appliedCount).toBe(1);
  });

  it('applies a task update', () => {
    const base = makeState({ tasks: [makeTask({ id: 't1', title: 'Before' })] });
    const result = replayOperations(
      base,
      [
        op({
          a: 'HU',
          d: 't1',
          p: payload({ task: { id: 't1', changes: { title: 'After' } } }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.task.entities['t1']?.title).toBe('After');
  });

  it('treats an update to a missing task as a no-op, matching upstream', () => {
    // Upstream's reducers are no-ops for missing entities. Throwing here would
    // abort an otherwise valid sync over a partial log.
    const result = replayOperations(
      makeState(),
      [
        op({
          a: 'HU',
          d: 'gone',
          p: payload({ task: { id: 'gone', changes: { title: 'x' } } }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.appliedCount).toBe(1);
    expect(result.unhandledActionCodes).toEqual([]);
  });

  it('leaves the virtual Today tag alone when tags change', () => {
    // Sweeping every tag would strip the task from TODAY's ordering list, and
    // TODAY's membership comes from the due date — the task would quietly
    // vanish from the user's Today view over an unrelated tag edit.
    const base = makeState({
      tasks: [makeTask({ id: 't1', tagIds: ['a'], dueDay: FIXED_TODAY })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today', taskIds: ['t1'] }),
        makeTag({ id: 'a', title: 'A', taskIds: ['t1'] }),
        makeTag({ id: 'b', title: 'B' }),
      ],
    });
    const result = replayOperations(
      base,
      [
        op({
          a: 'HU',
          d: 't1',
          p: payload({ task: { id: 't1', changes: { tagIds: ['b'] } } }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.tag.entities['TODAY']?.taskIds).toEqual(['t1']);
  });

  it('moves a task between tag ordering lists on a tag change', () => {
    const base = makeState({
      tasks: [makeTask({ id: 't1', tagIds: ['a'] })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'a', title: 'A', taskIds: ['t1'] }),
        makeTag({ id: 'b', title: 'B' }),
      ],
    });
    const result = replayOperations(
      base,
      [
        op({
          a: 'HU',
          d: 't1',
          p: payload({ task: { id: 't1', changes: { tagIds: ['b'] } } }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.tag.entities['a']?.taskIds).toEqual([]);
    expect(result.state.tag.entities['b']?.taskIds).toEqual(['t1']);
  });

  it('deletes a task with its subtasks and every reference', () => {
    const base = makeState({
      tasks: [
        makeTask({ id: 't1', subTaskIds: ['s1'] }),
        makeTask({ id: 's1', parentId: 't1' }),
      ],
      projects: [makeProject({ id: 'INBOX_PROJECT', title: 'Inbox', taskIds: ['t1'] })],
      tags: [makeTag({ id: 'TODAY', title: 'Today', taskIds: ['t1'] })],
    });
    const result = replayOperations(
      base,
      [
        op({
          a: 'HD',
          o: 'DEL',
          d: 't1',
          p: payload({ task: { id: 't1', subTaskIds: ['s1'] } }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.task.ids).toEqual([]);
    expect(result.state.project.entities['INBOX_PROJECT']?.taskIds).toEqual([]);
    expect(result.state.tag.entities['TODAY']?.taskIds).toEqual([]);
  });

  it('removes archived tasks from the live state', () => {
    const base = makeState({ tasks: [makeTask({ id: 't1' })] });
    const result = replayOperations(
      base,
      [op({ a: 'HX', d: 't1', p: payload({ tasks: [taskPayload('t1')] }) })],
      FIXED_TODAY,
    );
    expect(result.state.task.ids).toEqual([]);
  });

  it('applies a timed schedule and clears the all-day date', () => {
    const base = makeState({ tasks: [makeTask({ id: 't1', dueDay: '2026-07-01' })] });
    const result = replayOperations(
      base,
      [
        op({
          a: 'HS',
          d: 't1',
          p: payload({ task: taskPayload('t1'), dueWithTime: FIXED_NOW }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(result.state.task.entities['t1']?.dueWithTime).toBe(FIXED_NOW);
    expect(result.state.task.entities['t1']?.dueDay).toBeUndefined();
  });

  it('clears every scheduling field on unschedule', () => {
    const base = makeState({
      tasks: [makeTask({ id: 't1', dueWithTime: FIXED_NOW, remindAt: FIXED_NOW })],
    });
    const result = replayOperations(
      base,
      [op({ a: 'HSX', d: 't1', p: payload({ id: 't1' }) })],
      FIXED_TODAY,
    );
    expect(result.state.task.entities['t1']?.dueWithTime).toBeUndefined();
    expect(result.state.task.entities['t1']?.remindAt).toBeUndefined();
  });

  it('honours the day the plan-for-today operation referred to', () => {
    // An operation authored yesterday planned for *yesterday*. Using our own
    // "today" would silently move it a day forward on replay.
    const base = makeState({ tasks: [makeTask({ id: 't1' })] });
    const result = replayOperations(
      base,
      [op({ a: 'HPT', d: 't1', p: payload({ taskIds: ['t1'], today: '2026-01-01' }) })],
      FIXED_TODAY,
    );
    expect(result.state.task.entities['t1']?.dueDay).toBe('2026-01-01');
    expect(result.state.tag.entities['TODAY']?.taskIds).toEqual([]);
  });

  it('removes tasks from today', () => {
    const base = makeState({
      tasks: [makeTask({ id: 't1', dueDay: FIXED_TODAY })],
      tags: [makeTag({ id: 'TODAY', title: 'Today', taskIds: ['t1'] })],
    });
    const result = replayOperations(
      base,
      [op({ a: 'HRT', d: 't1', p: payload({ taskIds: ['t1'] }) })],
      FIXED_TODAY,
    );
    expect(result.state.task.entities['t1']?.dueDay).toBeUndefined();
    expect(result.state.tag.entities['TODAY']?.taskIds).toEqual([]);
  });

  it('creates and updates projects', () => {
    const created = replayOperations(
      makeState(),
      [
        op({
          a: 'PA',
          o: 'CRT',
          e: 'PROJECT',
          d: 'p1',
          p: payload({ project: makeProject({ id: 'p1', title: 'New' }) }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(created.state.project.entities['p1']?.title).toBe('New');

    const updated = replayOperations(
      created.state,
      [
        op({
          a: 'PU',
          e: 'PROJECT',
          d: 'p1',
          p: payload({ project: { id: 'p1', changes: { title: 'Renamed' } } }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(updated.state.project.entities['p1']?.title).toBe('Renamed');
  });

  it('creates and updates tags', () => {
    const created = replayOperations(
      makeState(),
      [
        op({
          a: 'GA',
          o: 'CRT',
          e: 'TAG',
          d: 'g1',
          p: payload({ tag: makeTag({ id: 'g1', title: 'New tag' }) }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(created.state.tag.entities['g1']?.title).toBe('New tag');

    const updated = replayOperations(
      created.state,
      [
        op({
          a: 'GU',
          e: 'TAG',
          d: 'g1',
          p: payload({ tag: { id: 'g1', changes: { title: 'Renamed' } } }),
        }),
      ],
      FIXED_TODAY,
    );
    expect(updated.state.tag.entities['g1']?.title).toBe('Renamed');
  });

  it('drops a deleted tag from every task that referenced it', () => {
    // Otherwise tasks keep a dangling tag id that no view can resolve.
    const base = makeState({
      tasks: [makeTask({ id: 't1', tagIds: ['g1'] })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'g1', title: 'Doomed' }),
      ],
    });
    const result = replayOperations(
      base,
      [op({ a: 'GD', o: 'DEL', e: 'TAG', d: 'g1', p: payload({ id: 'g1' }) })],
      FIXED_TODAY,
    );
    expect(result.state.tag.entities['g1']).toBeUndefined();
    expect(result.state.task.entities['t1']?.tagIds).toEqual([]);
  });
});

describe('classification', () => {
  it('skips operations that provably cannot affect the read model', () => {
    const result = replayOperations(
      makeState(),
      [
        op({ a: 'KS', e: 'TIME_TRACKING' }),
        op({ a: 'CU', e: 'GLOBAL_CONFIG' }),
        op({ a: 'BT', e: 'BOARD' }),
        op({ a: 'UM', e: 'PLUGIN_METADATA' }),
      ],
      FIXED_TODAY,
    );
    expect(result.ignoredCount).toBe(4);
    expect(result.unhandledActionCodes).toEqual([]);
  });

  it('skips presentation-only task operations without flagging them', () => {
    const result = replayOperations(
      makeState(),
      [op({ a: 'HMT' }), op({ a: 'TUU' }), op({ a: 'HRX' })],
      FIXED_TODAY,
    );
    expect(result.ignoredCount).toBe(3);
    expect(result.unhandledActionCodes).toEqual([]);
  });

  it('reports an unknown operation on a modelled entity rather than ignoring it', () => {
    // A newer Super Productivity will write codes this release has never seen.
    // Silently dropping one produces a confidently wrong view.
    const result = replayOperations(
      makeState(),
      [
        op({ a: 'ZZ_FROM_THE_FUTURE', e: 'TASK' }),
        op({ a: 'HA', o: 'CRT', p: payload({}) }),
      ],
      FIXED_TODAY,
    );
    expect(result.unhandledActionCodes).toEqual(['HA', 'ZZ_FROM_THE_FUTURE']);
    expect(result.appliedCount).toBe(0);
  });

  it('deduplicates and sorts the unhandled codes', () => {
    const result = replayOperations(
      makeState(),
      [op({ a: 'ZB' }), op({ a: 'ZA' }), op({ a: 'ZB' })],
      FIXED_TODAY,
    );
    expect(result.unhandledActionCodes).toEqual(['ZA', 'ZB']);
  });

  it('leaves the state untouched when there is nothing to replay', () => {
    const base = makeState({ tasks: [makeTask({ id: 't1' })] });
    const result = replayOperations(base, [], FIXED_TODAY);
    expect(result.state).toBe(base);
    expect(result.appliedCount).toBe(0);
  });
});
