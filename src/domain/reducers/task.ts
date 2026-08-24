import { addOne, removeIdsFromList, removeMany, unique } from '../model/entity-state.js';
import {
  type AppState,
  INBOX_PROJECT_ID,
  type Task,
  type TaskFields,
  TODAY_TAG_ID,
  withoutTodayTag,
  BUILT_IN_TAG_IDS,
} from '../model/app-state.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { EMITTED_ACTION_CODE } from '../sync/action-codes.js';
import { EntityType, type MutationResult, OpType } from '../sync/operation.js';
import type { ReducerContext } from './context.js';
import {
  addTaskToPlannerDay,
  addTaskToTags,
  addTaskToTodayOrder,
  calcTotalTimeSpent,
  collectSubTaskIds,
  getProject,
  getTag,
  getTask,
  isOnDay,
  removeTaskFromPlannerDays,
  removeTaskFromTodayOrder,
  removeTasksFromAllProjects,
  removeTasksFromAllTags,
  toDayString,
  updateProject,
  updateTask as patchTask,
  updateTags,
} from './shared.js';

/**
 * Task reducers — ports of Super Productivity's `task-shared-meta-reducers`.
 *
 * Every function here returns both the new state and the operation that
 * describes it, and the two are constructed side by side on purpose. The state
 * is what this device uploads as its snapshot; the operation is what the user's
 * phone and desktop will replay. If they ever describe different outcomes, the
 * user's devices diverge in a way that surfaces days later as duplicated or
 * vanished tasks — so they are written, and tested, as one thing.
 *
 * Two upstream rules are easy to get wrong and are enforced throughout:
 *
 * 1. **`TODAY` is a virtual tag.** Membership is derived from
 *    `task.dueDay === today`. `TODAY.taskIds` stores ordering only, and
 *    `TODAY` must never appear in `task.tagIds`.
 * 2. **`dueDay` and `dueWithTime` are mutually exclusive.** Setting one clears
 *    the other; leaving both set produces a task with two contradictory
 *    schedules that different views resolve differently.
 */

/** Task defaults, matching upstream's `DEFAULT_TASK`. */
const taskDefaults = (created: number): Omit<TaskFields, 'id' | 'projectId'> => ({
  subTaskIds: [],
  timeSpentOnDay: {},
  timeSpent: 0,
  timeEstimate: 0,
  isDone: false,
  title: '',
  tagIds: [],
  created,
  attachments: [],
});

export interface AddTaskInput {
  readonly title: string;
  readonly projectId?: string;
  readonly tagIds?: readonly string[];
  readonly notes?: string;
  /** Estimate in milliseconds. */
  readonly timeEstimate?: number;
  /** All-day due date, `YYYY-MM-DD`. Mutually exclusive with `dueWithTime`. */
  readonly dueDay?: string;
  /** Timed due date, epoch ms. Mutually exclusive with `dueDay`. */
  readonly dueWithTime?: number;
  /** Reminder, epoch ms. Only meaningful alongside `dueWithTime`. */
  readonly remindAt?: number;
  /** When set, creates a subtask of this task instead of a top-level task. */
  readonly parentId?: string;
  readonly isAddToBacklog?: boolean;
  readonly isAddToBottom?: boolean;
}

export interface TaskMutationResult extends MutationResult<AppState> {
  readonly task: Task;
}

/**
 * Creates a task.
 *
 * Subtasks take a genuinely different path (upstream's `[Task] Add SubTask`,
 * code `TA`) rather than being a top-level task with a `parentId`: a subtask
 * inherits its parent's project, carries no tags of its own, and forces the
 * parent's time totals to be recomputed. Emitting `HA` for one would leave the
 * parent's estimate stale on every other device.
 */
export const addTask = (
  state: AppState,
  input: AddTaskInput,
  ctx: ReducerContext,
): TaskMutationResult => {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new ValidationError('Task title must not be empty.');
  }
  if (input.dueDay !== undefined && input.dueWithTime !== undefined) {
    throw new ValidationError(
      'A task cannot have both dueDay and dueWithTime; they are mutually exclusive.',
      ['Use dueWithTime for a specific time, or dueDay for an all-day date.'],
    );
  }

  return input.parentId === undefined
    ? addTopLevelTask(state, input, title, ctx)
    : addSubTask(state, input, title, input.parentId, ctx);
};

