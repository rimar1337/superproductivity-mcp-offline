import { describe, expect, it } from 'vitest';
import {
  addTask,
  deleteTask,
  planTasksForToday,
  removeTasksFromToday,
  scheduleTaskWithTime,
  unscheduleTask,
  updateTask,
} from '../../../src/domain/reducers/task.js';
import { NotFoundError, ValidationError } from '../../../src/domain/errors.js';
import {
  FIXED_NOW,
  FIXED_TODAY,
  makeContext,
  makeProject,
  makeState,
  makeTag,
  makeTask,
} from '../../support/fakes.js';

describe('addTask', () => {
  it('emits the exact operation Super Productivity emits for a new task', () => {
    const state = makeState();
    const ctx = makeContext();

    const { operations } = addTask(state, { title: 'Write the README' }, ctx);

    // The whole operation is asserted, not a few fields: this object is the
    // contract replayed on the user's phone and desktop.
    expect(operations).toEqual([
      {
        id: 'test-op-1',
        a: 'HA',
        o: 'CRT',
        e: 'TASK',
        d: 'test-entity-1',
        ds: ['test-entity-1'],
        c: 'MCP_TEST01',
        v: { MCP_TEST01: 1 },
        t: FIXED_NOW,
        s: 4,
        p: {
          actionPayload: {
            task: {
              id: 'test-entity-1',
              title: 'Write the README',
              projectId: 'INBOX_PROJECT',
              isDone: false,
              tagIds: [],
              subTaskIds: [],
              timeSpentOnDay: {},
              timeSpent: 0,
              timeEstimate: 0,
              created: FIXED_NOW,
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
    ]);
  });

  it('registers the task in the project task list', () => {
    const { state } = addTask(makeState(), { title: 'Task' }, makeContext());
    expect(state.project.entities['INBOX_PROJECT']?.taskIds).toEqual(['test-entity-1']);
    expect(state.task.ids).toEqual(['test-entity-1']);
  });

  it('preserves sibling fields of the task slice', () => {
    // A helper that rebuilt the slice from {ids, entities} would silently clear
    // the user's running timer on every insert.
    const base = makeState();
    base.task.currentTaskId = 'some-running-task';
    const { state } = addTask(base, { title: 'Task' }, makeContext());
    expect(state.task.currentTaskId).toBe('some-running-task');
  });

  it('honours isAddToBottom=false by prepending', () => {
    const base = makeState({
      tasks: [makeTask({ id: 'existing' })],
      projects: [
        makeProject({ id: 'INBOX_PROJECT', title: 'Inbox', taskIds: ['existing'] }),
      ],
    });
    const { state } = addTask(
      base,
      { title: 'First', isAddToBottom: false },
      makeContext(),
    );
    expect(state.project.entities['INBOX_PROJECT']?.taskIds).toEqual([
      'test-entity-1',
      'existing',
    ]);
  });

  it('routes to the backlog only when the project has one enabled', () => {
    const withBacklog = makeState({
      projects: [makeProject({ id: 'p1', title: 'P', isEnableBacklog: true })],
    });
    const { state } = addTask(
      withBacklog,
      { title: 'Later', projectId: 'p1', isAddToBacklog: true },
      makeContext(),
    );
    expect(state.project.entities['p1']?.backlogTaskIds).toEqual(['test-entity-1']);
    expect(state.project.entities['p1']?.taskIds).toEqual([]);
  });

  it('falls back to the task list when the project has no backlog', () => {
    const { state } = addTask(
      makeState(),
      { title: 'Later', isAddToBacklog: true },
      makeContext(),
    );
    expect(state.project.entities['INBOX_PROJECT']?.taskIds).toEqual(['test-entity-1']);
  });

  it('adds the task to the ordering list of each real tag', () => {
    const base = makeState({
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 't1', title: 'Work' }),
      ],
    });
    const { state } = addTask(base, { title: 'Task', tagIds: ['t1'] }, makeContext());
    expect(state.tag.entities['t1']?.taskIds).toEqual(['test-entity-1']);
  });

  it('never persists the virtual TODAY tag onto the task itself', () => {
    const base = makeState({ tags: [makeTag({ id: 'TODAY', title: 'Today' })] });
    const { state, task } = addTask(
      base,
      { title: 'Task', tagIds: ['TODAY'], dueDay: FIXED_TODAY },
      makeContext(),
    );
    // Membership comes from dueDay; TODAY.taskIds carries ordering only.
    expect(task.tagIds).toEqual([]);
    expect(state.tag.entities['TODAY']?.taskIds).toEqual(['test-entity-1']);
  });

  it('files a future all-day date into the planner instead of Today', () => {
    const { state } = addTask(
      makeState(),
      { title: 'Task', dueDay: '2026-07-01' },
      makeContext(),
    );
    expect(state.planner.days['2026-07-01']).toEqual(['test-entity-1']);
    expect(state.tag.entities['TODAY']?.taskIds).toEqual([]);
  });

  it('marks a timed task as having a planned time', () => {
    const { task } = addTask(
      makeState(),
      { title: 'Standup', dueWithTime: FIXED_NOW + 3_600_000 },
      makeContext(),
    );
    expect(task.dueWithTime).toBe(FIXED_NOW + 3_600_000);
    expect(task.hasPlannedTime).toBe(true);
  });

  it('rejects a title that is only whitespace', () => {
    expect(() => addTask(makeState(), { title: '   ' }, makeContext())).toThrow(
      ValidationError,
    );
  });

  it('rejects dueDay and dueWithTime together', () => {
    // Upstream calls these mutually exclusive; accepting both would produce a
    // task whose schedule different views resolve differently.
    expect(() =>
      addTask(
        makeState(),
        { title: 'Task', dueDay: FIXED_TODAY, dueWithTime: FIXED_NOW },
        makeContext(),
      ),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown project', () => {
    expect(() =>
      addTask(makeState(), { title: 'Task', projectId: 'nope' }, makeContext()),
    ).toThrow(NotFoundError);
  });

  it('rejects an unknown tag', () => {
    expect(() =>
      addTask(makeState(), { title: 'Task', tagIds: ['nope'] }, makeContext()),
    ).toThrow(NotFoundError);
  });
});

describe('addTask (subtask)', () => {
  const parentState = () =>
    makeState({
      tasks: [makeTask({ id: 'parent', title: 'Parent', timeEstimate: 3_600_000 })],
      projects: [
        makeProject({ id: 'INBOX_PROJECT', title: 'Inbox', taskIds: ['parent'] }),
      ],
    });

  it('emits the subtask action code rather than the task one', () => {
    const { operations } = addTask(
      parentState(),
      { title: 'Step one', parentId: 'parent' },
      makeContext(),
    );
    expect(operations[0]?.a).toBe('TA');
    expect(operations[0]?.p.actionPayload['parentId']).toBe('parent');
  });

  it('links the subtask to its parent in both directions', () => {
    const { state, task } = addTask(
      parentState(),
      { title: 'Step one', parentId: 'parent' },
      makeContext(),
    );
    expect(task.parentId).toBe('parent');
    expect(state.task.entities['parent']?.subTaskIds).toEqual([task.id]);
  });

  it('inherits the parent project and carries no tags of its own', () => {
    const { task } = addTask(
      parentState(),
      { title: 'Step one', parentId: 'parent' },
      makeContext(),
    );
    expect(task.projectId).toBe('INBOX_PROJECT');
    expect(task.tagIds).toEqual([]);
  });

  it('hands the parent estimate to the first subtask', () => {
    // Otherwise breaking a task down silently discards the estimate it had.
    const { task } = addTask(
      parentState(),
      { title: 'Step one', parentId: 'parent' },
      makeContext(),
    );
    expect(task.timeEstimate).toBe(3_600_000);
  });

  it('recomputes the parent estimate as remaining subtask work', () => {
    const { state } = addTask(
      parentState(),
      { title: 'Step one', parentId: 'parent', timeEstimate: 600_000 },
      makeContext(),
    );
    expect(state.task.entities['parent']?.timeEstimate).toBe(600_000);
  });

  it('refuses to nest a subtask under another subtask', () => {
    const nested = makeState({
      tasks: [
        makeTask({ id: 'parent', subTaskIds: ['child'] }),
        makeTask({ id: 'child', parentId: 'parent' }),
      ],
    });
    expect(() =>
      addTask(nested, { title: 'Too deep', parentId: 'child' }, makeContext()),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown parent', () => {
    expect(() =>
      addTask(makeState(), { title: 'Orphan', parentId: 'nope' }, makeContext()),
    ).toThrow(NotFoundError);
  });
});

describe('updateTask', () => {
  const base = () =>
    makeState({
      tasks: [makeTask({ id: 't1', title: 'Old title' })],
      projects: [makeProject({ id: 'INBOX_PROJECT', title: 'Inbox', taskIds: ['t1'] })],
    });

  it('sends only the changed fields, so concurrent edits do not clobber', () => {
    const { operations } = updateTask(
      base(),
      't1',
      { title: 'New title' },
      makeContext(),
    );
    expect(operations[0]?.a).toBe('HU');
    expect(operations[0]?.p.actionPayload).toEqual({
      task: { id: 't1', changes: { modified: FIXED_NOW, title: 'New title' } },
    });
  });

  it('records doneOn when a task is completed', () => {
    const { state } = updateTask(base(), 't1', { isDone: true }, makeContext());
    expect(state.task.entities['t1']?.isDone).toBe(true);
    expect(state.task.entities['t1']?.doneOn).toBe(FIXED_NOW);
  });

  it('clears doneOn when a task is reopened', () => {
    const done = makeState({
      tasks: [makeTask({ id: 't1', isDone: true, doneOn: FIXED_NOW - 1000 })],
    });
    const { state } = updateTask(done, 't1', { isDone: false }, makeContext());
    expect(state.task.entities['t1']?.doneOn).toBeUndefined();
  });

  it('never invents a due date when completing a task', () => {
    // Upstream is explicit: completion records doneOn and nothing else.
    // Synthesising a dueDay would silently reschedule the task everywhere.
    const { state } = updateTask(base(), 't1', { isDone: true }, makeContext());
    expect(state.task.entities['t1']?.dueDay).toBeUndefined();
  });

  it('drops the in-progress tag when a task is completed', () => {
    const inProgress = makeState({
      tasks: [makeTask({ id: 't1', tagIds: ['KANBAN_IN_PROGRESS'] })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'KANBAN_IN_PROGRESS', title: 'in-progress', taskIds: ['t1'] }),
      ],
    });
    const { state } = updateTask(inProgress, 't1', { isDone: true }, makeContext());
    expect(state.task.entities['t1']?.tagIds).toEqual([]);
    expect(state.tag.entities['KANBAN_IN_PROGRESS']?.taskIds).toEqual([]);
  });

  it('moves the task between tag ordering lists when tags change', () => {
    const tagged = makeState({
      tasks: [makeTask({ id: 't1', tagIds: ['a'] })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'a', title: 'A', taskIds: ['t1'] }),
        makeTag({ id: 'b', title: 'B' }),
      ],
    });
    const { state } = updateTask(tagged, 't1', { tagIds: ['b'] }, makeContext());
    expect(state.tag.entities['a']?.taskIds).toEqual([]);
    expect(state.tag.entities['b']?.taskIds).toEqual(['t1']);
  });

  it('moves a task and its subtasks into another project', () => {
    const withSub = makeState({
      tasks: [
        makeTask({ id: 't1', subTaskIds: ['s1'] }),
        makeTask({ id: 's1', parentId: 't1' }),
      ],
      projects: [
        makeProject({ id: 'INBOX_PROJECT', title: 'Inbox', taskIds: ['t1'] }),
        makeProject({ id: 'p2', title: 'Other' }),
      ],
    });
    const { state } = updateTask(withSub, 't1', { projectId: 'p2' }, makeContext());
    expect(state.project.entities['INBOX_PROJECT']?.taskIds).toEqual([]);
    expect(state.project.entities['p2']?.taskIds).toEqual(['t1']);
    // The subtask follows its parent rather than being stranded.
    expect(state.task.entities['s1']?.projectId).toBe('p2');
  });

  it('refuses to move a subtask independently of its parent', () => {
    const withSub = makeState({
      tasks: [
        makeTask({ id: 't1', subTaskIds: ['s1'] }),
        makeTask({ id: 's1', parentId: 't1' }),
      ],
      projects: [
        makeProject({ id: 'INBOX_PROJECT', title: 'Inbox', taskIds: ['t1'] }),
        makeProject({ id: 'p2', title: 'Other' }),
      ],
    });
    expect(() => updateTask(withSub, 's1', { projectId: 'p2' }, makeContext())).toThrow(
      ValidationError,
    );
  });

  it('clears a timed schedule when an all-day date is set', () => {
    const timed = makeState({
      tasks: [makeTask({ id: 't1', dueWithTime: FIXED_NOW, hasPlannedTime: true })],
    });
    const { state } = updateTask(timed, 't1', { dueDay: '2026-07-01' }, makeContext());
    expect(state.task.entities['t1']?.dueWithTime).toBeUndefined();
    expect(state.task.entities['t1']?.dueDay).toBe('2026-07-01');
  });

  it('joins the Today ordering list when the due day becomes today', () => {
    const { state } = updateTask(base(), 't1', { dueDay: FIXED_TODAY }, makeContext());
    expect(state.tag.entities['TODAY']?.taskIds).toEqual(['t1']);
  });

  it('leaves the Today ordering list when the due day moves away', () => {
    const today = makeState({
      tasks: [makeTask({ id: 't1', dueDay: FIXED_TODAY })],
      tags: [makeTag({ id: 'TODAY', title: 'Today', taskIds: ['t1'] })],
    });
    const { state } = updateTask(today, 't1', { dueDay: '2026-07-01' }, makeContext());
    expect(state.tag.entities['TODAY']?.taskIds).toEqual([]);
    expect(state.planner.days['2026-07-01']).toEqual(['t1']);
  });

  it('rejects an unknown task', () => {
    expect(() => updateTask(makeState(), 'nope', { title: 'x' }, makeContext())).toThrow(
      NotFoundError,
    );
  });

  it('rejects a negative estimate', () => {
    expect(() => updateTask(base(), 't1', { timeEstimate: -1 }, makeContext())).toThrow(
      ValidationError,
    );
  });
});

