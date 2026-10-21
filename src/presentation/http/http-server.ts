import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type Container } from '../../composition-root.js';
import { ConfigurationError, describeUnknownError } from '../../domain/errors.js';

/**
 * The Streamable HTTP entry point.
 *
 * Three decisions worth stating:
 *
 * **Stateless.** Every POST builds a short-lived MCP server and transport, then
 * tears both down when the response closes. The workspace cache lives on the
 * shared container, so nothing expensive is rebuilt. Stateful sessions would
 * buy server-initiated notifications, which this server has no use for, and
 * would leak a session map that has to be expired correctly to avoid becoming
 * a memory bug.
 *
 * **Bearer token or nothing.** There is no "auth disabled" mode. An MCP
 * endpoint is a read/write endpoint, and one exposed without a token is one
 * where the only remaining control is the firewall. Startup fails instead.
 *
 * **A health endpoint that does not require the token**, so a supervisor or
 * reverse proxy can probe liveness without holding credentials. It reveals
 * only that the process is up.
 */

const MCP_PATH = '/mcp';
const HEALTH_PATH = '/healthz';

/** A defensive cap: MCP payloads are small, and an unbounded body is a DoS. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const digest = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time-ish token check.
 *
 * Hashing both sides first means the comparison is always over equal lengths,
 * so neither the token's contents nor its length leaks through timing.
 */
const tokenMatches = (expected: string, provided: string): boolean =>
  timingSafeEqual(digest(expected), digest(provided));

const bearerToken = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization;
  if (header === undefined) {
    return undefined;
  }
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return undefined;
  }
  return rest.join(' ').trim();
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });

const sendJson = (
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const rpcError = (code: number, message: string): Record<string, unknown> => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

export interface HttpHandle {
  readonly server: Server;
  readonly port: number;
  close: () => Promise<void>;
}

export const startHttpServer = async (container: Container): Promise<HttpHandle> => {
  const { authToken, host, port } = container.config;
  const logger = container.logger;

  if (authToken === undefined) {
    throw new ConfigurationError(
      'MCP_TRANSPORT=http requires MCP_AUTH_TOKEN. Refusing to expose an ' +
        'unauthenticated MCP endpoint.',
    );
  }

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (path === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (path !== MCP_PATH) {
      sendJson(res, 404, rpcError(-32601, `Unknown path: ${path}`));
      return;
    }

    const provided = bearerToken(req);
    if (provided === undefined || !tokenMatches(authToken, provided)) {
      res.setHeader('www-authenticate', 'Bearer realm="superproductivity-mcp"');
      sendJson(res, 401, rpcError(-32001, 'Missing or invalid bearer token'));
      return;
    }

    // Stateless mode has nowhere to park a stream, so only POST is meaningful.
    // Answering the others explicitly is friendlier than a hung connection.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, rpcError(-32601, `${req.method ?? 'Unknown'} is not supported`));
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      sendJson(
        res,
        400,
        rpcError(-32700, `Could not parse request body: ${describeUnknownError(error)}`),
      );
      return;
    }

    const server = createMcpServer(container);
    // Omitting `sessionIdGenerator` is what puts the transport in stateless
    // mode; `enableJsonResponse` returns a plain JSON body instead of an SSE
    // stream, which is all a stateless server can meaningfully do.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    try {
      // The SDK's `Transport` interface declares `onclose` non-optional, but
      // `StreamableHTTPServerTransport` types it as possibly undefined. The cast
      // is the boundary between those two declarations, not a runtime risk.
      await server.connect(transport as unknown as Transport);
      res.on('close', () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error('HTTP request failed', { error: describeUnknownError(error) });
      if (!res.headersSent) {
        sendJson(res, 500, rpcError(-32603, 'Internal server error'));
      } else {
        res.end();
      }
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      logger.error('Unhandled HTTP error', { error: describeUnknownError(error) });
      if (!res.headersSent) {
        sendJson(res, 500, rpcError(-32603, 'Internal server error'));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  logger.info('Listening over HTTP', { host, port: boundPort, path: MCP_PATH });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };

  return { server, port: boundPort, close };
};