const addTopLevelTask = (
  state: AppState,
  input: AddTaskInput,
  title: string,
  ctx: ReducerContext,
): TaskMutationResult => {
  const projectId = input.projectId ?? INBOX_PROJECT_ID;
  const project = getProject(state, projectId);
  if (project === undefined) {
    throw new NotFoundError('Project', projectId);
  }

  const unknownTag = (input.tagIds ?? []).find(
    (tagId) => tagId !== TODAY_TAG_ID && getTag(state, tagId) === undefined,
  );
  if (unknownTag !== undefined) {
    throw new NotFoundError('Tag', unknownTag);
  }

  const id = ctx.ids.entityId();
  const isAddToBottom = input.isAddToBottom ?? true;
  // Requesting the backlog only works if the project has one enabled; upstream
  // silently falls back to the task list rather than dropping the task.
  const isAddToBacklog = (input.isAddToBacklog ?? false) && project.isEnableBacklog;

  const task: Task = {
    ...taskDefaults(ctx.now),
    id,
    title,
    projectId,
    // TODAY is virtual and must never be persisted onto the task itself.
    tagIds: withoutTodayTag(input.tagIds ?? []),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.timeEstimate !== undefined ? { timeEstimate: input.timeEstimate } : {}),
    ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
    ...(input.dueWithTime !== undefined
      ? { dueWithTime: input.dueWithTime, hasPlannedTime: true }
      : {}),
    ...(input.remindAt !== undefined ? { remindAt: input.remindAt } : {}),
  };
  task.timeSpent = calcTotalTimeSpent(task.timeSpentOnDay);

  let next: AppState = { ...state, task: addOne(state.task, id, task) };

  const targetList = isAddToBacklog ? 'backlogTaskIds' : 'taskIds';
  next = updateProject(next, projectId, {
    [targetList]: isAddToBottom
      ? [...project[targetList], id]
      : [id, ...project[targetList]],
  });

  const isForToday = input.dueDay === ctx.today;
  next = addTaskToTags(
    next,
    id,
    [...task.tagIds, ...(isForToday ? [TODAY_TAG_ID] : [])],
    isAddToBottom,
  );

  // A future all-day date belongs to the planner; today's belongs to TODAY's
  // ordering list, which the tag update above already handled.
  if (input.dueDay !== undefined && input.dueDay !== ctx.today) {
    next = addTaskToPlannerDay(next, id, input.dueDay, isAddToBottom);
  }

  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.taskAdd,
    opType: OpType.Create,
    entityType: EntityType.Task,
    entityId: id,
    actionPayload: {
      task,
      workContextId: projectId,
      workContextType: 'PROJECT',
      isAddToBacklog,
      isAddToBottom,
    },
  });

  return { state: next, operations: [operation], task };
};

const addSubTask = (
  state: AppState,
  input: AddTaskInput,
  title: string,
  parentId: string,
  ctx: ReducerContext,
): TaskMutationResult => {
  const parent = getTask(state, parentId);
  if (parent === undefined) {
    throw new NotFoundError('Task', parentId);
  }
  if (parent.parentId !== undefined) {
    throw new ValidationError(
      `Task ${parentId} is itself a subtask; Super Productivity supports only one level of nesting.`,
    );
  }

  const id = ctx.ids.entityId();
  const isFirstSubTask = parent.subTaskIds.length === 0;

  const task: Task = {
    ...taskDefaults(ctx.now),
    id,
    title,
    parentId,
    // A subtask always inherits the parent's project and never carries tags:
    // both are upstream invariants, not defaults we chose.
    projectId: parent.projectId,
    tagIds: [],
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    // The first subtask adopts the parent's estimate, so a task that had an
    // estimate before it was broken down does not silently lose it.
    ...(input.timeEstimate !== undefined
      ? { timeEstimate: input.timeEstimate }
      : isFirstSubTask
        ? { timeEstimate: parent.timeEstimate }
        : {}),
    ...(isFirstSubTask
      ? {
          timeSpentOnDay: parent.timeSpentOnDay,
          timeSpent: calcTotalTimeSpent(parent.timeSpentOnDay),
        }
      : {}),
  };

  let next: AppState = { ...state, task: addOne(state.task, id, task) };
  next = patchTask(next, parentId, {
    subTaskIds: unique([...parent.subTaskIds, id]),
  });
  next = recalcParentTimes(next, parentId);

  const operation = ctx.operations.create({
    actionCode: 'TA',
    opType: OpType.Create,
    entityType: EntityType.Task,
    entityId: id,
    entityIds: [id, parentId],
    actionPayload: { task, parentId },
  });

  return { state: next, operations: [operation], task };
};

