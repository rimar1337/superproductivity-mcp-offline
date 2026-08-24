import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContainer, createMcpServer } from '../../src/composition-root.js';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config/config.js';
import { loadEnvFile } from '../../src/infrastructure/config/dotenv.js';
import { createLogger } from '../../src/infrastructure/system/index.js';
import {
  buildNextcloudBaseUrl,
  WebdavClient,
} from '../../src/infrastructure/webdav/webdav-client.js';
import { decodeSyncFile } from '../../src/infrastructure/codec/sync-file-codec.js';
import { SYNC_FILE_NAMES } from '../../src/domain/sync/sync-file.js';
import { ConcurrencyError } from '../../src/domain/errors.js';
import type { SingleFileSyncEnvelope } from '../../src/domain/sync/sync-file.js';

/**
 * End-to-end against a real Nextcloud.
 *
 * Everything below this file is exercised elsewhere with fakes; what only a
 * real server can prove is the part that depends on *its* behaviour: whether
 * `OC-ETag` is a usable validator, whether `If-Match` is actually enforced,
 * whether a redirect eats the credentials, whether a 200 KB body survives the
 * round trip byte for byte.
 *
 * It runs in a **separate sandbox folder**, seeded with a copy of the user's
 * real sync file, and deletes it afterwards. The real sync folder is never
 * written to by this suite — a passing test is not worth a corrupted task
 * history.
 *
 * Skips itself when no credentials are configured, so it never reddens a
 * contributor's build.
 */

const loadE2eConfig = (): { config: AppConfig; sandboxFolder: string } | null => {
  const env = loadEnvFile(resolve(process.cwd(), '.env'));
  const sandboxFolder = env['SP_E2E_FOLDER'] ?? 'super-productivity-mcp-e2e';
  try {
    const config = loadConfig({ ...env, SP_SYNC_FOLDER: sandboxFolder });
    return { config, sandboxFolder };
  } catch {
    return null;
  }
};

const setup = loadE2eConfig();

