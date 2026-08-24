import { z } from 'zod';

/**
 * Tool input schemas.
 *
 * These are the model's only documentation, so the descriptions carry real
 * weight — a field described as "estimate" gets milliseconds guessed at, while
 * one described as "in minutes" gets minutes. Units, formats and mutual
 * exclusions are stated on every field where getting them wrong is possible.
 *
 * Durations are accepted in **minutes** even though Super Productivity stores
 * milliseconds. Models reason about "45 minutes", not "2700000", and every
 * millisecond field is an invitation to be off by a factor of sixty.
 */

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date like 2026-08-24');

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 timestamp with a timezone offset, e.g. 2026-08-24T09:30:00-05:00');

export const listTasksShape = {
  projectId: z.string().optional().describe('Only tasks in this project.'),
  tagId: z
    .string()
    .optional()
    .describe('Only tasks with this tag. Use "TODAY" for everything due today.'),
  status: z
    .enum(['open', 'done', 'any'])
    .default('open')
    .describe('Completion filter. Defaults to open tasks only.'),
  due: z
    .enum(['any', 'today', 'overdue', 'upcoming', 'unscheduled'])
    .default('any')
    .describe(
      'Schedule filter. "unscheduled" is the backlog: tasks with no date at all.',
    ),
  search: z
    .string()
    .optional()
    .describe('Case-insensitive text match on title and notes.'),
  includeSubTasks: z
    .boolean()
    .default(false)
    .describe('Include subtasks as top-level results. Off by default.'),
  limit: z.number().int().min(1).max(200).default(50),
};

export const getTaskShape = {
  taskId: z.string().min(1),
};

export const createTaskShape = {
  title: z.string().min(1).describe('What the task is. Required.'),
  projectId: z
    .string()
    .optional()
    .describe('Defaults to the Inbox. Use sp_list_projects to find ids.'),
  notes: z.string().optional().describe('Free-form notes. Markdown is preserved.'),
  tagIds: z
    .array(z.string())
    .optional()
    .describe('Tag ids. Never pass "TODAY" — schedule the task instead.'),
  estimateMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Time estimate in minutes.'),
  dueDay: isoDay.optional().describe('All-day due date. Mutually exclusive with dueAt.'),
  dueAt: isoDateTime
    .optional()
    .describe('Due date with a specific time. Mutually exclusive with dueDay.'),
  remindAt: isoDateTime
    .optional()
    .describe('When to remind. Only meaningful alongside dueAt.'),
  parentId: z
    .string()
    .optional()
    .describe(
      'Create this as a subtask of the given task. Subtasks inherit the parent project ' +
        'and cannot carry tags. Only one level of nesting is supported.',
    ),
  addToBacklog: z
    .boolean()
    .default(false)
    .describe('Put it in the project backlog rather than the active list.'),
};

export const updateTaskShape = {
  taskId: z.string().min(1),
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  isDone: z.boolean().optional().describe('Mark complete or reopen.'),
  estimateMinutes: z.number().int().min(0).optional(),
  tagIds: z
    .array(z.string())
    .optional()
    .describe('Replaces the whole tag list, it does not add to it.'),
  projectId: z
    .string()
    .optional()
    .describe('Move to another project. Subtasks follow their parent automatically.'),
};

export const completeTaskShape = {
  taskId: z.string().min(1),
  isDone: z.boolean().default(true).describe('Pass false to reopen a completed task.'),
};

export const deleteTaskShape = {
  taskId: z.string().min(1).describe('Deletes the task and all of its subtasks.'),
};

export const scheduleTaskShape = {
  taskId: z.string().min(1),
  dueDay: isoDay.optional().describe('All-day date. Mutually exclusive with dueAt.'),
  dueAt: isoDateTime
    .optional()
    .describe('Specific time. Mutually exclusive with dueDay.'),
  remindAt: isoDateTime.optional().describe('Reminder time. Requires dueAt.'),
  clear: z
    .boolean()
    .default(false)
    .describe('Remove the schedule entirely. Ignores the other fields.'),
};

export const planTasksShape = {
  taskIds: z.array(z.string().min(1)).min(1),
};

export const listProjectsShape = {
  includeArchived: z.boolean().default(false),
};

export const createProjectShape = {
  title: z.string().min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like #26c6da')
    .optional(),
  enableBacklog: z
    .boolean()
    .default(false)
    .describe('Give the project a separate backlog list.'),
};

export const updateProjectShape = {
  projectId: z.string().min(1),
  title: z.string().min(1).optional(),
  isArchived: z.boolean().optional(),
  enableBacklog: z.boolean().optional(),
};

export const createTagShape = {
  title: z.string().min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like #ef5350')
    .optional(),
};

export const updateTagShape = {
  tagId: z.string().min(1),
  title: z.string().min(1).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
};

export const recentOperationsShape = {
  limit: z.number().int().min(1).max(100).default(20),
};

/** Minutes in, milliseconds out — the boundary conversion, in one place. */
export const minutesToMs = (minutes: number | undefined): number | undefined =>
  minutes === undefined ? undefined : minutes * 60_000;

/** Parses an ISO timestamp to epoch ms, rejecting anything unparseable. */
export const isoToEpoch = (iso: string | undefined): number | undefined =>
  iso === undefined ? undefined : new Date(iso).getTime();