export interface UpdateTaskChanges {
  readonly title?: string;
  readonly notes?: string;
  readonly isDone?: boolean;
  readonly timeEstimate?: number;
  readonly tagIds?: readonly string[];
  readonly projectId?: string;
  readonly dueDay?: string | null;
}

/**
 * Patches a task.
 *
 * Only the fields present in `changes` are touched, which is what makes this
 * operation safe to run concurrently with another device: two clients editing
 * different fields of the same task both survive, where a whole-entity write
 * would have one silently overwrite the other.
 */
export const updateTask = (
  state: AppState,
  taskId: string,
  changes: UpdateTaskChanges,
  ctx: ReducerContext,
): TaskMutationResult => {
  const current = getTask(state, taskId);
  if (current === undefined) {
    throw new NotFoundError('Task', taskId);
  }

  const applied: Partial<Task> = { modified: ctx.now };

  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (title.length === 0) {
      throw new ValidationError('Task title must not be empty.');
    }
    applied.title = title;
  }
  if (changes.notes !== undefined) {
    applied.notes = changes.notes;
  }
  if (changes.timeEstimate !== undefined) {
    if (changes.timeEstimate < 0) {
      throw new ValidationError('timeEstimate must not be negative.');
    }
    applied.timeEstimate = changes.timeEstimate;
  }

  let next = state;

  if (changes.tagIds !== undefined) {
    const unknownTag = changes.tagIds.find(
      (tagId) => tagId !== TODAY_TAG_ID && getTag(state, tagId) === undefined,
    );
    if (unknownTag !== undefined) {
      throw new NotFoundError('Tag', unknownTag);
    }
    const nextTagIds = withoutTodayTag(changes.tagIds);
    next = syncTagMembership(next, taskId, current.tagIds, nextTagIds);
    applied.tagIds = nextTagIds;
  }

  if (changes.isDone !== undefined) {
    applied.isDone = changes.isDone;
    // Completion records `doneOn` and nothing else. Upstream is explicit that
    // it must never synthesise a `dueDay`: the Today "Done" list is driven by
    // isDone/doneOn, and inventing a due date would silently reschedule the
    // task on every other device.
    applied.doneOn = changes.isDone ? ctx.now : undefined;
    if (changes.isDone) {
      const tagIds = applied.tagIds ?? current.tagIds;
      if (tagIds.includes(BUILT_IN_TAG_IDS.inProgress)) {
        const withoutInProgress = tagIds.filter(
          (tagId) => tagId !== BUILT_IN_TAG_IDS.inProgress,
        );
        next = syncTagMembership(next, taskId, tagIds, withoutInProgress);
        applied.tagIds = withoutInProgress;
      }
    }
  }

  if (changes.projectId !== undefined) {
    next = applyProjectMove(next, current, changes.projectId);
    applied.projectId = changes.projectId;
  }

  if (changes.dueDay !== undefined) {
    next = applyDueDayChange(next, current, changes.dueDay, ctx);
    applied.dueDay = changes.dueDay;
    // Mutual exclusivity: an all-day date supersedes any timed schedule.
    if (changes.dueDay !== null) {
      applied.dueWithTime = undefined;
      applied.hasPlannedTime = undefined;
    }
  }

  next = patchTask(next, taskId, applied);
  if (current.parentId !== undefined) {
    next = recalcParentTimes(next, current.parentId);
  }

  const updated = getTask(next, taskId);
  /* c8 ignore next 3 -- unreachable: patchTask cannot remove an existing task. */
  if (updated === undefined) {
    throw new NotFoundError('Task', taskId);
  }

  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.taskUpdate,
    opType: OpType.Update,
    entityType: EntityType.Task,
    entityId: taskId,
    actionPayload: { task: { id: taskId, changes: applied } },
  });

  return { state: next, operations: [operation], task: updated };
};

