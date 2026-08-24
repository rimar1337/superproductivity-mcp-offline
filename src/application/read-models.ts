import { listEntities } from '../domain/model/entity-state.js';
import {
  type AppState,
  type Project,
  type Tag,
  type Task,
  TODAY_TAG_ID,
} from '../domain/model/app-state.js';
import { getProject, getTag, getTask, toDayString } from '../domain/reducers/shared.js';

/**
 * Projections from raw state into what a language model can actually act on.
 *
 * The raw state is denormalised across four slices and speaks in ids and
 * milliseconds. Handing that to a model produces answers full of
 * `uvD5y1KZieG521a7t5X14` and `8856999`. These projections resolve names,
 * render durations and dates the way a person would say them, and — crucially —
 * keep the ids alongside, because the model needs them to call the write tools.
 *
 * They are pure functions of state. Nothing here touches the network.
 */

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly isDone: boolean;
  readonly notes?: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly tags: readonly { id: string; title: string }[];
  readonly due: DueView;
  readonly timeEstimate: DurationView | null;
  readonly timeSpent: DurationView | null;
  readonly parentId?: string;
  readonly subTasks: readonly TaskSummaryView[];
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface TaskSummaryView {
  readonly id: string;
  readonly title: string;
  readonly isDone: boolean;
}

export interface DueView {
  /** `none` | `day` (all-day) | `time` (specific moment). */
  readonly kind: 'none' | 'day' | 'time';
  readonly day?: string;
  readonly at?: string;
  readonly isToday: boolean;
  readonly isOverdue: boolean;
}

export interface DurationView {
  readonly ms: number;
  /** Human form, e.g. `2h 30m`. */
  readonly text: string;
}

export interface ProjectView {
  readonly id: string;
  readonly title: string;
  readonly isArchived: boolean;
  readonly hasBacklog: boolean;
  readonly taskCount: number;
  readonly openTaskCount: number;
  readonly backlogCount: number;
}

export interface TagView {
  readonly id: string;
  readonly title: string;
  readonly isVirtual: boolean;
  readonly taskCount: number;
  readonly color?: string;
}

export interface ProjectionContext {
  readonly today: string;
  readonly now: number;
}

// ─── formatting ──────────────────────────────────────────────────────────────

/**
 * Renders a duration the way a person says it.
 *
 * Sub-minute values round to `<1m` rather than `0m`: an estimate that reads as
 * zero is indistinguishable from no estimate at all.
 */
