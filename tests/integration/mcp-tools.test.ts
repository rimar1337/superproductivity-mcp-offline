import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer, createMcpServer } from '../../src/composition-root.js';
import type { AppConfig } from '../../src/infrastructure/config/config.js';
import { SYNC_FILE_NAMES } from '../../src/domain/sync/sync-file.js';
import { InMemoryFileStore } from '../support/in-memory-file-store.js';
import {
  FakeClock,
  FakeIdGenerator,
  FIXED_NOW,
  FIXED_TODAY,
  silentLogger,
} from '../support/fakes.js';
import { FIXTURE_RAW } from '../support/workspace-harness.js';

/**
 * The tool surface, driven through a real MCP client over a real transport.
 *
 * This is the layer OpenClaw actually talks to, so it is tested the way OpenClaw
 * uses it: connect, list tools, call them by name with JSON arguments, read the
 * results back. Only the WebDAV transport underneath is substituted.
 */

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  serverUrl: 'https://cloud.example.com',
  userName: 'tester',
  password: 'secret',
  syncFolder: 'super-productivity',
  mode: 'read-write',
  clientId: 'M_TESTCLIENT',
  cacheTtlMs: 0,
  logLevel: 'silent',
  requestTimeoutMs: 30_000,
  ...overrides,
});

interface Fixture {
  readonly client: Client;
  readonly store: InMemoryFileStore;
  close: () => Promise<void>;
}

const connect = async (config: AppConfig = baseConfig()): Promise<Fixture> => {
  const store = new InMemoryFileStore();
  store.seed(SYNC_FILE_NAMES.single, FIXTURE_RAW);

  const container = createContainer(config, {
    store,
    clock: new FakeClock(FIXED_NOW, FIXED_TODAY),
    ids: new FakeIdGenerator('mcp'),
    logger: silentLogger(),
  });

  const server = createMcpServer(container);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    store,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

/** Tool results are JSON in a text block; this is what a caller does with them. */
const parse = <T>(result: unknown): T => {
  const typed = result as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const first = typed.content[0];
  if (first === undefined) {
    throw new Error('Tool returned no content');
  }
  return JSON.parse(first.text) as T;
};

const isError = (result: unknown): boolean =>
  (result as { isError?: boolean }).isError === true;

let fixture: Fixture;

afterEach(async () => {
  await fixture?.close();
});

describe('tool discovery', () => {
  beforeEach(async () => {
    fixture = await connect();
  });

  it('exposes the full surface with usable descriptions', async () => {
    const { tools } = await fixture.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      'sp_complete_task',
      'sp_create_project',
      'sp_create_tag',
      'sp_create_task',
      'sp_delete_task',
      'sp_get_task',
      'sp_list_projects',
      'sp_list_tags',
      'sp_list_tasks',
      'sp_overview',
      'sp_plan_for_today',
      'sp_recent_activity',
      'sp_remove_from_today',
      'sp_schedule_task',
      'sp_sync_status',
      'sp_update_project',
      'sp_update_tag',
      'sp_update_task',
    ]);

    for (const tool of tools) {
      expect(tool.description ?? '').not.toBe('');
    }
  });

  it('marks deletion as destructive so hosts can gate it', async () => {
    // This annotation is what stands between a model's misread and the user's
    // task history, so it is asserted rather than assumed.
    const { tools } = await fixture.client.listTools();
    const remove = tools.find((tool) => tool.name === 'sp_delete_task');
    expect(remove?.annotations?.destructiveHint).toBe(true);

    const complete = tools.find((tool) => tool.name === 'sp_complete_task');
    expect(complete?.annotations?.destructiveHint).toBe(false);
  });

  it('marks every read tool read-only', async () => {
    const { tools } = await fixture.client.listTools();
    for (const name of [
      'sp_overview',
      'sp_list_tasks',
      'sp_get_task',
      'sp_sync_status',
    ]) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(
        true,
      );
    }
  });
});

describe('reading', () => {
  beforeEach(async () => {
    fixture = await connect();
  });

  it('answers "where do things stand" in one call', async () => {
    const overview = parse<{
      today: string;
      counts: Record<string, number>;
      projects: { id: string; title: string }[];
      tags: { id: string; isVirtual: boolean }[];
    }>(await fixture.client.callTool({ name: 'sp_overview', arguments: {} }));

    expect(overview.today).toBe(FIXED_TODAY);
    expect(overview.counts['openTasks']).toBeGreaterThanOrEqual(0);
    expect(overview.projects.some((project) => project.title === 'Inbox')).toBe(true);
    expect(overview.tags.find((tag) => tag.id === 'TODAY')?.isVirtual).toBe(true);
  });

  it('lists tasks with resolved names rather than raw ids', async () => {
    const result = parse<{
      tasks: { id: string; title: string; projectTitle: string }[];
      totalMatching: number;
    }>(
      await fixture.client.callTool({
        name: 'sp_list_tasks',
        arguments: { status: 'any', limit: 5 },
      }),
    );

    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      expect(task.projectTitle).not.toBe('');
      expect(task.id).not.toBe('');
    }
  });

  it('reports the true total when a page is truncated', async () => {
    // "Showing 1 of 8" is actionable; a bare list of 1 implies there is 1.
    const result = parse<{ tasks: unknown[]; totalMatching: number; truncated: boolean }>(
      await fixture.client.callTool({
        name: 'sp_list_tasks',
        arguments: { status: 'any', limit: 1 },
      }),
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.totalMatching).toBeGreaterThan(1);
    expect(result.truncated).toBe(true);
  });

  it('reports a missing task as not-found rather than crashing', async () => {
    const result = await fixture.client.callTool({
      name: 'sp_get_task',
      arguments: { taskId: 'does-not-exist' },
    });
    expect(isError(result)).toBe(true);

    const body = parse<{ code: string; retryable: boolean; dataUnchanged: boolean }>(
      result,
    );
    expect(body.code).toBe('NOT_FOUND');
    expect(body.retryable).toBe(false);
    expect(body.dataUnchanged).toBe(true);
  });
});

