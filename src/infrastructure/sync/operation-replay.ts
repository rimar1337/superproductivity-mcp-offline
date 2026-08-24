import { addOne, removeMany, unique } from '../../domain/model/entity-state.js';
import type { AppState, Project, Tag, Task } from '../../domain/model/app-state.js';
import { TODAY_TAG_ID, withoutTodayTag } from '../../domain/model/app-state.js';
import type { CompactOperation } from '../../domain/sync/operation.js';
import {
  addTaskToPlannerDay,
  addTaskToTags,
  addTaskToTodayOrder,
  getProject,
  getTag as getTagOrUndefined,
  getTask,
  removeTaskFromPlannerDays,
  removeTaskFromTodayOrder,
  removeTasksFromAllProjects,
  removeTasksFromAllTags,
  updateProject,
  updateTags,
  updateTask,
} from '../../domain/reducers/shared.js';

/**
 * Replays an operation log onto a state snapshot.
 *
 * **Why this exists.** In the split remote layout Super Productivity rewrites
 * `sync-state.json` only when it compacts, which is every ~2000 operations.
 * Between compactions the snapshot is stale by design, and the operations in
 * `sync-ops.json` are what make it current again. Reading the snapshot alone
 * would show the user a view of their tasks that is potentially weeks old, with
 * no indication that anything was missing.
 *
 * **What it deliberately does not do.** This is not a general-purpose
 * reimplementation of every reducer in Super Productivity, and it does not
 * pretend to be one. Operations are sorted into three groups:
 *
 * - *Applied* — the ones this server understands well enough to replay exactly.
 * - *Ignored* — the ones that provably cannot affect tasks, projects, tags or
 *   the planner (board layout, global config, plugin data, metrics, counters).
 *   Skipping them is correct, not approximate.
 * - *Unhandled* — anything else that touches an entity we do model.
 *
 * The third group is reported, never hidden. A caller that sees a non-empty
 * `unhandled` list knows its view may be incomplete and can say so, which is
 * the difference between a stale answer and a silently wrong one.
 *
 * Because the split layout never has this server rewrite `sync-state.json`, an
 * imperfect replay cannot corrupt the remote: at worst a mutation is validated
 * against a slightly wrong picture, and Super Productivity's own reducers treat
 * an operation naming a missing entity as a no-op.
 */

export interface ReplayResult {
  readonly state: AppState;
  readonly appliedCount: number;
  readonly ignoredCount: number;
  /** Action codes touching modelled entities that this version cannot replay. */
  readonly unhandledActionCodes: readonly string[];
}

/** Entity types whose operations cannot affect this server's read model. */
const IRRELEVANT_ENTITY_TYPES = new Set([
  'TIME_TRACKING',
  'GLOBAL_CONFIG',
  'BOARD',
  'PLUGIN_USER_DATA',
  'PLUGIN_METADATA',
  'METRIC',
  'SIMPLE_COUNTER',
  'ISSUE_PROVIDER',
  'MENU_TREE',
  'SECTION',
  'TASK_REPEAT_CFG',
  'NOTE',
  'ALL',
]);

/**
 * Action codes we knowingly skip even though they name a modelled entity,
 * because they change only presentation or bookkeeping we do not surface.
 */
