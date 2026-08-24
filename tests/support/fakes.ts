import type { Clock, IdGenerator, Logger } from '../../src/domain/ports.js';
import type { AppState, Project, Tag, Task } from '../../src/domain/model/app-state.js';
import { OperationFactory } from '../../src/domain/sync/operation-factory.js';
import type { ReducerContext } from '../../src/domain/reducers/context.js';
import type { VectorClock } from '../../src/domain/sync/vector-clock.js';
import { toDayString } from '../../src/domain/reducers/shared.js';

/**
 * Deterministic doubles for the injected ports.
 *
 * Freezing time and ids is not a convenience here — it is what lets a test
 * assert on a whole emitted operation, byte for byte, instead of picking at a
 * few fields and hoping the rest is right. The operation *is* the contract with
 * the user's other devices, so the tests compare all of it.
 */

export class FakeClock implements Clock {
  constructor(
    private current: number,
    private currentDay: string,
  ) {}

  now(): number {
    return this.current;
  }

  today(): string {
    return this.currentDay;
  }

  advanceTo(timestamp: number, day?: string): void {
    this.current = timestamp;
    if (day !== undefined) {
      this.currentDay = day;
    }
  }
}

export class FakeIdGenerator implements IdGenerator {
  #entityCounter = 0;
  #operationCounter = 0;

  constructor(private readonly prefix = 'test') {}

  entityId(): string {
    this.#entityCounter += 1;
    return `${this.prefix}-entity-${this.#entityCounter}`;
  }

  operationId(): string {
    this.#operationCounter += 1;
    return `${this.prefix}-op-${this.#operationCounter}`;
  }
}

export const silentLogger = (): Logger => {
  const logger: Logger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return logger;
};

export interface TestContextOptions {
  readonly now?: number;
  readonly today?: string;
  readonly clientId?: string;
  readonly baseClock?: VectorClock;
  readonly schemaVersion?: number;
}

export const FIXED_NOW = 1_780_000_000_000;

/**
 * Derived from {@link FIXED_NOW} rather than written out, so the two can never
 * disagree — and so the suite passes in every timezone instead of only in the
 * one it was written in.
 */
export const FIXED_TODAY = toDayString(FIXED_NOW);

export const makeContext = (options: TestContextOptions = {}): ReducerContext => {
  const now = options.now ?? FIXED_NOW;
  const ids = new FakeIdGenerator();
  return {
    now,
    today: options.today ?? FIXED_TODAY,
    ids,
    operations: new OperationFactory(
      options.baseClock ?? {},
      options.clientId ?? 'MCP_TEST01',
      options.schemaVersion ?? 4,
      ids,
      () => now,
    ),
  };
};

// ─── state builders ──────────────────────────────────────────────────────────

export const makeTask = (overrides: Partial<Task> & { id: string }): Task => ({
  title: 'A task',
  isDone: false,
  projectId: 'INBOX_PROJECT',
  tagIds: [],
  subTaskIds: [],
  timeSpentOnDay: {},
  timeSpent: 0,
  timeEstimate: 0,
  created: FIXED_NOW,
  attachments: [],
  ...overrides,
});

export const makeProject = (overrides: Partial<Project> & { id: string }): Project => ({
  title: 'A project',
  taskIds: [],
  backlogTaskIds: [],
  noteIds: [],
  isArchived: false,
  isHiddenFromMenu: false,
  isEnableBacklog: false,
  ...overrides,
});

export const makeTag = (overrides: Partial<Tag> & { id: string }): Tag => ({
  title: 'A tag',
  taskIds: [],
  ...overrides,
});

export interface StateBuilderInput {
  readonly tasks?: readonly Task[];
  readonly projects?: readonly Project[];
  readonly tags?: readonly Tag[];
  readonly plannerDays?: Record<string, string[]>;
  /** Extra top-level slices, to prove they survive a round trip untouched. */
  readonly extraSlices?: Record<string, unknown>;
}

export const makeState = (input: StateBuilderInput = {}): AppState => {
  const tasks = input.tasks ?? [];
  const projects = input.projects ?? [
    makeProject({ id: 'INBOX_PROJECT', title: 'Inbox' }),
  ];
  const tags = input.tags ?? [makeTag({ id: 'TODAY', title: 'Today' })];

  return {
    task: {
      ids: tasks.map((task) => task.id),
      entities: Object.fromEntries(tasks.map((task) => [task.id, task])),
      currentTaskId: null,
      selectedTaskId: null,
      isDataLoaded: true,
    },
    project: {
      ids: projects.map((project) => project.id),
      entities: Object.fromEntries(projects.map((project) => [project.id, project])),
    },
    tag: {
      ids: tags.map((tag) => tag.id),
      entities: Object.fromEntries(tags.map((tag) => [tag.id, tag])),
    },
    note: { ids: [], entities: {} },
    planner: { days: input.plannerDays ?? {} },
    ...input.extraSlices,
  };
};