describe('writing', () => {
  beforeEach(async () => {
    fixture = await connect();
  });

  it('creates a task and returns it fully resolved', async () => {
    const created = parse<{
      task: {
        id: string;
        title: string;
        projectTitle: string;
        timeEstimate: { text: string };
      };
      syncVersion: number;
    }>(
      await fixture.client.callTool({
        name: 'sp_create_task',
        arguments: { title: 'Ship the MCP server', estimateMinutes: 90 },
      }),
    );

    expect(created.task.title).toBe('Ship the MCP server');
    expect(created.task.projectTitle).toBe('Inbox');
    // Minutes in, human-readable out — the model never sees milliseconds.
    expect(created.task.timeEstimate.text).toBe('1h 30m');
    expect(created.syncVersion).toBe(115);
  });

  it('round-trips a created task through a fresh read', async () => {
    const created = parse<{ task: { id: string } }>(
      await fixture.client.callTool({
        name: 'sp_create_task',
        arguments: { title: 'Round trip' },
      }),
    );

    const fetched = parse<{ title: string }>(
      await fixture.client.callTool({
        name: 'sp_get_task',
        arguments: { taskId: created.task.id },
      }),
    );
    expect(fetched.title).toBe('Round trip');
  });

  it('completes a task and records when', async () => {
    const created = parse<{ task: { id: string } }>(
      await fixture.client.callTool({
        name: 'sp_create_task',
        arguments: { title: 'Finish this' },
      }),
    );

    const completed = parse<{ task: { isDone: boolean; completedAt: string } }>(
      await fixture.client.callTool({
        name: 'sp_complete_task',
        arguments: { taskId: created.task.id },
      }),
    );

    expect(completed.task.isDone).toBe(true);
    expect(completed.task.completedAt).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('rejects a task with two contradictory schedules', async () => {
    const result = await fixture.client.callTool({
      name: 'sp_create_task',
      arguments: {
        title: 'Ambiguous',
        dueDay: '2026-09-01',
        dueAt: '2026-09-01T10:00:00-05:00',
      },
    });

    expect(isError(result)).toBe(true);
    expect(parse<{ code: string }>(result).code).toBe('VALIDATION_ERROR');
  });

  it('schedules a task for a specific time and clears it again', async () => {
    const created = parse<{ task: { id: string } }>(
      await fixture.client.callTool({
        name: 'sp_create_task',
        arguments: { title: 'Standup' },
      }),
    );

    const scheduled = parse<{ task: { due: { kind: string; at: string } } }>(
      await fixture.client.callTool({
        name: 'sp_schedule_task',
        arguments: { taskId: created.task.id, dueAt: '2026-09-01T09:30:00Z' },
      }),
    );
    expect(scheduled.task.due.kind).toBe('time');
    expect(scheduled.task.due.at).toBe('2026-09-01T09:30:00.000Z');

    const cleared = parse<{ task: { due: { kind: string } } }>(
      await fixture.client.callTool({
        name: 'sp_schedule_task',
        arguments: { taskId: created.task.id, clear: true },
      }),
    );
    expect(cleared.task.due.kind).toBe('none');
  });

  it('plans a task for today and takes it back out', async () => {
    const created = parse<{ task: { id: string } }>(
      await fixture.client.callTool({
        name: 'sp_create_task',
        arguments: { title: 'Today please' },
      }),
    );

    await fixture.client.callTool({
      name: 'sp_plan_for_today',
      arguments: { taskIds: [created.task.id] },
    });

    const planned = parse<{ due: { isToday: boolean } }>(
      await fixture.client.callTool({
        name: 'sp_get_task',
        arguments: { taskId: created.task.id },
      }),
    );
    expect(planned.due.isToday).toBe(true);

    await fixture.client.callTool({
      name: 'sp_remove_from_today',
      arguments: { taskIds: [created.task.id] },
    });

    const removed = parse<{ due: { kind: string } }>(
      await fixture.client.callTool({
        name: 'sp_get_task',
        arguments: { taskId: created.task.id },
      }),
    );
    expect(removed.due.kind).toBe('none');
  });

  it('creates a project and puts tasks in it', async () => {
    const project = parse<{ project: { id: string; title: string } }>(
      await fixture.client.callTool({
        name: 'sp_create_project',
        arguments: { title: 'Kitchen renovation', color: '#26c6da' },
      }),
    );

    const task = parse<{ task: { projectTitle: string } }>(
      await fixture.client.callTool({
        name: 'sp_create_task',
        arguments: { title: 'Measure the counters', projectId: project.project.id },
      }),
    );
    expect(task.task.projectTitle).toBe('Kitchen renovation');
  });

  it('refuses a duplicate tag name instead of creating a confusing twin', async () => {
    await fixture.client.callTool({
      name: 'sp_create_tag',
      arguments: { title: 'Errands' },
    });

    const duplicate = await fixture.client.callTool({
      name: 'sp_create_tag',
      arguments: { title: 'errands' },
    });
    expect(isError(duplicate)).toBe(true);
    expect(parse<{ code: string }>(duplicate).code).toBe('VALIDATION_ERROR');
  });

  it('refuses to edit the virtual Today tag', async () => {
    const result = await fixture.client.callTool({
      name: 'sp_update_tag',
      arguments: { tagId: 'TODAY', title: 'Hoy' },
    });
    expect(isError(result)).toBe(true);
  });

  it('deletes a task and everything under it', async () => {
    const parent = parse<{ task: { id: string } }>(
      await fixture.client.callTool({
        name: 'sp_create_task',
        arguments: { title: 'Parent' },
      }),
    );
    await fixture.client.callTool({
      name: 'sp_create_task',
      arguments: { title: 'Child', parentId: parent.task.id },
    });

    await fixture.client.callTool({
      name: 'sp_delete_task',
      arguments: { taskId: parent.task.id },
    });

    const gone = await fixture.client.callTool({
      name: 'sp_get_task',
      arguments: { taskId: parent.task.id },
    });
    expect(parse<{ code: string }>(gone).code).toBe('NOT_FOUND');
  });
});

describe('read-only mode', () => {
  beforeEach(async () => {
    fixture = await connect(baseConfig({ mode: 'read-only' }));
  });

  it('hides every write tool rather than failing at call time', async () => {
    // A tool the model can see is a tool it will try. Not advertising them is
    // clearer than advertising them and refusing.
    const { tools } = await fixture.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('sp_overview');
    expect(names).toContain('sp_sync_status');
    expect(names).not.toContain('sp_create_task');
    expect(names).not.toContain('sp_delete_task');
  });

  it('still reads normally', async () => {
    const overview = parse<{ today: string }>(
      await fixture.client.callTool({ name: 'sp_overview', arguments: {} }),
    );
    expect(overview.today).toBe(FIXED_TODAY);
  });
});

describe('diagnostics', () => {
  beforeEach(async () => {
    fixture = await connect();
  });

  it('reports the layout, the devices and this server’s identity', async () => {
    const status = parse<{
      layout: string;
      syncVersion: number;
      mode: string;
      thisServerClientId: string;
      devices: { clientId: string; isThisServer: boolean }[];
      operationLog: { retained: number; capacity: number };
      warnings?: string[];
    }>(await fixture.client.callTool({ name: 'sp_sync_status', arguments: {} }));

    expect(status.layout).toBe('SINGLE_FILE');
    expect(status.syncVersion).toBe(114);
    expect(status.mode).toBe('read-write');
    expect(status.thisServerClientId).toBe('M_TESTCLIENT');
    expect(status.devices.length).toBeGreaterThan(0);
    expect(status.operationLog.retained).toBe(344);
    // A healthy folder reports no warnings at all, so callers can branch on
    // the field's absence rather than parsing prose.
    expect(status.warnings).toBeUndefined();
  });

  it('explains recent activity in plain language', async () => {
    await fixture.client.callTool({
      name: 'sp_create_task',
      arguments: { title: 'Something new' },
    });

    const activity = parse<{ action: string; by: string; entityType: string }[]>(
      await fixture.client.callTool({
        name: 'sp_recent_activity',
        arguments: { limit: 5 },
      }),
    );

    expect(activity[0]?.action).toBe('Task created');
    expect(activity[0]?.by).toBe('M_TESTCLIENT');
    expect(activity[0]?.entityType).toBe('TASK');
  });
});

describe('failure reporting', () => {
  beforeEach(async () => {
    fixture = await connect();
  });

  it('tells the model the data is unchanged when the remote is unreadable', async () => {
    fixture.store.seed(SYNC_FILE_NAMES.single, 'not a sync file at all');

    const result = await fixture.client.callTool({ name: 'sp_overview', arguments: {} });
    const body = parse<{
      code: string;
      retryable: boolean;
      dataUnchanged: boolean;
      nextStep: string;
    }>(result);

    expect(body.code).toBe('SYNC_FORMAT_ERROR');
    expect(body.retryable).toBe(false);
    expect(body.dataUnchanged).toBe(true);
    expect(body.nextStep).toContain('Do not retry');
  });

  it('rejects malformed arguments at the schema boundary', async () => {
    const result = await fixture.client.callTool({
      name: 'sp_create_task',
      arguments: { title: '' },
    });
    expect(isError(result)).toBe(true);
  });
});
