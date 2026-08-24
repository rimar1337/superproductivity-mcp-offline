import {
  addIdToList,
  getEntity,
  removeIdsFromList,
  unique,
  updateMany,
  updateOne,
} from '../model/entity-state.js';
import {
  type AppState,
  type Project,
  type Tag,
  type Task,
  TODAY_TAG_ID,
} from '../model/app-state.js';

/**
 * Cross-slice helpers shared by every reducer.
 *
 * These are ports of `task-shared-helpers.ts` upstream. They look trivial, and
 * that is the point: a task's membership in a project, a tag and the planner is
 * denormalised across four slices, so "add a task" is really "insert one id into
 * up to four ordered lists, in the right position, without duplicating it".
 * Doing that inline at each call site is precisely how `ids` and `entities`
 * drift apart — the drift Super Productivity reports as a corrupt database and
 * "repairs" by duplicating every task.
 */

/** Local date as `YYYY-MM-DD`, the key format Super Productivity uses for days. */
export const toDayString = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Whether a timestamp falls on `todayStr`, honouring the user's "start of next
 * day" offset.
 *
 * The offset is why this is not a plain date comparison: a user whose day rolls
 * over at 04:00 considers 01:30 to still be yesterday, and scheduling a task for
 * 01:30 tonight must not silently drop it out of Today.
 */
export const isOnDay = (
  timestamp: number,
  dayStr: string,
  startOfNextDayDiffMs = 0,
): boolean => toDayString(timestamp - startOfNextDayDiffMs) === dayStr;

export const getTask = (state: AppState, taskId: string): Task | undefined =>
  getEntity(state.task, taskId);

export const getProject = (state: AppState, projectId: string): Project | undefined =>
  getEntity(state.project, projectId);

export const getTag = (state: AppState, tagId: string): Tag | undefined =>
  getEntity(state.tag, tagId);

export const updateTask = (
  state: AppState,
  taskId: string,
  changes: Partial<Task>,
): AppState => ({ ...state, task: updateOne(state.task, taskId, changes) });

export const updateProject = (
  state: AppState,
  projectId: string,
  changes: Partial<Project>,
): AppState => ({ ...state, project: updateOne(state.project, projectId, changes) });

export const updateTags = (
  state: AppState,
  updates: readonly { id: string; changes: Partial<Tag> }[],
): AppState => ({ ...state, tag: updateMany(state.tag, updates) });

/**
 * Adds a task id to every tag that exists, at the requested end.
 *
 * Silently skips tag ids with no matching tag. That tolerance is deliberate:
 * during replay a task can reference a tag whose creation operation has not
 * arrived yet, and throwing there would abort an otherwise valid sync.
 */
export const addTaskToTags = (
  state: AppState,
  taskId: string,
  tagIds: readonly string[],
  toBottom: boolean,
): AppState => {
  const updates = tagIds
    .filter((tagId) => getTag(state, tagId) !== undefined)
    .map((tagId) => ({
      id: tagId,
      changes: {
        taskIds: addIdToList(getTag(state, tagId)?.taskIds ?? [], taskId, toBottom),
      },
    }));
  return updates.length > 0 ? updateTags(state, updates) : state;
};

/**
 * Removes a task id from every tag in the *current state*.
 *
 * Scans all tags rather than trusting the task's own `tagIds`, mirroring
 * upstream: during sync the receiving client may hold different tag
 * associations than the operation's author did, and a payload-driven cleanup
 * would leave dangling ids behind on exactly those tags.
 */
export const removeTasksFromAllTags = (
  state: AppState,
  taskIds: readonly string[],
): AppState => {
  const updates = state.tag.ids
    .map((tagId) => getTag(state, tagId))
    .filter((tag): tag is Tag => tag !== undefined)
    .filter((tag) => tag.taskIds.some((id) => taskIds.includes(id)))
    .map((tag) => ({
      id: tag.id,
      changes: { taskIds: removeIdsFromList(tag.taskIds, taskIds) },
    }));
  return updates.length > 0 ? updateTags(state, updates) : state;
};

