import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { getTask } from '../../domain/reducers/shared.js';
import {
  addTask,
  deleteTask,
  planTasksForToday,
  removeTasksFromToday,
  scheduleTaskWithTime,
  unscheduleTask,
  updateTask,
  type AddTaskInput,
  type UpdateTaskChanges,
} from '../../domain/reducers/task.js';
import type { Clock } from '../../domain/ports.js';
import {
  queryTasks,
  toTaskView,
  type ProjectionContext,
  type TaskQuery,
  type TaskQueryResult,
  type TaskView,
} from '../read-models.js';
import type { Workspace } from '../workspace.js';

/**
 * Task use cases.
 *
 * Every write returns the task as it now stands, plus the sync version it
 * landed at. That is not padding: a caller that had to re-read after each write
 * would burn a network round trip per action, and — worse — could observe a
 * *different* device's later state and report it as the result of its own edit.
 */

export interface TaskWriteResult {
  readonly task: TaskView;
  readonly syncVersion: number;
  /** How many attempts the conditional write needed. >1 means contention. */
  readonly attempts: number;
}

export interface BulkWriteResult {
  readonly taskIds: readonly string[];
  readonly syncVersion: number;
  readonly attempts: number;
}

export class TaskService {
  constructor(
    private readonly workspace: Workspace,
    private readonly clock: Clock,
  ) {}

  async list(query: TaskQuery): Promise<TaskQueryResult> {
    const view = await this.workspace.read();
    return queryTasks(view.state, query, this.#context());
  }

  async get(taskId: string): Promise<TaskView> {
    const view = await this.workspace.read();
    const task = getTask(view.state, taskId);
    if (task === undefined) {
      throw new NotFoundError('Task', taskId);
    }
    return toTaskView(view.state, task, this.#context());
  }

  async create(input: AddTaskInput): Promise<TaskWriteResult> {
    const outcome = await this.workspace.mutate('create_task', (state, ctx) =>
      addTask(state, input, ctx),
    );
    return this.#describe(
      outcome.result.task.id,
      outcome.commit.syncVersion,
      outcome.attempts,
    );
  }

  async update(taskId: string, changes: UpdateTaskChanges): Promise<TaskWriteResult> {
    if (Object.keys(changes).length === 0) {
      throw new ValidationError('No fields to update were provided.');
    }
    const outcome = await this.workspace.mutate('update_task', (state, ctx) =>
      updateTask(state, taskId, changes, ctx),
    );
    return this.#describe(taskId, outcome.commit.syncVersion, outcome.attempts);
  }

  async setDone(taskId: string, isDone: boolean): Promise<TaskWriteResult> {
    return this.update(taskId, { isDone });
  }

  async remove(taskId: string): Promise<{ syncVersion: number; attempts: number }> {
    const outcome = await this.workspace.mutate('delete_task', (state, ctx) =>
      deleteTask(state, taskId, ctx),
    );
    return { syncVersion: outcome.commit.syncVersion, attempts: outcome.attempts };
  }

  /**
   * Schedules a task.
   *
   * The two shapes are kept distinct all the way down rather than collapsed
   * into one nullable field, because they emit different operations: an all-day
   * date is an ordinary task update, while a timed one is upstream's dedicated
   * scheduling action that also drives reminders.
   */
  async schedule(
    taskId: string,
    schedule:
      | { readonly kind: 'day'; readonly day: string }
      | { readonly kind: 'time'; readonly at: number; readonly remindAt?: number }
      | { readonly kind: 'clear' },
  ): Promise<TaskWriteResult> {
    if (schedule.kind === 'clear') {
      const outcome = await this.workspace.mutate('unschedule_task', (state, ctx) =>
        unscheduleTask(state, taskId, ctx),
      );
      return this.#describe(taskId, outcome.commit.syncVersion, outcome.attempts);
    }

    if (schedule.kind === 'day') {
      const outcome = await this.workspace.mutate('schedule_task', (state, ctx) =>
        updateTask(state, taskId, { dueDay: schedule.day }, ctx),
      );
      return this.#describe(taskId, outcome.commit.syncVersion, outcome.attempts);
    }

    const outcome = await this.workspace.mutate('schedule_task', (state, ctx) =>
      scheduleTaskWithTime(state, taskId, schedule.at, ctx, {
        ...(schedule.remindAt === undefined ? {} : { remindAt: schedule.remindAt }),
      }),
    );
    return this.#describe(taskId, outcome.commit.syncVersion, outcome.attempts);
  }

  async planForToday(taskIds: readonly string[]): Promise<BulkWriteResult> {
    this.#assertNonEmpty(taskIds);
    const outcome = await this.workspace.mutate('plan_for_today', (state, ctx) =>
      planTasksForToday(state, taskIds, ctx),
    );
    return {
      taskIds: [...taskIds],
      syncVersion: outcome.commit.syncVersion,
      attempts: outcome.attempts,
    };
  }

  async removeFromToday(taskIds: readonly string[]): Promise<BulkWriteResult> {
    this.#assertNonEmpty(taskIds);
    const outcome = await this.workspace.mutate('remove_from_today', (state, ctx) =>
      removeTasksFromToday(state, taskIds, ctx),
    );
    return {
      taskIds: [...taskIds],
      syncVersion: outcome.commit.syncVersion,
      attempts: outcome.attempts,
    };
  }

  #assertNonEmpty(taskIds: readonly string[]): void {
    if (taskIds.length === 0) {
      throw new ValidationError('At least one task id is required.');
    }
  }

  /**
   * Reads the task back from the state we just committed.
   *
   * The read is served from the write's own result rather than the network:
   * re-fetching could pick up a *different* device's later change and report it
   * as the outcome of this edit.
   */
  async #describe(
    taskId: string,
    syncVersion: number,
    attempts: number,
  ): Promise<TaskWriteResult> {
    const view = await this.workspace.read();
    const task = getTask(view.state, taskId);
    if (task === undefined) {
      throw new NotFoundError('Task', taskId);
    }
    return { task: toTaskView(view.state, task, this.#context()), syncVersion, attempts };
  }

  #context(): ProjectionContext {
    return { today: this.clock.today(), now: this.clock.now() };
  }
}