/**
 * Deletes a task and every subtask beneath it.
 *
 * The operation payload carries the full task, including a `subTasks` array —
 * that is the shape upstream emits, and other devices depend on it to clean up
 * children they may know about but we do not.
 */
export const deleteTask = (
  state: AppState,
  taskId: string,
  ctx: ReducerContext,
): MutationResult<AppState> => {
  const task = getTask(state, taskId);
  if (task === undefined) {
    throw new NotFoundError('Task', taskId);
  }

  const subTaskIds = collectSubTaskIds(state, taskId);
  const subTasks = subTaskIds
    .map((id) => getTask(state, id))
    .filter((sub): sub is Task => sub !== undefined);
  const allIds = [taskId, ...subTaskIds];

  let next: AppState = { ...state, task: removeMany(state.task, allIds) };

  if (next.task.currentTaskId != null && allIds.includes(next.task.currentTaskId)) {
    next = { ...next, task: { ...next.task, currentTaskId: null } };
  }

  if (task.parentId !== undefined) {
    const parent = getTask(next, task.parentId);
    if (parent !== undefined) {
      next = patchTask(next, task.parentId, {
        subTaskIds: removeIdsFromList(parent.subTaskIds, [taskId]),
      });
      next = recalcParentTimes(next, task.parentId);
    }
  }

  next = removeTasksFromAllProjects(next, allIds);
  next = removeTasksFromAllTags(next, allIds);
  for (const id of allIds) {
    next = removeTaskFromPlannerDays(next, id);
  }

  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.taskDelete,
    opType: OpType.Delete,
    entityType: EntityType.Task,
    entityId: taskId,
    entityIds: allIds,
    actionPayload: { task: { ...task, subTasks } },
  });

  return { state: next, operations: [operation] };
};

/** Gives a task a specific date and time, clearing any all-day due date. */
export const scheduleTaskWithTime = (
  state: AppState,
  taskId: string,
  dueWithTime: number,
  ctx: ReducerContext,
  options: { readonly remindAt?: number; readonly isMoveToBacklog?: boolean } = {},
): TaskMutationResult => {
  const current = getTask(state, taskId);
  if (current === undefined) {
    throw new NotFoundError('Task', taskId);
  }

  const isMoveToBacklog = options.isMoveToBacklog ?? false;
  const changes: Partial<Task> = {
    dueWithTime,
    // Mutual exclusivity, upstream's Decision #1.
    dueDay: undefined,
    hasPlannedTime: true,
    remindAt: options.remindAt,
    modified: ctx.now,
  };

  let next = patchTask(state, taskId, changes);
  next = removeTaskFromPlannerDays(next, taskId);

  if (isMoveToBacklog) {
    const project = getProject(next, current.projectId);
    if (project?.isEnableBacklog === true && !project.backlogTaskIds.includes(taskId)) {
      next = updateProject(next, current.projectId, {
        taskIds: project.taskIds.filter((id) => id !== taskId),
        backlogTaskIds: [taskId, ...project.backlogTaskIds],
      });
    }
  }

  // Today membership follows the new timestamp: scheduling for today pulls the
  // task into Today's ordering, scheduling away from today pushes it out.
  next = isOnDay(dueWithTime, ctx.today)
    ? addTaskToTodayOrder(next, taskId)
    : removeTaskFromTodayOrder(next, taskId);

  const taskSnapshot: Task = { ...current, ...changes };
  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.taskScheduleWithTime,
    opType: OpType.Update,
    entityType: EntityType.Task,
    entityId: taskId,
    actionPayload: {
      task: taskSnapshot,
      dueWithTime,
      ...(options.remindAt !== undefined ? { remindAt: options.remindAt } : {}),
      isMoveToBacklog,
    },
  });

  const updated = getTask(next, taskId) ?? taskSnapshot;
  return { state: next, operations: [operation], task: updated };
};