describe('deleteTask', () => {
  const withSubtasks = () =>
    makeState({
      tasks: [
        makeTask({ id: 't1', subTaskIds: ['s1', 's2'], tagIds: ['tag1'] }),
        makeTask({ id: 's1', parentId: 't1' }),
        makeTask({ id: 's2', parentId: 't1' }),
      ],
      projects: [makeProject({ id: 'INBOX_PROJECT', title: 'Inbox', taskIds: ['t1'] })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'tag1', title: 'Tag', taskIds: ['t1'] }),
      ],
      plannerDays: { '2026-07-01': ['t1'] },
    });

  it('removes the task and every subtask', () => {
    const { state } = deleteTask(withSubtasks(), 't1', makeContext());
    expect(state.task.ids).toEqual([]);
    expect(Object.keys(state.task.entities)).toEqual([]);
  });

  it('cleans up every list that referenced the task', () => {
    const { state } = deleteTask(withSubtasks(), 't1', makeContext());
    expect(state.project.entities['INBOX_PROJECT']?.taskIds).toEqual([]);
    expect(state.tag.entities['tag1']?.taskIds).toEqual([]);
    expect(state.planner.days['2026-07-01']).toEqual([]);
  });

  it('carries the subtasks in the operation payload', () => {
    // Other devices use this to clean up children they know about.
    const { operations } = deleteTask(withSubtasks(), 't1', makeContext());
    const payload = operations[0]?.p.actionPayload['task'] as { subTasks: unknown[] };
    expect(payload.subTasks).toHaveLength(2);
    expect(operations[0]?.ds).toEqual(['t1', 's1', 's2']);
  });

  it('sweeps up orphan subtasks the parent never recorded', () => {
    // This inconsistency is real in shipped sync files; trusting subTaskIds
    // alone would strand the orphan forever.
    const orphaned = makeState({
      tasks: [
        makeTask({ id: 't1', subTaskIds: [] }),
        makeTask({ id: 'orphan', parentId: 't1' }),
      ],
    });
    const { state } = deleteTask(orphaned, 't1', makeContext());
    expect(state.task.ids).toEqual([]);
  });

  it('clears the running timer when the deleted task was current', () => {
    const running = withSubtasks();
    running.task.currentTaskId = 's1';
    const { state } = deleteTask(running, 't1', makeContext());
    expect(state.task.currentTaskId).toBeNull();
  });

  it('detaches a deleted subtask from its parent and recomputes times', () => {
    const parentWithSub = makeState({
      tasks: [
        makeTask({ id: 't1', subTaskIds: ['s1'], timeEstimate: 600_000 }),
        makeTask({ id: 's1', parentId: 't1', timeEstimate: 600_000 }),
      ],
    });
    const { state } = deleteTask(parentWithSub, 's1', makeContext());
    expect(state.task.entities['t1']?.subTaskIds).toEqual([]);
    expect(state.task.entities['t1']?.timeEstimate).toBe(0);
  });

  it('rejects an unknown task', () => {
    expect(() => deleteTask(makeState(), 'nope', makeContext())).toThrow(NotFoundError);
  });
});