export const formatDuration = (ms: number): string => {
  if (ms <= 0) {
    return '0m';
  }
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes === 0) {
    return '<1m';
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

const toDuration = (ms: number | undefined): DurationView | null =>
  ms === undefined || ms <= 0 ? null : { ms, text: formatDuration(ms) };

const toIsoString = (ms: number): string => new Date(ms).toISOString();

/**
 * Resolves a task's schedule.
 *
 * `dueWithTime` wins over `dueDay` when both are set. That is not a preference:
 * upstream states the precedence explicitly, and legacy data does carry both.
 * Reading them in the other order would show a task on the wrong day.
 */
export const describeDue = (task: Task, ctx: ProjectionContext): DueView => {
  if (typeof task.dueWithTime === 'number') {
    const day = toDayString(task.dueWithTime);
    return {
      kind: 'time',
      day,
      at: toIsoString(task.dueWithTime),
      isToday: day === ctx.today,
      isOverdue: !task.isDone && task.dueWithTime < ctx.now,
    };
  }
  if (typeof task.dueDay === 'string') {
    return {
      kind: 'day',
      day: task.dueDay,
      isToday: task.dueDay === ctx.today,
      isOverdue: !task.isDone && task.dueDay < ctx.today,
    };
  }
  return { kind: 'none', isToday: false, isOverdue: false };
};

// ─── projections ─────────────────────────────────────────────────────────────

export const toTaskView = (
  state: AppState,
  task: Task,
  ctx: ProjectionContext,
): TaskView => ({
  id: task.id,
  title: task.title,
  isDone: task.isDone,
  ...(task.notes === undefined || task.notes === '' ? {} : { notes: task.notes }),
  projectId: task.projectId,
  projectTitle: getProject(state, task.projectId)?.title ?? 'Unknown project',
  tags: task.tagIds
    .map((tagId) => {
      const tag = getTag(state, tagId);
      return tag === undefined ? null : { id: tag.id, title: tag.title };
    })
    .filter((tag): tag is { id: string; title: string } => tag !== null),
  due: describeDue(task, ctx),
  timeEstimate: toDuration(task.timeEstimate),
  timeSpent: toDuration(task.timeSpent),
  ...(task.parentId === undefined ? {} : { parentId: task.parentId }),
  subTasks: task.subTaskIds
    .map((id) => getTask(state, id))
    .filter((sub): sub is Task => sub !== undefined)
    .map((sub) => ({ id: sub.id, title: sub.title, isDone: sub.isDone })),
  createdAt: toIsoString(task.created),
  ...(task.doneOn === undefined ? {} : { completedAt: toIsoString(task.doneOn) }),
});

export const toProjectView = (project: Project, state: AppState): ProjectView => ({
  id: project.id,
  title: project.title,
  isArchived: project.isArchived,
  hasBacklog: project.isEnableBacklog,
  taskCount: project.taskIds.length,
  openTaskCount: project.taskIds.filter(
    (taskId) => getTask(state, taskId)?.isDone === false,
  ).length,
  backlogCount: project.backlogTaskIds.length,
});

export const toTagView = (tag: Tag): TagView => ({
  id: tag.id,
  title: tag.title,
  // TODAY's membership is computed from due dates, so its taskIds count is an
  // ordering artefact rather than a membership count. Flagging it stops a
  // caller reading "0 tasks" as "nothing due today".
  isVirtual: tag.id === TODAY_TAG_ID,
  taskCount: tag.taskIds.length,
  ...(typeof tag.color === 'string' ? { color: tag.color } : {}),
});

// ─── queries ─────────────────────────────────────────────────────────────────

export type DueFilter = 'any' | 'today' | 'overdue' | 'upcoming' | 'unscheduled';

export interface TaskQuery {
  readonly projectId?: string;
  readonly tagId?: string;
  readonly isDone?: boolean;
  readonly due?: DueFilter;
  /** Case-insensitive substring match on title and notes. */
  readonly search?: string;
  /** Include subtasks as top-level results. Off by default. */
  readonly includeSubTasks?: boolean;
  readonly limit?: number;
}

export interface TaskQueryResult {
  readonly tasks: readonly TaskView[];
  readonly totalMatching: number;
  readonly truncated: boolean;
}

const DEFAULT_LIMIT = 50;

/**
 * Filters and orders tasks.
 *
 * Ordering is deliberate rather than incidental: overdue first, then today,
 * then everything scheduled by date, then the unscheduled backlog, with
 * completed tasks always last. A model asked "what should I do next" reads
 * from the top, so the order *is* the answer.
 *
 * `totalMatching` is reported separately from the returned page so a truncated
 * result can say "showing 50 of 213" instead of implying there are 50.
 */
export const queryTasks = (
  state: AppState,
  query: TaskQuery,
  ctx: ProjectionContext,
): TaskQueryResult => {
  const search = query.search?.trim().toLowerCase();

  const matching = listEntities(state.task)
    .filter((task) => query.includeSubTasks === true || task.parentId === undefined)
    .filter((task) => query.projectId === undefined || task.projectId === query.projectId)
    .filter((task) => matchesTag(task, query.tagId, ctx))
    .filter((task) => query.isDone === undefined || task.isDone === query.isDone)
    .filter((task) => matchesDue(task, query.due ?? 'any', ctx))
    .filter(
      (task) =>
        search === undefined ||
        search === '' ||
        task.title.toLowerCase().includes(search) ||
        (task.notes ?? '').toLowerCase().includes(search),
    );

  const ordered = [...matching].sort((left, right) => compareForAgenda(left, right, ctx));
  const limit = query.limit ?? DEFAULT_LIMIT;
  const page = ordered.slice(0, limit);

  return {
    tasks: page.map((task) => toTaskView(state, task, ctx)),
    totalMatching: ordered.length,
    truncated: ordered.length > page.length,
  };
};

/**
 * Tag membership, with the one special case that matters.
 *
 * TODAY is virtual: a task is in it because its due date is today, not because
 * the id appears in `tagIds`. Filtering TODAY by `tagIds` would return an empty
 * list on a day full of work.
 */
const matchesTag = (
  task: Task,
  tagId: string | undefined,
  ctx: ProjectionContext,
): boolean => {
  if (tagId === undefined) {
    return true;
  }
  if (tagId === TODAY_TAG_ID) {
    return describeDue(task, ctx).isToday;
  }
  return task.tagIds.includes(tagId);
};

const matchesDue = (task: Task, filter: DueFilter, ctx: ProjectionContext): boolean => {
  if (filter === 'any') {
    return true;
  }
  const due = describeDue(task, ctx);
  switch (filter) {
    case 'today':
      return due.isToday;
    case 'overdue':
      return due.isOverdue;
    case 'upcoming':
      return due.kind !== 'none' && !due.isOverdue && !due.isToday;
    case 'unscheduled':
      return due.kind === 'none';
  }
};

/** Sort rank: lower sorts first. */
const agendaRank = (task: Task, ctx: ProjectionContext): number => {
  if (task.isDone) {
    return 4;
  }
  const due = describeDue(task, ctx);
  if (due.isOverdue) {
    return 0;
  }
  if (due.isToday) {
    return 1;
  }
  return due.kind === 'none' ? 3 : 2;
};

const compareForAgenda = (left: Task, right: Task, ctx: ProjectionContext): number => {
  const rankDelta = agendaRank(left, ctx) - agendaRank(right, ctx);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  const leftDue = describeDue(left, ctx);
  const rightDue = describeDue(right, ctx);
  if (
    leftDue.day !== undefined &&
    rightDue.day !== undefined &&
    leftDue.day !== rightDue.day
  ) {
    return leftDue.day < rightDue.day ? -1 : 1;
  }
  // Same bucket and same day: newest last, so a list reads in the order the
  // tasks were captured.
  return left.created - right.created;
};

export interface Overview {
  readonly today: string;
  readonly counts: {
    readonly openTasks: number;
    readonly overdue: number;
    readonly dueToday: number;
    readonly unscheduled: number;
    readonly completedToday: number;
  };
  readonly todaysTasks: readonly TaskView[];
  readonly overdueTasks: readonly TaskView[];
  readonly projects: readonly ProjectView[];
  readonly tags: readonly TagView[];
}

/** The "where do things stand" projection, tuned to answer that in one call. */
export const buildOverview = (state: AppState, ctx: ProjectionContext): Overview => {
  const open = listEntities(state.task).filter(
    (task) => task.parentId === undefined && !task.isDone,
  );

  const completedToday = listEntities(state.task).filter(
    (task) =>
      task.isDone && task.doneOn !== undefined && toDayString(task.doneOn) === ctx.today,
  ).length;

  return {
    today: ctx.today,
    counts: {
      openTasks: open.length,
      overdue: open.filter((task) => describeDue(task, ctx).isOverdue).length,
      dueToday: open.filter((task) => describeDue(task, ctx).isToday).length,
      unscheduled: open.filter((task) => describeDue(task, ctx).kind === 'none').length,
      completedToday,
    },
    todaysTasks: queryTasks(state, { due: 'today', isDone: false, limit: 25 }, ctx).tasks,
    overdueTasks: queryTasks(state, { due: 'overdue', isDone: false, limit: 25 }, ctx)
      .tasks,
    projects: listEntities(state.project)
      .filter((project) => !project.isArchived)
      .map((project) => toProjectView(project, state)),
    tags: listEntities(state.tag).map(toTagView),
  };
};