/** Clears a task's schedule entirely. */
export const unscheduleTask = (
  state: AppState,
  taskId: string,
  ctx: ReducerContext,
): TaskMutationResult => {
  const current = getTask(state, taskId);
  if (current === undefined) {
    throw new NotFoundError('Task', taskId);
  }

  let next = patchTask(state, taskId, {
    dueWithTime: undefined,
    dueDay: undefined,
    hasPlannedTime: undefined,
    remindAt: undefined,
    reminderId: undefined,
    modified: ctx.now,
  });
  next = removeTaskFromPlannerDays(next, taskId);
  next = removeTaskFromTodayOrder(next, taskId);

  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.taskUnschedule,
    opType: OpType.Update,
    entityType: EntityType.Task,
    entityId: taskId,
    actionPayload: { id: taskId },
  });

  const updated = getTask(next, taskId);
  /* c8 ignore next 3 -- unreachable: patchTask cannot remove an existing task. */
  if (updated === undefined) {
    throw new NotFoundError('Task', taskId);
  }
  return { state: next, operations: [operation], task: updated };
};

/** Moves tasks into Today by setting `dueDay` and joining Today's ordering. */
export const planTasksForToday = (
  state: AppState,
  taskIds: readonly string[],
  ctx: ReducerContext,
): MutationResult<AppState> => {
  const missing = taskIds.find((id) => getTask(state, id) === undefined);
  if (missing !== undefined) {
    throw new NotFoundError('Task', missing);
  }

  let next = state;
  const parentTaskMap: Record<string, string | undefined> = {};

  for (const taskId of taskIds) {
    const task = getTask(next, taskId);
    /* c8 ignore next 3 -- pre-validated above. */
    if (task === undefined) {
      continue;
    }
    parentTaskMap[taskId] = task.parentId;
    next = patchTask(next, taskId, {
      dueDay: ctx.today,
      dueWithTime: undefined,
      hasPlannedTime: undefined,
      modified: ctx.now,
    });
    next = removeTaskFromPlannerDays(next, taskId);
    next = addTaskToTodayOrder(next, taskId);
  }

  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.taskPlanForToday,
    opType: OpType.Update,
    entityType: EntityType.Task,
    entityId: taskIds[0] ?? '',
    entityIds: taskIds,
    actionPayload: {
      taskIds: [...taskIds],
      today: ctx.today,
      startOfNextDayDiffMs: 0,
      parentTaskMap,
    },
  });

  return { state: next, operations: [operation] };
};

/** Takes tasks out of Today, clearing `dueDay` and Today's ordering entry. */
export const removeTasksFromToday = (
  state: AppState,
  taskIds: readonly string[],
  ctx: ReducerContext,
): MutationResult<AppState> => {
  const missing = taskIds.find((id) => getTask(state, id) === undefined);
  if (missing !== undefined) {
    throw new NotFoundError('Task', missing);
  }

  let next = state;
  for (const taskId of taskIds) {
    next = patchTask(next, taskId, { dueDay: undefined, modified: ctx.now });
    next = removeTaskFromTodayOrder(next, taskId);
  }

  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.taskRemoveFromToday,
    opType: OpType.Update,
    entityType: EntityType.Task,
    entityId: taskIds[0] ?? '',
    entityIds: taskIds,
    actionPayload: { taskIds: [...taskIds] },
  });

  return { state: next, operations: [operation] };
};

// ─── internals ───────────────────────────────────────────────────────────────

/** Moves a task id between tag ordering lists, ignoring the virtual TODAY tag. */
const syncTagMembership = (
  state: AppState,
  taskId: string,
  oldTagIds: readonly string[],
  newTagIds: readonly string[],
): AppState => {
  const oldSet = new Set(oldTagIds);
  const newSet = new Set(newTagIds);

  const toRemove = oldTagIds.filter(
    (id) => !newSet.has(id) && id !== TODAY_TAG_ID && getTag(state, id) !== undefined,
  );
  const toAdd = newTagIds.filter(
    (id) => !oldSet.has(id) && id !== TODAY_TAG_ID && getTag(state, id) !== undefined,
  );

  const updates = [
    ...toRemove.map((tagId) => ({
      id: tagId,
      changes: {
        taskIds: (getTag(state, tagId)?.taskIds ?? []).filter((id) => id !== taskId),
      },
    })),
    ...toAdd.map((tagId) => ({
      id: tagId,
      changes: {
        taskIds: unique([taskId, ...(getTag(state, tagId)?.taskIds ?? [])]),
      },
    })),
  ];

  return updates.length > 0 ? updateTags(state, updates) : state;
};

