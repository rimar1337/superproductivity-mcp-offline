import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiagnosticsService } from './application/services/diagnostics-service.js';
import { OrganiserService } from './application/services/organiser-service.js';
import { TaskService } from './application/services/task-service.js';
import { Workspace } from './application/workspace.js';
import { SYNC_FILE_LIMITS } from './domain/sync/sync-file.js';
import type { Clock, FileStore, IdGenerator, Logger } from './domain/ports.js';
import { isWritable, type AppConfig } from './infrastructure/config/config.js';
import { SyncFileGateway } from './infrastructure/sync/sync-file-gateway.js';
import {
  createLogger,
  systemClock,
  systemIdGenerator,
} from './infrastructure/system/index.js';
import {
  buildNextcloudBaseUrl,
  WebdavClient,
} from './infrastructure/webdav/webdav-client.js';
import { registerTools } from './presentation/mcp/register-tools.js';

/**
 * Where every concrete dependency is chosen, and the only place that does.
 *
 * Everything else takes its collaborators as constructor arguments, which is
 * what lets the integration suite run the whole stack against an in-memory
 * store with a frozen clock. That property only holds because there is exactly
 * one `new WebdavClient(...)` in the codebase, and it is here.
 */

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly workspace: Workspace;
  readonly tasks: TaskService;
  readonly organiser: OrganiserService;
  readonly diagnostics: DiagnosticsService;
}

export interface ContainerOverrides {
  readonly store?: FileStore;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
}

export const SERVER_NAME = 'superproductivity-mcp';
export const SERVER_VERSION = '1.0.0';

export const createContainer = (
  config: AppConfig,
  overrides: ContainerOverrides = {},
): Container => {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? systemIdGenerator;

  const store =
    overrides.store ??
    new WebdavClient({
      baseUrl: buildNextcloudBaseUrl(config.serverUrl, config.userName),
      // A Nextcloud instance can accept an email address for login while storing
      // files under a different username, so the two are configured separately.
      username: config.loginName ?? config.userName,
      password: config.password,
      folder: config.syncFolder,
      logger,
      timeoutMs: config.requestTimeoutMs,
    });

  const gateway = new SyncFileGateway({
    store,
    clock,
    logger,
    ...(config.encryptionPassword === undefined
      ? {}
      : { encryptionPassword: config.encryptionPassword }),
  });

  const workspace = new Workspace({
    gateway,
    clock,
    ids,
    logger,
    clientId: config.clientId,
    cacheTtlMs: config.cacheTtlMs,
    writable: isWritable(config),
  });

  return {
    config,
    logger,
    workspace,
    tasks: new TaskService(workspace, clock),
    organiser: new OrganiserService(workspace, clock),
    diagnostics: new DiagnosticsService(workspace, {
      clientId: config.clientId,
      mode: config.mode,
      isEncrypted: config.encryptionPassword !== undefined,
      operationLogCapacity: SYNC_FILE_LIMITS.maxRecentOps,
    }),
  };
};

/**
 * Builds the MCP server.
 *
 * The instructions block is read by the model before it picks a tool, so it
 * carries the two facts that most often produce a wrong first call: that
 * "Today" is derived from due dates rather than being a tag you apply, and that
 * ids come from the listing tools rather than being guessable.
 */
export const createMcpServer = (container: Container): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read and manage the user's Super Productivity tasks, which live in a sync " +
        'file on their Nextcloud. Changes made here appear in their desktop and mobile ' +
        'apps on the next sync.\n\n' +
        'Start with sp_overview: it gives you the current state plus the project and ' +
        'tag ids every other tool needs. Ids are opaque — always take them from a ' +
        'listing tool rather than constructing them.\n\n' +
        '"Today" is not a tag you apply: a task is in Today because its due date is ' +
        'today. Use sp_plan_for_today, or sp_list_tasks with due="today".\n\n' +
        'If a write fails, read the "dataUnchanged" and "retryable" fields in the ' +
        'error before deciding what to do — most failures here should not be retried.',
    },
  );

  registerTools(server, {
    tasks: container.tasks,
    organiser: container.organiser,
    diagnostics: container.diagnostics,
    logger: container.logger,
    writable: isWritable(container.config),
  });

  return server;
};
