import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ValidationError } from '../../domain/errors.js';
import type { Logger } from '../../domain/ports.js';
import type { TaskService } from '../../application/services/task-service.js';
import type { OrganiserService } from '../../application/services/organiser-service.js';
import type { DiagnosticsService } from '../../application/services/diagnostics-service.js';
import type { AddTaskInput, UpdateTaskChanges } from '../../domain/reducers/task.js';
import { guarded, ok, type McpToolResult } from './tool-result.js';
import {
  completeTaskShape,
  createProjectShape,
  createTagShape,
  createTaskShape,
  deleteTaskShape,
  getTaskShape,
  isoToEpoch,
  listProjectsShape,
  listTasksShape,
  minutesToMs,
  planTasksShape,
  recentOperationsShape,
  scheduleTaskShape,
  updateProjectShape,
  updateTagShape,
  updateTaskShape,
} from './schemas.js';

/**
 * The tool surface.
 *
 * Two conventions run through all of it:
 *
 * **Annotations are honest.** `readOnlyHint` and `destructiveHint` are what a
 * host uses to decide whether to ask the user before running something. Marking
 * a delete as non-destructive to reduce friction would defeat the one safeguard
 * standing between a model's misread and the user's task history.
 *
 * **Descriptions say when *not* to use a tool.** A model choosing between
 * `sp_update_task` and `sp_schedule_task` has no other way to know that
 * scheduling emits a different operation, or that passing `TODAY` as a tag is
 * always wrong. Those notes are load-bearing documentation, not commentary.
 */

export interface ToolDependencies {
  readonly tasks: TaskService;
  readonly organiser: OrganiserService;
  readonly diagnostics: DiagnosticsService;
  readonly logger: Logger;
  readonly writable: boolean;
}

export const registerTools = (server: McpServer, deps: ToolDependencies): void => {
  registerReadTools(server, deps);
  if (deps.writable) {
    registerWriteTools(server, deps);
  }
  registerDiagnosticTools(server, deps);
};

