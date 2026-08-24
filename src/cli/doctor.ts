#!/usr/bin/env node
import { resolve } from 'node:path';
import { createContainer, SERVER_VERSION } from '../composition-root.js';
import { describeUnknownError, SuperProductivityMcpError } from '../domain/errors.js';
import { SYNC_FILE_NAMES } from '../domain/sync/sync-file.js';
import { describeConfig, loadConfig } from '../infrastructure/config/config.js';
import { loadEnvFile } from '../infrastructure/config/dotenv.js';
import { createLogger } from '../infrastructure/system/index.js';

/**
 * `npm run doctor` — a read-only pre-flight check.
 *
 * It exists because the failure modes here are all *silent from the outside*:
 * a wrong folder, a password mangled by shell expansion, an encryption setting
 * that does not match the app's. Each of those surfaces inside an MCP host as
 * "the tool didn't work", which is the least useful place to debug it. This
 * runs the same code path the server does, in the terminal, and says which
 * step failed.
 *
 * It never writes.
 */

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: CheckResult[] = [];

const record = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name.padEnd(28)} ${detail}\n`);
};

const main = async (): Promise<number> => {
  process.stdout.write(`Super Productivity MCP — doctor (v${SERVER_VERSION})\n\n`);

  const envPath = process.env['SP_ENV_FILE'] ?? resolve(process.cwd(), '.env');
  const config = loadConfig(loadEnvFile(envPath));
  const summary = describeConfig(config);

  record('configuration', true, `${summary['serverUrl']} as ${summary['userName']}`);
  record('sync folder', true, String(summary['syncFolder']));
  record('mode', true, String(summary['mode']));
  record('client id', true, String(summary['clientId']));
  record(
    'encryption',
    true,
    summary['isEncryptionConfigured'] === true
      ? 'password configured'
      : 'not configured (the sync file must be plaintext)',
  );

  // A silent logger: the report below is the output, and interleaved JSON log
  // lines would bury it.
  const container = createContainer(config, { logger: createLogger('error') });

  let view;
  try {
    view = await container.workspace.read({ forceRefresh: true });
    record('reachable', true, 'Nextcloud answered and the credentials were accepted');
  } catch (error) {
    record('reachable', false, describeUnknownError(error));
    return 1;
  }

  record(
    'sync file',
    true,
    `${view.snapshot.layout} (${
      view.snapshot.layout === 'SINGLE_FILE'
        ? SYNC_FILE_NAMES.single
        : `${SYNC_FILE_NAMES.ops} + ${view.snapshot.revisions.stateFileName ?? SYNC_FILE_NAMES.state}`
    })`,
  );
  record(
    'decoded',
    true,
    `syncVersion ${view.snapshot.syncVersion}, schema ${view.snapshot.schemaVersion}`,
  );

  // A conditional write is only as good as the validator behind it. Say so
  // loudly when the server offers none, because everything still "works" until
  // two devices write at once.
  const hasStrongValidator = view.snapshot.revisions.commitPoint !== null;
  record(
    'conditional writes',
    hasStrongValidator,
    hasStrongValidator
      ? 'the server returns a strong ETag, so concurrent writes are safe'
      : 'no usable ETag — writes will refuse rather than risk overwriting another device',
  );

  const status = await container.diagnostics.status();
  record(
    'devices',
    true,
    status.devices
      .map((device) => `${device.clientId}${device.isThisServer ? ' (this server)' : ''}`)
      .join(', '),
  );
  record(
    'operation log',
    status.operationLog.retained < status.operationLog.capacity,
    `${status.operationLog.retained} of ${status.operationLog.capacity} retained`,
  );

  const overview = await container.organiser.overview();
  record(
    'contents',
    true,
    `${overview.counts.openTasks} open tasks, ${overview.projects.length} projects, ` +
      `${overview.tags.length} tags`,
  );

  if (status.warnings !== undefined) {
    process.stdout.write('\nWarnings:\n');
    for (const warning of status.warnings) {
      process.stdout.write(`  - ${warning}\n`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(
    failed.length === 0
      ? '\nAll checks passed. The MCP server should work.\n'
      : `\n${failed.length} check(s) failed.\n`,
  );
  return failed.length === 0 ? 0 : 1;
};

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `\n${
        error instanceof SuperProductivityMcpError
          ? error.message
          : describeUnknownError(error)
      }\n`,
    );
    process.exit(1);
  });