const KNOWINGLY_SKIPPED = new Set([
  'HRX', // reminder dismissed — reminders are not in our read model
  'TUU', // task UI state
  'HMT', // reorder within Today
  'TMU',
  'TMD',
  'TMT',
  'TMB',
  'TMS',
  'WMU',
  'WMD',
  'WMT',
  'WMB',
  'WM',
  'PO', // project ordering
  'GO', // tag ordering
  'XA', // attachments
  'XU',
  'XD',
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asTask = (value: unknown): Task | undefined => {
  const record = asRecord(value);
  return typeof record['id'] === 'string' ? (record as unknown as Task) : undefined;
};

export const replayOperations = (
  baseState: AppState,
  operations: readonly CompactOperation[],
  today: string,
): ReplayResult => {
  let state = baseState;
  let appliedCount = 0;
  let ignoredCount = 0;
  const unhandled = new Set<string>();

  for (const op of operations) {
    if (IRRELEVANT_ENTITY_TYPES.has(op.e) || KNOWINGLY_SKIPPED.has(op.a)) {
      ignoredCount += 1;
      continue;
    }

    const next = applyOperation(state, op, today);
    if (next === null) {
      unhandled.add(op.a);
      continue;
    }
    state = next;
    appliedCount += 1;
  }

  return {
    state,
    appliedCount,
    ignoredCount,
    unhandledActionCodes: [...unhandled].sort(),
  };
};

/** Applies one operation, or returns `null` when this version cannot. */
const applyOperation = (
  state: AppState,
  op: CompactOperation,
  today: string,
): AppState | null => {
  const payload = asRecord(asRecord(op.p)['actionPayload']);

  switch (op.a) {
    case 'HA':
      return applyTaskAdd(state, payload, today);
    case 'TA':
      return applySubTaskAdd(state, payload);
    case 'HU':
    case 'TU':
      return applyTaskUpdate(state, payload, today);
    case 'HD':
      return applyTaskDelete(state, payload);
    case 'HDM':
      return applyTaskDeleteMultiple(state, payload, op);
    case 'HS':
    case 'HSR':
      return applyTaskSchedule(state, payload, today);
    case 'HSX':
      return applyTaskUnschedule(state, payload, op);
    case 'HPT':
      return applyPlanForToday(state, payload, today);
    case 'HRT':
      return applyRemoveFromToday(state, payload);
    case 'HX':
      return applyMoveToArchive(state, payload);
    case 'PA':
      return applyProjectAdd(state, payload);
    case 'PU':
      return applyProjectUpdate(state, payload);
    case 'GA':
      return applyTagAdd(state, payload);
    case 'GU':
      return applyTagUpdate(state, payload);
    case 'GD':
      return applyTagDelete(state, payload, op);
    default:
      return null;
  }
};

const applyTaskAdd = (
  state: AppState,
  payload: Record<string, unknown>,
  today: string,
): AppState | null => {
  const task = asTask(payload['task']);
  if (task === undefined) {
    return null;
  }

  const isAddToBottom = payload['isAddToBottom'] !== false;
  const isAddToBacklog = payload['isAddToBacklog'] === true;
  const stored: Task = { ...task, tagIds: withoutTodayTag(task.tagIds ?? []) };

  let next: AppState = { ...state, task: addOne(state.task, stored.id, stored) };

  const project = getProject(next, stored.projectId);
  if (project !== undefined && stored.parentId === undefined) {
    const list = isAddToBacklog && project.isEnableBacklog ? 'backlogTaskIds' : 'taskIds';
    next = updateProject(next, stored.projectId, {
      [list]: unique(
        isAddToBottom ? [...project[list], stored.id] : [stored.id, ...project[list]],
      ),
    });
  }

  const isForToday = stored.dueDay === today;
  next = addTaskToTags(
    next,
    stored.id,
    [...stored.tagIds, ...(isForToday ? [TODAY_TAG_ID] : [])],
    isAddToBottom,
  );

  if (typeof stored.dueDay === 'string' && stored.dueDay !== today) {
    next = addTaskToPlannerDay(next, stored.id, stored.dueDay, isAddToBottom);
  }
  return next;
};

const applySubTaskAdd = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const task = asTask(payload['task']);
  const parentId = payload['parentId'];
  if (task === undefined || typeof parentId !== 'string') {
    return null;
  }
  const parent = getTask(state, parentId);
  if (parent === undefined) {
    // The parent's own creation is missing from this log window. Adding an
    // orphan would be worse than skipping the operation.
    return state;
  }
  const next: AppState = { ...state, task: addOne(state.task, task.id, task) };
  return updateTask(next, parentId, {
    subTaskIds: unique([...parent.subTaskIds, task.id]),
  });
};

const applyTaskUpdate = (
  state: AppState,
  payload: Record<string, unknown>,
  today: string,
): AppState | null => {
  const update = asRecord(payload['task']);
  const id = update['id'];
  if (typeof id !== 'string') {
    return null;
  }
  const changes = asRecord(update['changes']) as Partial<Task>;
  const current = getTask(state, id);
  if (current === undefined) {
    // Upstream's reducer is a no-op for a missing entity; matching that keeps
    // replay convergent rather than throwing on a partial log.
    return state;
  }

  let next = updateTask(state, id, changes);

  if (Object.prototype.hasOwnProperty.call(changes, 'tagIds')) {
    const nextTagIds = withoutTodayTag(changes.tagIds ?? []);
    // Rebuild membership from the *real* tags only. Sweeping every tag would
    // also strip the task from TODAY's ordering list — and TODAY is virtual,
    // driven by the due date, so a tag edit must leave it alone. Dropping it
    // there would quietly remove a task from the user's Today view.
    next = removeTasksFromRealTags(next, id);
    next = addTaskToTags(next, id, nextTagIds, true);
    next = updateTask(next, id, { tagIds: nextTagIds });
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'dueDay')) {
    const dueDay = changes.dueDay ?? null;
    next = removeTaskFromPlannerDays(next, id);
    if (dueDay === today) {
      next = addTaskToTodayOrder(next, id);
    } else {
      next = removeTaskFromTodayOrder(next, id);
      if (typeof dueDay === 'string') {
        next = addTaskToPlannerDay(next, id, dueDay, true);
      }
    }
  }

  return next;
};