describe.skipIf(setup === null)('Nextcloud end-to-end', () => {
  const config = setup?.config as AppConfig;
  const sandboxFolder = setup?.sandboxFolder as string;
  const logger = createLogger('error');

  /** Points at the user's real folder, read-only, to seed the sandbox from it. */
  let sourceStore: WebdavClient;
  let sandboxStore: WebdavClient;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const realFolder =
      loadEnvFile(resolve(process.cwd(), '.env'))['SP_SYNC_FOLDER'] ??
      'super-productivity';

    sourceStore = new WebdavClient({
      baseUrl: buildNextcloudBaseUrl(config.serverUrl, config.userName),
      username: config.loginName ?? config.userName,
      password: config.password,
      folder: realFolder,
      logger,
    });

    sandboxStore = new WebdavClient({
      baseUrl: buildNextcloudBaseUrl(config.serverUrl, config.userName),
      username: config.loginName ?? config.userName,
      password: config.password,
      folder: sandboxFolder,
      logger,
    });

    await sandboxStore.ensureDirectory('');

    // Seed from the genuine article. A hand-built file would only prove the
    // suite can read what the suite wrote.
    const original = await sourceStore.read(SYNC_FILE_NAMES.single);
    await sandboxStore.write(SYNC_FILE_NAMES.single, original.content, {
      kind: 'overwrite',
    });

    const container = createContainer(config, { logger });
    const server = createMcpServer(container);
    client = new Client({ name: 'e2e', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await close?.();
    // Remove every file we created, then the folder itself.
    for (const name of [
      SYNC_FILE_NAMES.single,
      SYNC_FILE_NAMES.singleBackup,
      'concurrency-probe.txt',
    ]) {
      await sandboxStore?.delete(name).catch(() => undefined);
    }
    await sandboxStore?.delete('').catch(() => undefined);
  });

  const parse = <T>(result: unknown): T => {
    const typed = result as { content: { text: string }[]; isError?: boolean };
    const first = typed.content[0];
    if (first === undefined) {
      throw new Error('Tool returned no content');
    }
    return JSON.parse(first.text) as T;
  };

  let createdTaskId = '';
  let createdProjectId = '';

  it('reads the real sync file through the whole stack', async () => {
    const overview = parse<{
      today: string;
      counts: Record<string, number>;
      projects: { id: string; title: string }[];
    }>(await client.callTool({ name: 'sp_overview', arguments: {} }));

    expect(overview.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(overview.projects.length).toBeGreaterThan(0);
  });

  it('reports the sandbox as a healthy single-file folder', async () => {
    const status = parse<{
      layout: string;
      syncVersion: number;
      thisServerClientId: string;
    }>(await client.callTool({ name: 'sp_sync_status', arguments: {} }));

    expect(status.layout).toBe('SINGLE_FILE');
    expect(status.syncVersion).toBeGreaterThan(0);
    expect(status.thisServerClientId).toMatch(/^M_/);
  });

  it('creates a project over the network', async () => {
    const created = parse<{ project: { id: string; title: string } }>(
      await client.callTool({
        name: 'sp_create_project',
        arguments: { title: 'MCP end-to-end', color: '#26c6da' },
      }),
    );
    createdProjectId = created.project.id;
    expect(created.project.title).toBe('MCP end-to-end');
  });

  it('creates a task in it', async () => {
    const created = parse<{
      task: { id: string; projectTitle: string };
      syncVersion: number;
    }>(
      await client.callTool({
        name: 'sp_create_task',
        arguments: {
          title: 'End-to-end verification task',
          projectId: createdProjectId,
          notes: 'Created by the automated end-to-end suite.',
          estimateMinutes: 25,
        },
      }),
    );
    createdTaskId = created.task.id;
    expect(created.task.projectTitle).toBe('MCP end-to-end');
  });

  it('reads that task back on a fresh request', async () => {
    const task = parse<{ title: string; notes: string; timeEstimate: { text: string } }>(
      await client.callTool({
        name: 'sp_get_task',
        arguments: { taskId: createdTaskId },
      }),
    );
    expect(task.title).toBe('End-to-end verification task');
    expect(task.notes).toBe('Created by the automated end-to-end suite.');
    expect(task.timeEstimate.text).toBe('25m');
  });

  it('schedules it, completes it and reflects both', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3_600_000);
    tomorrow.setHours(9, 0, 0, 0);

    const scheduled = parse<{ task: { due: { kind: string } } }>(
      await client.callTool({
        name: 'sp_schedule_task',
        arguments: { taskId: createdTaskId, dueAt: tomorrow.toISOString() },
      }),
    );
    expect(scheduled.task.due.kind).toBe('time');

    const completed = parse<{ task: { isDone: boolean; completedAt: string } }>(
      await client.callTool({
        name: 'sp_complete_task',
        arguments: { taskId: createdTaskId },
      }),
    );
    expect(completed.task.isDone).toBe(true);
    expect(completed.task.completedAt).toBeDefined();
  });

  it('leaves a file Super Productivity would still accept', async () => {
    // The real prize: after several writes, the remote must still be a valid
    // envelope with an intact operation log, not just something we can re-read.
    const raw = await sandboxStore.read(SYNC_FILE_NAMES.single);
    const decoded = await decodeSyncFile<SingleFileSyncEnvelope>(raw.content, {
      expectEncrypted: false,
    });

    expect(decoded.data.version).toBe(2);
    expect(decoded.data.schemaVersion).toBe(4);
    expect(decoded.modelVersion).toBe(2);
    expect(decoded.data.clientId).toMatch(/^M_/);

    // Our operations are appended to the existing log, not written over it.
    const ours = decoded.data.recentOps.filter((op) => op.c === config.clientId);
    expect(ours.map((op) => op.a)).toEqual(
      expect.arrayContaining(['PA', 'MP', 'HA', 'HS', 'HU']),
    );

    // Every operation carries a clock that includes this server.
    for (const op of ours) {
      expect(op.v[config.clientId]).toBeGreaterThan(0);
    }
    expect(decoded.data.vectorClock[config.clientId]).toBeGreaterThan(0);
  });

  it('preserves the parts of the file it does not manage', async () => {
    const raw = await sandboxStore.read(SYNC_FILE_NAMES.single);
    const decoded = await decodeSyncFile<SingleFileSyncEnvelope>(raw.content, {
      expectEncrypted: false,
    });
    const original = await sourceStore.read(SYNC_FILE_NAMES.single);
    const before = await decodeSyncFile<SingleFileSyncEnvelope>(original.content, {
      expectEncrypted: false,
    });

    expect(decoded.data.archiveYoung).toEqual(before.data.archiveYoung);
    expect(decoded.data.archiveOld).toEqual(before.data.archiveOld);
    expect(decoded.data.state['globalConfig']).toEqual(before.data.state['globalConfig']);
    expect(decoded.data.state['timeTracking']).toEqual(before.data.state['timeTracking']);
  });

  it('keeps a recoverable backup alongside it', async () => {
    const backup = await sandboxStore.stat(SYNC_FILE_NAMES.singleBackup);
    expect(backup).not.toBeNull();
    expect(backup?.size).toBeGreaterThan(1000);
  });

  it('deletes the task it created', async () => {
    await client.callTool({
      name: 'sp_delete_task',
      arguments: { taskId: createdTaskId },
    });

    const gone = parse<{ code: string }>(
      await client.callTool({
        name: 'sp_get_task',
        arguments: { taskId: createdTaskId },
      }),
    );
    expect(gone.code).toBe('NOT_FOUND');
  });

  it('enforces If-Match on the real server', async () => {
    // The single assumption this whole design rests on. If Nextcloud ignored
    // If-Match, every "safe" conditional write would be an unconditional one
    // and concurrent devices would silently overwrite each other.
    const path = 'concurrency-probe.txt';
    await sandboxStore.write(path, 'first', { kind: 'overwrite' });

    const first = await sandboxStore.read(path);
    expect(first.rev).not.toBeNull();

    // Someone else writes.
    await sandboxStore.write(path, 'second', { kind: 'overwrite' });

    // Our stale revision must now be rejected.
    await expect(
      sandboxStore.write(path, 'third', {
        kind: 'match',
        rev: first.rev as string,
      }),
    ).rejects.toThrow(ConcurrencyError);

    expect((await sandboxStore.read(path)).content).toBe('second');
  });

  it('rejects creating a file that already exists', async () => {
    await expect(
      sandboxStore.write(SYNC_FILE_NAMES.single, 'nope', { kind: 'create' }),
    ).rejects.toThrow(ConcurrencyError);
  });
});