/** Drops task ids from every project's task list and backlog. */
export const removeTasksFromAllProjects = (
  state: AppState,
  taskIds: readonly string[],
): AppState => {
  let next = state;
  for (const projectId of state.project.ids) {
    const project = getProject(next, projectId);
    if (project === undefined) {
      continue;
    }
    const touchesList = project.taskIds.some((id) => taskIds.includes(id));
    const touchesBacklog = project.backlogTaskIds.some((id) => taskIds.includes(id));
    if (!touchesList && !touchesBacklog) {
      continue;
    }
    next = updateProject(next, projectId, {
      taskIds: removeIdsFromList(project.taskIds, taskIds),
      backlogTaskIds: removeIdsFromList(project.backlogTaskIds, taskIds),
    });
  }
  return next;
};

/** Removes a task from every planner day. */
export const removeTaskFromPlannerDays = (state: AppState, taskId: string): AppState => {
  const days = state.planner.days;
  let changed = false;
  const nextDays: Record<string, string[]> = {};
  for (const [day, ids] of Object.entries(days)) {
    if (ids.includes(taskId)) {
      changed = true;
      nextDays[day] = ids.filter((id) => id !== taskId);
    } else {
      nextDays[day] = ids;
    }
  }
  return changed ? { ...state, planner: { ...state.planner, days: nextDays } } : state;
};

/** Adds a task to a planner day, at either end, without duplicating it. */
export const addTaskToPlannerDay = (
  state: AppState,
  taskId: string,
  day: string,
  toBottom: boolean,
): AppState => {
  const existing = state.planner.days[day] ?? [];
  const nextIds = unique(toBottom ? [...existing, taskId] : [taskId, ...existing]);
  return {
    ...state,
    planner: { ...state.planner, days: { ...state.planner.days, [day]: nextIds } },
  };
};

/**
 * Adds a task to the Today tag's ordering list, at the top.
 *
 * Today membership itself is *derived* from `task.dueDay`; this list only fixes
 * the order tasks appear in. Writing to it without also setting `dueDay` would
 * produce a task that orders into Today but is not in it.
 */
export const addTaskToTodayOrder = (state: AppState, taskId: string): AppState => {
  const todayTag = getTag(state, TODAY_TAG_ID);
  if (todayTag === undefined || todayTag.taskIds.includes(taskId)) {
    return state;
  }
  return updateTags(state, [
    { id: TODAY_TAG_ID, changes: { taskIds: unique([taskId, ...todayTag.taskIds]) } },
  ]);
};

/** Removes a task from the Today tag's ordering list. */
export const removeTaskFromTodayOrder = (state: AppState, taskId: string): AppState => {
  const todayTag = getTag(state, TODAY_TAG_ID);
  if (todayTag === undefined || !todayTag.taskIds.includes(taskId)) {
    return state;
  }
  return updateTags(state, [
    {
      id: TODAY_TAG_ID,
      changes: { taskIds: todayTag.taskIds.filter((id) => id !== taskId) },
    },
  ]);
};

/** Sums `timeSpentOnDay`, which is the invariant `task.timeSpent` must hold. */
export const calcTotalTimeSpent = (timeSpentOnDay: Record<string, number>): number =>
  Object.values(timeSpentOnDay).reduce<number>(
    (total, ms) => total + (Number(ms) || 0),
    0,
  );

/** A task plus its subtasks, the shape delete and archive operations carry. */
export const collectSubTaskIds = (state: AppState, taskId: string): string[] => {
  const fromParent = getTask(state, taskId)?.subTaskIds ?? [];
  // Also sweep state for children whose parent never recorded them: that
  // inconsistency is real (upstream logs it as a sync race) and a delete that
  // trusted only `subTaskIds` would strand them as orphans forever.
  const fromState = state.task.ids.filter(
    (id) => getTask(state, id)?.parentId === taskId,
  );
  return unique([...fromParent, ...fromState]);
};
