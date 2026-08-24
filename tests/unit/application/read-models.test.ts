import { describe, expect, it } from 'vitest';
import {
  buildOverview,
  describeDue,
  formatDuration,
  queryTasks,
  toTagView,
  toTaskView,
} from '../../../src/application/read-models.js';
import {
  FIXED_NOW,
  FIXED_TODAY,
  makeProject,
  makeState,
  makeTag,
  makeTask,
} from '../../support/fakes.js';

const ctx = { today: FIXED_TODAY, now: FIXED_NOW };

const YESTERDAY = '2026-05-27';
const TOMORROW = '2026-05-29';

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [20_000, '<1m'],
    [30_000, '1m'],
    [60_000, '1m'],
    [1_500_000, '25m'],
    [3_600_000, '1h'],
    [5_400_000, '1h 30m'],
    [8_856_999, '2h 28m'],
  ])('renders %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('never rounds a real duration down to zero', () => {
    // "0m" is indistinguishable from having no estimate at all.
    expect(formatDuration(1)).toBe('<1m');
  });
});

describe('describeDue', () => {
  it('prefers a timed date over an all-day one when both are set', () => {
    // Upstream states this precedence, and legacy data does carry both.
    // Reading them the other way round shows the task on the wrong day.
    const due = describeDue(
      makeTask({ id: 't', dueDay: TOMORROW, dueWithTime: FIXED_NOW }),
      ctx,
    );
    expect(due.kind).toBe('time');
    expect(due.isToday).toBe(true);
  });

  it('reports no schedule as such', () => {
    expect(describeDue(makeTask({ id: 't' }), ctx)).toMatchObject({
      kind: 'none',
      isToday: false,
      isOverdue: false,
    });
  });

  it('marks a past all-day date overdue', () => {
    expect(describeDue(makeTask({ id: 't', dueDay: YESTERDAY }), ctx).isOverdue).toBe(
      true,
    );
  });

  it('never marks a completed task overdue', () => {
    const done = makeTask({ id: 't', dueDay: YESTERDAY, isDone: true });
    expect(describeDue(done, ctx).isOverdue).toBe(false);
  });

  it('marks a future date as neither today nor overdue', () => {
    expect(describeDue(makeTask({ id: 't', dueDay: TOMORROW }), ctx)).toMatchObject({
      isToday: false,
      isOverdue: false,
    });
  });
});

describe('toTaskView', () => {
  it('resolves ids into names a model can repeat back', () => {
    const state = makeState({
      tasks: [
        makeTask({
          id: 't1',
          title: 'Write it up',
          projectId: 'p1',
          tagIds: ['g1'],
          timeEstimate: 5_400_000,
          notes: 'some notes',
        }),
      ],
      projects: [makeProject({ id: 'p1', title: 'Documentation' })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'g1', title: 'Writing' }),
      ],
    });

    const view = toTaskView(state, state.task.entities['t1']!, ctx);
    expect(view.projectTitle).toBe('Documentation');
    expect(view.tags).toEqual([{ id: 'g1', title: 'Writing' }]);
    expect(view.timeEstimate?.text).toBe('1h 30m');
    expect(view.notes).toBe('some notes');
  });

  it('degrades gracefully when a project reference is dangling', () => {
    // Real sync files do contain these; throwing on a read would be worse.
    const state = makeState({ tasks: [makeTask({ id: 't1', projectId: 'gone' })] });
    expect(toTaskView(state, state.task.entities['t1']!, ctx).projectTitle).toBe(
      'Unknown project',
    );
  });

  it('omits an absent estimate rather than reporting zero', () => {
    const state = makeState({ tasks: [makeTask({ id: 't1' })] });
    expect(toTaskView(state, state.task.entities['t1']!, ctx).timeEstimate).toBeNull();
  });

  it('resolves subtasks', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 't1', subTaskIds: ['s1'] }),
        makeTask({ id: 's1', title: 'Step', isDone: true, parentId: 't1' }),
      ],
    });
    expect(toTaskView(state, state.task.entities['t1']!, ctx).subTasks).toEqual([
      { id: 's1', title: 'Step', isDone: true },
    ]);
  });
});

describe('toTagView', () => {
  it('flags Today as virtual so a zero count is not misread', () => {
    // Its taskIds are an ordering artefact. "0 tasks" would otherwise read as
    // "nothing due today" on a day full of work.
    expect(toTagView(makeTag({ id: 'TODAY', title: 'Today' })).isVirtual).toBe(true);
    expect(toTagView(makeTag({ id: 'g1', title: 'Work' })).isVirtual).toBe(false);
  });
});