const registerReadTools = (server: McpServer, deps: ToolDependencies): void => {
  const { tasks, organiser, logger } = deps;

  server.registerTool(
    'sp_overview',
    {
      title: 'Super Productivity overview',
      description:
        'Where things stand right now: counts of open, overdue and unscheduled work, ' +
        "today's tasks, overdue tasks, and the list of projects and tags with their ids. " +
        'Start here — it answers "what should I be doing" in one call and gives you the ' +
        'ids every other tool needs.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(logger, async () => ok(await organiser.overview())),
  );

  server.registerTool(
    'sp_list_tasks',
    {
      title: 'List tasks',
      description:
        'Search and filter tasks. Combine filters freely: project, tag, completion, ' +
        'schedule and a text search. Results are ordered the way you would work through ' +
        'them — overdue first, then today, then by date, then the unscheduled backlog, ' +
        'with completed tasks last.',
      inputSchema: listTasksShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(logger, async (args) =>
      ok(
        await tasks.list({
          ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
          ...(args.tagId === undefined ? {} : { tagId: args.tagId }),
          ...(args.status === 'any' ? {} : { isDone: args.status === 'done' }),
          due: args.due,
          ...(args.search === undefined ? {} : { search: args.search }),
          includeSubTasks: args.includeSubTasks,
          limit: args.limit,
        }),
      ),
    ),
  );

  server.registerTool(
    'sp_get_task',
    {
      title: 'Get one task',
      description:
        'Everything about a single task, including its notes and the full list of ' +
        'subtasks. Use this before editing, so you change what you think you are changing.',
      inputSchema: getTaskShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(logger, async (args) => ok(await tasks.get(args.taskId))),
  );

  server.registerTool(
    'sp_list_projects',
    {
      title: 'List projects',
      description:
        'All projects with their ids and task counts. Archived projects are hidden ' +
        'unless asked for.',
      inputSchema: listProjectsShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(logger, async (args) =>
      ok(await organiser.listProjects({ includeArchived: args.includeArchived })),
    ),
  );

  server.registerTool(
    'sp_list_tags',
    {
      title: 'List tags',
      description:
        'All tags with their ids. Note that "Today" is a virtual tag: membership comes ' +
        "from a task's due date, so its task count is an ordering artefact rather than " +
        'a real count. To find today\'s work, use sp_list_tasks with due="today".',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(logger, async () => ok(await organiser.listTags())),
  );
};

const registerWriteTools = (server: McpServer, deps: ToolDependencies): void => {
  const { tasks, organiser, logger } = deps;

  server.registerTool(
    'sp_create_task',
    {
      title: 'Create a task',
      description:
        'Adds a task. Only a title is required; without a project it lands in the Inbox. ' +
        'Set dueDay for an all-day date or dueAt for a specific time — never both. ' +
        'Pass parentId to create a subtask instead: subtasks inherit the parent project ' +
        'and cannot carry tags.',
      inputSchema: createTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guarded(logger, async (args) => {
      assertScheduleIsUnambiguous(args.dueDay, args.dueAt);
      const input: AddTaskInput = {
        title: args.title,
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.tagIds === undefined ? {} : { tagIds: args.tagIds }),
        ...optional('timeEstimate', minutesToMs(args.estimateMinutes)),
        ...(args.dueDay === undefined ? {} : { dueDay: args.dueDay }),
        ...optional('dueWithTime', isoToEpoch(args.dueAt)),
        ...optional('remindAt', isoToEpoch(args.remindAt)),
        ...(args.parentId === undefined ? {} : { parentId: args.parentId }),
        isAddToBacklog: args.addToBacklog,
      };
      return ok(await tasks.create(input));
    }),
  );

  server.registerTool(
    'sp_update_task',
    {
      title: 'Update a task',
      description:
        'Changes only the fields you pass, so concurrent edits from other devices ' +
        'survive. Note that tagIds replaces the whole list rather than adding to it. ' +
        'For scheduling use sp_schedule_task instead — it records the change the way ' +
        'Super Productivity does and drives reminders correctly.',
      inputSchema: updateTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded(logger, async (args) => {
      const changes: UpdateTaskChanges = {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.isDone === undefined ? {} : { isDone: args.isDone }),
        ...optional('timeEstimate', minutesToMs(args.estimateMinutes)),
        ...(args.tagIds === undefined ? {} : { tagIds: args.tagIds }),
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      };
      return ok(await tasks.update(args.taskId, changes));
    }),
  );

  server.registerTool(
    'sp_complete_task',
    {
      title: 'Complete or reopen a task',
      description:
        'Marks a task done, or reopens it with isDone=false. Completing records when it ' +
        'was finished and never changes the due date, so a task completed late stays on ' +
        'the day it was planned for.',
      inputSchema: completeTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded(logger, async (args) => ok(await tasks.setDone(args.taskId, args.isDone))),
  );

  server.registerTool(
    'sp_delete_task',
    {
      title: 'Delete a task',
      description:
        'Permanently deletes a task and every subtask under it. There is no undo from ' +
        'here. To get a task out of the way without losing it, complete it instead.',
      inputSchema: deleteTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guarded(logger, async (args) => ok(await tasks.remove(args.taskId))),
  );

  server.registerTool(
    'sp_schedule_task',
    {
      title: 'Schedule a task',
      description:
        'Sets when a task is due: dueDay for an all-day date, dueAt for a specific time ' +
        '(optionally with remindAt), or clear=true to remove the schedule. The two date ' +
        'forms are mutually exclusive — setting one clears the other.',
      inputSchema: scheduleTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded(logger, async (args) => {
      if (args.clear) {
        return ok(await tasks.schedule(args.taskId, { kind: 'clear' }));
      }
      assertScheduleIsUnambiguous(args.dueDay, args.dueAt);
      if (args.dueDay !== undefined) {
        return ok(await tasks.schedule(args.taskId, { kind: 'day', day: args.dueDay }));
      }
      const at = isoToEpoch(args.dueAt);
      if (at === undefined) {
        throw new ValidationError(
          'Provide dueDay, dueAt, or clear=true to say what the schedule should become.',
        );
      }
      const remindAt = isoToEpoch(args.remindAt);
      return ok(
        await tasks.schedule(args.taskId, {
          kind: 'time',
          at,
          ...(remindAt === undefined ? {} : { remindAt }),
        }),
      );
    }),
  );

  server.registerTool(
    'sp_plan_for_today',
    {
      title: 'Plan tasks for today',
      description:
        'Moves tasks into today\'s list. This is the right tool for "do this today" — ' +
        'it records the intent the way the app does, rather than setting a date that ' +
        'happens to be today.',
      inputSchema: planTasksShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded(logger, async (args) => ok(await tasks.planForToday(args.taskIds))),
  );

  server.registerTool(
    'sp_remove_from_today',
    {
      title: 'Remove tasks from today',
      description:
        "Takes tasks out of today's list and back into the unscheduled backlog. The " +
        'tasks themselves are untouched.',
      inputSchema: planTasksShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded(logger, async (args) => ok(await tasks.removeFromToday(args.taskIds))),
  );

  server.registerTool(
    'sp_create_project',
    {
      title: 'Create a project',
      description:
        'Adds a project and puts it in the sidebar. Enable the backlog if the user wants ' +
        'a separate "later" list alongside the active one.',
      inputSchema: createProjectShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guarded(logger, async (args) =>
      ok(
        await organiser.createProject({
          title: args.title,
          ...(args.color === undefined ? {} : { color: args.color }),
          isEnableBacklog: args.enableBacklog,
        }),
      ),
    ),
  );

  server.registerTool(
    'sp_update_project',
    {
      title: 'Update a project',
      description:
        'Renames a project, archives it, or toggles its backlog. Archiving hides a ' +
        'project without deleting anything in it.',
      inputSchema: updateProjectShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded(logger, async (args) =>
      ok(
        await organiser.updateProject(args.projectId, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.isArchived === undefined ? {} : { isArchived: args.isArchived }),
          ...(args.enableBacklog === undefined
            ? {}
            : { isEnableBacklog: args.enableBacklog }),
        }),
      ),
    ),
  );

  server.registerTool(
    'sp_create_tag',
    {
      title: 'Create a tag',
      description:
        'Adds a tag. Check sp_list_tags first — a tag with the same name is rejected, ' +
        'because two tags that read identically are worse than one.',
      inputSchema: createTagShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guarded(logger, async (args) =>
      ok(
        await organiser.createTag({
          title: args.title,
          ...(args.color === undefined ? {} : { color: args.color }),
        }),
      ),
    ),
  );

  server.registerTool(
    'sp_update_tag',
    {
      title: 'Update a tag',
      description:
        'Renames or recolours a tag. The built-in "Today" tag cannot be edited: its ' +
        'membership is computed from due dates.',
      inputSchema: updateTagShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded(logger, async (args) =>
      ok(
        await organiser.updateTag(args.tagId, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.color === undefined ? {} : { color: args.color }),
        }),
      ),
    ),
  );
};

const registerDiagnosticTools = (server: McpServer, deps: ToolDependencies): void => {
  const { diagnostics, logger } = deps;

  server.registerTool(
    'sp_sync_status',
    {
      title: 'Sync status',
      description:
        'How this server is connected: which remote layout the folder uses, which ' +
        'devices have been writing, and whether anything needs attention. Use it when ' +
        'something looks stale or a change has not appeared on another device — the ' +
        'answer is usually here rather than in a retry.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(logger, async () => ok(await diagnostics.status())),
  );

  server.registerTool(
    'sp_recent_activity',
    {
      title: 'Recent activity',
      description:
        'The tail of the sync operation log in plain language: what changed, when, and ' +
        'from which device. Useful for answering "did that actually save" and for ' +
        'seeing what the user did elsewhere.',
      inputSchema: recentOperationsShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(logger, async (args) => ok(await diagnostics.recentOperations(args.limit))),
  );
};

/**
 * Rejects a request that names two contradictory schedules.
 *
 * Silently preferring one would produce a task scheduled for a day the caller
 * did not ask for, and nothing in the response would reveal it.
 */
const assertScheduleIsUnambiguous = (
  dueDay: string | undefined,
  dueAt: string | undefined,
): void => {
  if (dueDay !== undefined && dueAt !== undefined) {
    throw new ValidationError(
      'Pass either dueDay (all-day) or dueAt (specific time), not both.',
      ['Super Productivity stores these as mutually exclusive fields.'],
    );
  }
};

/** Adds a key only when the value is defined, for exactOptionalPropertyTypes. */
const optional = <K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

export type { McpToolResult };
