import type { EntityState } from './entity-state.js';

/**
 * Structural views over Super Productivity's persisted state.
 *
 * Two rules govern every type in this file:
 *
 * 1. **Model only what we read or write.** Super Productivity's real models are
 *    far larger. Restating them here would guarantee drift with every upstream
 *    release.
 * 2. **Never drop what we did not model.** Each interface carries an index
 *    signature and every mutation is a spread, so unmodelled fields — plugin
 *    payloads, issue-integration metadata, fields added next release — survive
 *    the read-modify-write round trip byte-identical.
 *
 * That second rule is the difference between a safe sync peer and a data-loss
 * bug: this server rewrites the whole file, so anything it silently forgets is
 * anything the user silently loses.
 */

/** Milliseconds tracked per `YYYY-MM-DD` day key. */
export type TimeSpentOnDay = Record<string, number>;

/**
 * A task.
 *
 * `dueDay` and `dueWithTime` are mutually exclusive and `dueWithTime` wins when
 * both are somehow present — a rule Super Productivity states explicitly
 * (ARCHITECTURE-DECISIONS.md, Decision #1) and that legacy data violates. Read
 * scheduling through {@link import('../services/task-scheduling.js')} rather
 * than touching these fields directly.
 */
export interface Task {
  id: string;
  title: string;
  isDone: boolean;
  projectId: string;
  tagIds: string[];
  subTaskIds: string[];
  timeSpentOnDay: TimeSpentOnDay;
  timeSpent: number;
  timeEstimate: number;
  created: number;
  attachments: unknown[];
  notes?: string;
  parentId?: string;
  modified?: number;
  doneOn?: number;
  dueDay?: string | null;
  dueWithTime?: number | null;
  hasPlannedTime?: boolean;
  remindAt?: number | null;
  reminderId?: string | null;
  repeatCfgId?: string;
  deadlineDay?: string | null;
  deadlineWithTime?: number | null;
  deadlineRemindAt?: number | null;
  [unmodelledField: string]: unknown;
}

/** A project: a task list plus an optional backlog. */
export interface Project {
  id: string;
  title: string;
  taskIds: string[];
  backlogTaskIds: string[];
  noteIds: string[];
  isArchived: boolean;
  isHiddenFromMenu: boolean;
  isEnableBacklog: boolean;
  isDone?: boolean;
  doneOn?: number | null;
  icon?: string | null;
  theme?: unknown;
  advancedCfg?: unknown;
  [unmodelledField: string]: unknown;
}

/**
 * A tag.
 *
 * `TODAY` is special: it is a *virtual* tag. Membership is derived from
 * `task.dueDay === today`, and `TODAY.taskIds` stores ordering only. `TODAY`
 * must never appear in `task.tagIds` (ARCHITECTURE-DECISIONS.md, Decision #2).
 */
export interface Tag {
  id: string;
  title: string;
  taskIds: string[];
  created?: number;
  color?: string;
  icon?: string | null;
  theme?: unknown;
  advancedCfg?: unknown;
  [unmodelledField: string]: unknown;
}

/** A standalone note, optionally scoped to a project. */
export interface Note {
  id: string;
  content: string;
  created: number;
  modified?: number;
  projectId?: string | null;
  [unmodelledField: string]: unknown;
}

/** Planner assignments: `YYYY-MM-DD` → ordered task ids planned for that day. */
export interface PlannerState {
  days: Record<string, string[]>;
  [unmodelledField: string]: unknown;
}

/**
 * The `state` object inside the sync file.
 *
 * Only the slices this server touches are named; `[unmodelledSlice: string]`
 * carries the rest (globalConfig, boards, metric, timeTracking, issueProvider,
 * simpleCounter, taskRepeatCfg, menuTree, section, plugin data, …) through
 * unchanged.
 */
export interface AppState {
  task: EntityState<Task> & {
    currentTaskId?: string | null;
    selectedTaskId?: string | null;
    lastCurrentTaskId?: string | null;
    isDataLoaded?: boolean;
    [unmodelledField: string]: unknown;
  };
  project: EntityState<Project>;
  tag: EntityState<Tag>;
  note: EntityState<Note> & { todayOrder?: string[] };
  planner: PlannerState;
  [unmodelledSlice: string]: unknown;
}

/** The virtual "Today" tag id. Never store this in `task.tagIds`. */
export const TODAY_TAG_ID = 'TODAY';

/** The default project every task lands in when none is given. */
export const INBOX_PROJECT_ID = 'INBOX_PROJECT';

/** Built-in tag ids Super Productivity ships with. */
export const BUILT_IN_TAG_IDS = {
  today: TODAY_TAG_ID,
  important: 'EM_IMPORTANT',
  urgent: 'EM_URGENT',
  inProgress: 'KANBAN_IN_PROGRESS',
} as const;

/** Strips the virtual `TODAY` tag from a tag-id list. */
export const withoutTodayTag = (tagIds: readonly string[]): string[] =>
  tagIds.filter((id) => id !== TODAY_TAG_ID);