describe('queryTasks', () => {
  const state = () =>
    makeState({
      tasks: [
        makeTask({
          id: 'overdue',
          title: 'Overdue thing',
          dueDay: YESTERDAY,
          created: 1,
        }),
        makeTask({ id: 'today', title: 'Today thing', dueDay: FIXED_TODAY, created: 2 }),
        makeTask({ id: 'later', title: 'Later thing', dueDay: TOMORROW, created: 3 }),
        makeTask({ id: 'backlog', title: 'Backlog thing', created: 4 }),
        makeTask({ id: 'done', title: 'Done thing', isDone: true, created: 5 }),
        makeTask({ id: 'sub', title: 'A subtask', parentId: 'backlog', created: 6 }),
      ],
      tags: [makeTag({ id: 'TODAY', title: 'Today' })],
    });

  it('orders results the way you would work through them', () => {
    // The ordering *is* the answer to "what should I do next": overdue first,
    // then today, then by date, then the backlog, with completed tasks last.
    const result = queryTasks(state(), { limit: 50 }, ctx);
    expect(result.tasks.map((task) => task.id)).toEqual([
      'overdue',
      'today',
      'later',
      'backlog',
      'done',
    ]);
  });

  it('excludes subtasks by default and includes them on request', () => {
    expect(queryTasks(state(), {}, ctx).tasks.map((t) => t.id)).not.toContain('sub');
    expect(
      queryTasks(state(), { includeSubTasks: true }, ctx).tasks.map((t) => t.id),
    ).toContain('sub');
  });

  it.each([
    ['today', ['today']],
    ['overdue', ['overdue']],
    ['upcoming', ['later']],
    ['unscheduled', ['backlog']],
  ] as const)('filters by due=%s', (due, expected) => {
    const result = queryTasks(state(), { due, isDone: false }, ctx);
    expect(result.tasks.map((task) => task.id)).toEqual(expected);
  });

  it('resolves the virtual Today tag through due dates, not tagIds', () => {
    // Filtering TODAY by tagIds returns nothing on a day full of work.
    const result = queryTasks(state(), { tagId: 'TODAY' }, ctx);
    expect(result.tasks.map((task) => task.id)).toEqual(['today']);
  });

  it('filters a real tag by membership', () => {
    const tagged = makeState({
      tasks: [makeTask({ id: 't1', tagIds: ['g1'] }), makeTask({ id: 't2' })],
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'g1', title: 'Work' }),
      ],
    });
    expect(queryTasks(tagged, { tagId: 'g1' }, ctx).tasks.map((t) => t.id)).toEqual([
      't1',
    ]);
  });

  it('searches titles and notes case-insensitively', () => {
    const searchable = makeState({
      tasks: [
        makeTask({ id: 't1', title: 'Buy MILK' }),
        makeTask({ id: 't2', title: 'Other', notes: 'remember the milk' }),
        makeTask({ id: 't3', title: 'Unrelated' }),
      ],
    });
    const result = queryTasks(searchable, { search: 'milk' }, ctx);
    expect(result.tasks.map((task) => task.id).sort()).toEqual(['t1', 't2']);
  });

  it('reports the true total when a page is truncated', () => {
    const result = queryTasks(state(), { limit: 2 }, ctx);
    expect(result.tasks).toHaveLength(2);
    expect(result.totalMatching).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation when everything fits', () => {
    expect(queryTasks(state(), { limit: 50 }, ctx).truncated).toBe(false);
  });

  it('filters by project', () => {
    const multi = makeState({
      tasks: [
        makeTask({ id: 't1', projectId: 'p1' }),
        makeTask({ id: 't2', projectId: 'p2' }),
      ],
      projects: [
        makeProject({ id: 'p1', title: 'A' }),
        makeProject({ id: 'p2', title: 'B' }),
      ],
    });
    expect(queryTasks(multi, { projectId: 'p2' }, ctx).tasks.map((t) => t.id)).toEqual([
      't2',
    ]);
  });
});

describe('buildOverview', () => {
  it('summarises the day in one shape', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 'overdue', dueDay: YESTERDAY }),
        makeTask({ id: 'today', dueDay: FIXED_TODAY }),
        makeTask({ id: 'backlog' }),
        makeTask({ id: 'done', isDone: true, doneOn: FIXED_NOW }),
      ],
      projects: [
        makeProject({ id: 'INBOX_PROJECT', title: 'Inbox' }),
        makeProject({ id: 'archived', title: 'Old', isArchived: true }),
      ],
    });

    const overview = buildOverview(state, ctx);
    expect(overview.today).toBe(FIXED_TODAY);
    expect(overview.counts).toEqual({
      openTasks: 3,
      overdue: 1,
      dueToday: 1,
      unscheduled: 1,
      completedToday: 1,
    });
    expect(overview.todaysTasks.map((task) => task.id)).toEqual(['today']);
    expect(overview.overdueTasks.map((task) => task.id)).toEqual(['overdue']);
    // Archived projects are noise in an overview.
    expect(overview.projects.map((project) => project.id)).toEqual(['INBOX_PROJECT']);
  });

  it('counts only tasks completed today, not everything ever completed', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 'recent', isDone: true, doneOn: FIXED_NOW }),
        makeTask({ id: 'ancient', isDone: true, doneOn: FIXED_NOW - 30 * 86_400_000 }),
      ],
    });
    expect(buildOverview(state, ctx).counts.completedToday).toBe(1);
  });
});
