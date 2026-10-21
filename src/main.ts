#!/usr/bin/env node
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContainer, createMcpServer, SERVER_VERSION } from './composition-root.js';
import { describeUnknownError, SuperProductivityMcpError } from './domain/errors.js';
import {
  describeConfig,
  loadConfig,
  Transport,
  type AppConfig,
} from './infrastructure/config/config.js';
import { loadEnvFile } from './infrastructure/config/dotenv.js';
import { startHttpServer } from './presentation/http/http-server.js';

/**
 * Entry point for both transports.
 *
 * The one rule that shapes this file: **stdout belongs to JSON-RPC.** Every
 * diagnostic, every startup banner, every crash report goes to stderr. A single
 * `console.log` here corrupts the protocol stream in stdio mode and the host
 * drops the connection with no useful error on either side.
 *
 * Stdio stays the default because it is what desktop MCP hosts launch. HTTP is
 * opt-in, because it is the mode that needs a token and a reverse proxy.
 */

const runStdio = async (config: AppConfig): Promise<void> => {
  const container = createContainer(config);
  container.logger.info('Starting Super Productivity MCP server', {
    version: SERVER_VERSION,
    ...describeConfig(config),
  });

  const server = createMcpServer(container);
  await server.connect(new StdioServerTransport());

  container.logger.info('Connected over stdio and ready');

  const shutdown = (signal: string): void => {
    container.logger.info('Shutting down', { signal });
    void server.close().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
};

const runHttp = async (config: AppConfig): Promise<void> => {
  const container = createContainer(config);
  container.logger.info('Starting Super Productivity MCP server', {
    version: SERVER_VERSION,
    ...describeConfig(config),
  });

  const handle = await startHttpServer(container);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    container.logger.info('Shutting down', { signal });
    void handle.close().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
};

const main = async (): Promise<void> => {
  const envPath = process.env['SP_ENV_FILE'] ?? resolve(process.cwd(), '.env');
  const config = loadConfig(loadEnvFile(envPath));

  if (config.transport === Transport.Http) {
    await runHttp(config);
    return;
  }
  await runStdio(config);
};

main().catch((error: unknown) => {
  // Configuration problems are the operator's to fix and deserve the plain
  // message; anything else gets a stack, because it is a bug in here.
  if (error instanceof SuperProductivityMcpError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(
      `Failed to start: ${describeUnknownError(error)}\n` +
        (error instanceof Error && error.stack !== undefined ? `${error.stack}\n` : ''),
    );
  }
  process.exit(1);
});