/**
 * Drops a task id from every concrete tag, leaving the virtual TODAY tag alone.
 *
 * TODAY's task list is ordering for a membership derived from due dates, so it
 * is not a tag the task can be "removed from" by editing `tagIds`.
 */
const removeTasksFromRealTags = (state: AppState, taskId: string): AppState => {
  const realTagIds = state.tag.ids.filter((tagId) => tagId !== TODAY_TAG_ID);
  const updates = realTagIds
    .map((tagId) => getTagOrUndefined(state, tagId))
    .filter((tag): tag is Tag => tag?.taskIds.includes(taskId) === true)
    .map((tag) => ({
      id: tag.id,
      changes: { taskIds: tag.taskIds.filter((id) => id !== taskId) },
    }));
  return updates.length > 0 ? updateTags(state, updates) : state;
};

const applyTaskDelete = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const task = asTask(payload['task']);
  if (task === undefined) {
    return null;
  }
  return removeTaskTree(state, [task.id, ...(task.subTaskIds ?? [])]);
};

const applyTaskDeleteMultiple = (
  state: AppState,
  payload: Record<string, unknown>,
  op: CompactOperation,
): AppState | null => {
  const ids = Array.isArray(payload['taskIds'])
    ? (payload['taskIds'] as unknown[]).filter(
        (id): id is string => typeof id === 'string',
      )
    : (op.ds ?? []);
  return ids.length > 0 ? removeTaskTree(state, ids) : state;
};

const removeTaskTree = (state: AppState, rootIds: readonly string[]): AppState => {
  const all = new Set(rootIds);
  for (const id of rootIds) {
    for (const subId of getTask(state, id)?.subTaskIds ?? []) {
      all.add(subId);
    }
  }
  const ids = [...all];

  let next: AppState = { ...state, task: removeMany(state.task, ids) };
  next = removeTasksFromAllProjects(next, ids);
  next = removeTasksFromAllTags(next, ids);
  for (const id of ids) {
    next = removeTaskFromPlannerDays(next, id);
  }
  return next;
};

const applyTaskSchedule = (
  state: AppState,
  payload: Record<string, unknown>,
  today: string,
): AppState | null => {
  const task = asTask(payload['task']);
  const dueWithTime = payload['dueWithTime'];
  if (task === undefined || typeof dueWithTime !== 'number') {
    return null;
  }
  if (getTask(state, task.id) === undefined) {
    return state;
  }

  let next = updateTask(state, task.id, {
    dueWithTime,
    dueDay: undefined,
    hasPlannedTime: true,
    remindAt: typeof payload['remindAt'] === 'number' ? payload['remindAt'] : undefined,
  });
  next = removeTaskFromPlannerDays(next, task.id);
  const scheduledDay = new Date(dueWithTime);
  const dayKey = `${scheduledDay.getFullYear()}-${String(scheduledDay.getMonth() + 1).padStart(2, '0')}-${String(scheduledDay.getDate()).padStart(2, '0')}`;
  return dayKey === today
    ? addTaskToTodayOrder(next, task.id)
    : removeTaskFromTodayOrder(next, task.id);
};