describe('scheduleTaskWithTime', () => {
  const base = () => makeState({ tasks: [makeTask({ id: 't1', dueDay: '2026-07-01' })] });

  it('clears the all-day date when a timed one is set', () => {
    const { state } = scheduleTaskWithTime(base(), 't1', FIXED_NOW, makeContext());
    expect(state.task.entities['t1']?.dueDay).toBeUndefined();
    expect(state.task.entities['t1']?.dueWithTime).toBe(FIXED_NOW);
  });

  it('joins the Today ordering when scheduled for today', () => {
    const { state } = scheduleTaskWithTime(base(), 't1', FIXED_NOW, makeContext());
    expect(state.tag.entities['TODAY']?.taskIds).toEqual(['t1']);
  });

  it('leaves the Today ordering when scheduled for another day', () => {
    const today = makeState({
      tasks: [makeTask({ id: 't1' })],
      tags: [makeTag({ id: 'TODAY', title: 'Today', taskIds: ['t1'] })],
    });
    const nextWeek = FIXED_NOW + 7 * 24 * 3_600_000;
    const { state } = scheduleTaskWithTime(today, 't1', nextWeek, makeContext());
    expect(state.tag.entities['TODAY']?.taskIds).toEqual([]);
  });

  it('carries the reminder into the operation payload', () => {
    const { operations } = scheduleTaskWithTime(base(), 't1', FIXED_NOW, makeContext(), {
      remindAt: FIXED_NOW - 300_000,
    });
    expect(operations[0]?.a).toBe('HS');
    expect(operations[0]?.p.actionPayload['remindAt']).toBe(FIXED_NOW - 300_000);
  });

  it('moves the task to the backlog when asked and the project allows it', () => {
    const withBacklog = makeState({
      tasks: [makeTask({ id: 't1', projectId: 'p1' })],
      projects: [
        makeProject({
          id: 'p1',
          title: 'P',
          isEnableBacklog: true,
          taskIds: ['t1'],
        }),
      ],
    });
    const { state } = scheduleTaskWithTime(withBacklog, 't1', FIXED_NOW, makeContext(), {
      isMoveToBacklog: true,
    });
    expect(state.project.entities['p1']?.backlogTaskIds).toEqual(['t1']);
    expect(state.project.entities['p1']?.taskIds).toEqual([]);
  });

  it('rejects an unknown task', () => {
    expect(() =>
      scheduleTaskWithTime(makeState(), 'nope', FIXED_NOW, makeContext()),
    ).toThrow(NotFoundError);
  });
});