/** Moves a task, and its subtasks, into a different project. */
const applyProjectMove = (
  state: AppState,
  task: Task,
  targetProjectId: string,
): AppState => {
  if (getProject(state, targetProjectId) === undefined) {
    throw new NotFoundError('Project', targetProjectId);
  }
  // Subtasks inherit their project from the parent; moving one independently
  // would split a parent from its children across two projects.
  if (task.parentId !== undefined) {
    throw new ValidationError(
      `Task ${task.id} is a subtask and inherits its project from its parent. ` +
        'Move the parent task instead.',
    );
  }

  const subTaskIds = collectSubTaskIds(state, task.id);
  const allIds = [task.id, ...subTaskIds];

  let next = removeTasksFromAllProjects(state, allIds);
  const target = getProject(next, targetProjectId);
  /* c8 ignore next 3 -- existence checked above; removal never deletes a project. */
  if (target === undefined) {
    return next;
  }
  next = updateProject(next, targetProjectId, {
    taskIds: unique([...target.taskIds, task.id]),
  });

  for (const subTaskId of subTaskIds) {
    next = patchTask(next, subTaskId, { projectId: targetProjectId });
  }
  return next;
};

/** Keeps the planner and Today ordering consistent with a new `dueDay`. */
const applyDueDayChange = (
  state: AppState,
  task: Task,
  newDueDay: string | null,
  ctx: ReducerContext,
): AppState => {
  const oldDueDay = task.dueDay ?? null;
  if (oldDueDay === newDueDay) {
    return state;
  }

  let next = removeTaskFromPlannerDays(state, task.id);

  if (newDueDay !== null && newDueDay !== ctx.today) {
    next = addTaskToPlannerDay(next, task.id, newDueDay, true);
  }

  if (newDueDay === ctx.today) {
    next = addTaskToTodayOrder(next, task.id);
  } else if (oldDueDay === ctx.today) {
    next = removeTaskFromTodayOrder(next, task.id);
  }

  return next;
};

/**
 * Recomputes a parent's time totals from its subtasks.
 *
 * `timeSpentOnDay` is summed per day and `timeEstimate` becomes the remaining
 * work — done subtasks contribute zero, and an over-run subtask contributes
 * zero rather than a negative. Skipping this leaves the parent showing an
 * estimate it no longer has.
 */
const recalcParentTimes = (state: AppState, parentId: string): AppState => {
  const parent = getTask(state, parentId);
  if (parent === undefined) {
    return state;
  }

  const subTasks = parent.subTaskIds
    .map((id) => getTask(state, id))
    .filter((task): task is Task => task !== undefined);

  const timeSpentOnDay: Record<string, number> = {};
  for (const subTask of subTasks) {
    for (const [day, ms] of Object.entries(subTask.timeSpentOnDay)) {
      timeSpentOnDay[day] = (timeSpentOnDay[day] ?? 0) + ms;
    }
  }

  const timeEstimate = subTasks.reduce<number>(
    (total, subTask) =>
      total +
      (subTask.isDone ? 0 : Math.max(0, subTask.timeEstimate - subTask.timeSpent)),
    0,
  );

  return patchTask(state, parentId, {
    timeSpentOnDay,
    timeSpent: calcTotalTimeSpent(timeSpentOnDay),
    timeEstimate,
  });
};

/** Convenience view used by read models: a task with its subtasks resolved. */
export interface TaskWithSubTasks extends Task {
  readonly subTasks: Task[];
}

export const withSubTasks = (state: AppState, task: Task): TaskWithSubTasks => ({
  ...task,
  subTasks: task.subTaskIds
    .map((id) => getTask(state, id))
    .filter((sub): sub is Task => sub !== undefined),
});

/** `YYYY-MM-DD` for a timestamp, re-exported for callers building read models. */
export { toDayString };