const applyTaskUnschedule = (
  state: AppState,
  payload: Record<string, unknown>,
  op: CompactOperation,
): AppState | null => {
  const id = typeof payload['id'] === 'string' ? payload['id'] : op.d;
  if (id === undefined || getTask(state, id) === undefined) {
    return state;
  }
  let next = updateTask(state, id, {
    dueWithTime: undefined,
    dueDay: undefined,
    hasPlannedTime: undefined,
    remindAt: undefined,
  });
  next = removeTaskFromPlannerDays(next, id);
  return removeTaskFromTodayOrder(next, id);
};

const applyPlanForToday = (
  state: AppState,
  payload: Record<string, unknown>,
  today: string,
): AppState | null => {
  const ids = Array.isArray(payload['taskIds'])
    ? (payload['taskIds'] as unknown[]).filter(
        (id): id is string => typeof id === 'string',
      )
    : null;
  if (ids === null) {
    return null;
  }
  // The operation carries the day it referred to; using our own "today" would
  // misplace an operation authored yesterday.
  const day = typeof payload['today'] === 'string' ? payload['today'] : today;

  let next = state;
  for (const id of ids) {
    if (getTask(next, id) === undefined) {
      continue;
    }
    next = updateTask(next, id, {
      dueDay: day,
      dueWithTime: undefined,
      hasPlannedTime: undefined,
    });
    next = removeTaskFromPlannerDays(next, id);
    if (day === today) {
      next = addTaskToTodayOrder(next, id);
    }
  }
  return next;
};

const applyRemoveFromToday = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const ids = Array.isArray(payload['taskIds'])
    ? (payload['taskIds'] as unknown[]).filter(
        (id): id is string => typeof id === 'string',
      )
    : null;
  if (ids === null) {
    return null;
  }
  let next = state;
  for (const id of ids) {
    if (getTask(next, id) === undefined) {
      continue;
    }
    next = updateTask(next, id, { dueDay: undefined });
    next = removeTaskFromTodayOrder(next, id);
  }
  return next;
};

/**
 * Archived tasks leave the live state.
 *
 * The archive itself is not reconstructed: this server reads archives from the
 * snapshot and never writes them, so a replayed archive operation only needs to
 * stop showing the task as active.
 */
const applyMoveToArchive = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const tasks = payload['tasks'];
  if (!Array.isArray(tasks)) {
    return null;
  }
  const ids = tasks
    .map((task) => asTask(task)?.id)
    .filter((id): id is string => id !== undefined);
  return ids.length > 0 ? removeTaskTree(state, ids) : state;
};

const applyProjectAdd = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const project = asRecord(payload['project']);
  if (typeof project['id'] !== 'string') {
    return null;
  }
  const typed = project as unknown as Project;
  return { ...state, project: addOne(state.project, typed.id, typed) };
};

const applyProjectUpdate = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const update = asRecord(payload['project']);
  const id = update['id'];
  if (typeof id !== 'string') {
    return null;
  }
  return updateProject(state, id, asRecord(update['changes']));
};

const applyTagAdd = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const tag = asRecord(payload['tag']);
  if (typeof tag['id'] !== 'string') {
    return null;
  }
  const typed = tag as unknown as Tag;
  return { ...state, tag: addOne(state.tag, typed.id, typed) };
};

const applyTagUpdate = (
  state: AppState,
  payload: Record<string, unknown>,
): AppState | null => {
  const update = asRecord(payload['tag']);
  const id = update['id'];
  if (typeof id !== 'string') {
    return null;
  }
  return updateTags(state, [{ id, changes: asRecord(update['changes']) }]);
};

const applyTagDelete = (
  state: AppState,
  payload: Record<string, unknown>,
  op: CompactOperation,
): AppState | null => {
  const id = typeof payload['id'] === 'string' ? payload['id'] : op.d;
  if (id === undefined) {
    return null;
  }

  const next: AppState = { ...state, tag: removeMany(state.tag, [id]) };
  // The tag is gone, so every task referencing it must drop the reference —
  // otherwise tasks keep a dangling tag id that no view can resolve.
  const updates = next.task.ids
    .map((taskId) => getTask(next, taskId))
    .filter((task): task is Task => task?.tagIds.includes(id) === true);

  return updates.reduce(
    (acc, task) =>
      updateTask(acc, task.id, { tagIds: task.tagIds.filter((tagId) => tagId !== id) }),
    next,
  );
};