describe('unscheduleTask', () => {
  it('clears every scheduling field at once', () => {
    const scheduled = makeState({
      tasks: [
        makeTask({
          id: 't1',
          dueWithTime: FIXED_NOW,
          hasPlannedTime: true,
          remindAt: FIXED_NOW,
        }),
      ],
      tags: [makeTag({ id: 'TODAY', title: 'Today', taskIds: ['t1'] })],
      plannerDays: { '2026-07-01': ['t1'] },
    });
    const { state, operations } = unscheduleTask(scheduled, 't1', makeContext());
    const task = state.task.entities['t1'];
    expect(task?.dueWithTime).toBeUndefined();
    expect(task?.dueDay).toBeUndefined();
    expect(task?.remindAt).toBeUndefined();
    expect(task?.hasPlannedTime).toBeUndefined();
    expect(state.tag.entities['TODAY']?.taskIds).toEqual([]);
    expect(state.planner.days['2026-07-01']).toEqual([]);
    expect(operations[0]?.a).toBe('HSX');
  });

  it('rejects an unknown task', () => {
    expect(() => unscheduleTask(makeState(), 'nope', makeContext())).toThrow(
      NotFoundError,
    );
  });
});

describe('planTasksForToday', () => {
  it('sets the due day to today and joins the ordering list', () => {
    const base = makeState({ tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2' })] });
    const { state, operations } = planTasksForToday(base, ['t1', 't2'], makeContext());
    expect(state.task.entities['t1']?.dueDay).toBe(FIXED_TODAY);
    expect(state.task.entities['t2']?.dueDay).toBe(FIXED_TODAY);
    expect(state.tag.entities['TODAY']?.taskIds).toEqual(['t2', 't1']);
    expect(operations[0]?.a).toBe('HPT');
    expect(operations[0]?.ds).toEqual(['t1', 't2']);
  });

  it('clears a timed schedule that would contradict the new all-day date', () => {
    const timed = makeState({
      tasks: [makeTask({ id: 't1', dueWithTime: FIXED_NOW, hasPlannedTime: true })],
    });
    const { state } = planTasksForToday(timed, ['t1'], makeContext());
    expect(state.task.entities['t1']?.dueWithTime).toBeUndefined();
  });

  it('rejects an unknown task before changing anything', () => {
    const base = makeState({ tasks: [makeTask({ id: 't1' })] });
    expect(() => planTasksForToday(base, ['t1', 'nope'], makeContext())).toThrow(
      NotFoundError,
    );
  });
});

describe('removeTasksFromToday', () => {
  it('clears the due day and the ordering entry', () => {
    const today = makeState({
      tasks: [makeTask({ id: 't1', dueDay: FIXED_TODAY })],
      tags: [makeTag({ id: 'TODAY', title: 'Today', taskIds: ['t1'] })],
    });
    const { state, operations } = removeTasksFromToday(today, ['t1'], makeContext());
    expect(state.task.entities['t1']?.dueDay).toBeUndefined();
    expect(state.tag.entities['TODAY']?.taskIds).toEqual([]);
    expect(operations[0]?.a).toBe('HRT');
  });

  it('rejects an unknown task', () => {
    expect(() => removeTasksFromToday(makeState(), ['nope'], makeContext())).toThrow(
      NotFoundError,
    );
  });
});

describe('operation causality across a batch', () => {
  it('advances the vector clock once per operation', () => {
    // A batch that stamped every op with the same clock would make its own
    // operations look concurrent with each other.
    const ctx = makeContext();
    const first = addTask(makeState(), { title: 'One' }, ctx);
    const second = addTask(first.state, { title: 'Two' }, ctx);
    expect(first.operations[0]?.v).toEqual({ MCP_TEST01: 1 });
    expect(second.operations[0]?.v).toEqual({ MCP_TEST01: 2 });
  });

  it('builds on an existing remote clock rather than restarting it', () => {
    const ctx = makeContext({ baseClock: { OTHER_DEVICE: 42 } });
    const { operations } = addTask(makeState(), { title: 'One' }, ctx);
    expect(operations[0]?.v).toEqual({ OTHER_DEVICE: 42, MCP_TEST01: 1 });
  });
});
