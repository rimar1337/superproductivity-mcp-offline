import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/infrastructure/config/config.js';
import { createContainer } from '../../src/composition-root.js';
import { startHttpServer, type HttpHandle } from '../../src/presentation/http/http-server.js';
import { SYNC_FILE_NAMES } from '../../src/domain/sync/sync-file.js';
import { FakeClock, FakeIdGenerator, silentLogger } from '../support/fakes.js';
import { InMemoryFileStore } from '../support/in-memory-file-store.js';
import { FIXTURE_RAW } from '../support/workspace-harness.js';

/**
 * The HTTP transport, driven the way a remote MCP client drives it.
 *
 * What matters here is not the MCP protocol itself — the SDK owns that — but
 * the two things this file adds: authentication and liveness. Both are checked
 * over a real socket rather than through a fake, because middleware that only
 * works in-process is middleware that fails behind a proxy.
 */

const TOKEN = 'test-token-please-ignore';

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  serverUrl: 'https://cloud.example.com',
  userName: 'tester',
  password: 'secret',
  syncFolder: 'super-productivity',
  mode: 'read-only',
  clientId: 'M_HTTPCLIENT',
  cacheTtlMs: 0,
  logLevel: 'silent',
  requestTimeoutMs: 30_000,
  transport: 'http',
  host: '127.0.0.1',
  port: 0,
  authToken: TOKEN,
  calendarMode: 'read-only',
  ...overrides,
});

let handle: HttpHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const start = async (overrides: Partial<AppConfig> = {}): Promise<string> => {
  const store = new InMemoryFileStore();
  store.seed(SYNC_FILE_NAMES.single, FIXTURE_RAW);
  const container = createContainer(config(overrides), {
    store,
    clock: new FakeClock(1_780_000_000_000, '2026-05-29'),
    ids: new FakeIdGenerator('http'),
    logger: silentLogger(),
  });
  handle = await startHttpServer(container);
  return `http://127.0.0.1:${handle.port}`;
};

const rpc = async (
  base: string,
  method: string,
  params: Record<string, unknown> = {},
  token = TOKEN,
): Promise<Response> =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      // An empty token means "send no Authorization header at all".
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const initialize = (base: string): Promise<Response> =>
  rpc(base, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });

describe('HTTP transport', () => {
  it('refuses to start without a bearer token', async () => {
    const store = new InMemoryFileStore();
    const container = createContainer(config({ authToken: undefined }), {
      store,
      logger: silentLogger(),
    });

    await expect(startHttpServer(container)).rejects.toThrow(/MCP_AUTH_TOKEN/);
  });

  it('answers a liveness probe without credentials', async () => {
    const base = await start();
    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('rejects a request with no token', async () => {
    const base = await start();
    const response = await rpc(base, 'initialize', {}, '');

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects a request with the wrong token', async () => {
    const base = await start();
    const response = await rpc(base, 'initialize', {}, 'not-the-token');

    expect(response.status).toBe(401);
  });

  it('completes the handshake and lists tools with a valid token', async () => {
    const base = await start();

    const initResponse = await initialize(base);
    expect(initResponse.status).toBe(200);
    const init = (await initResponse.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(init.result?.serverInfo?.name).toBe('superproductivity-mcp');

    const listResponse = await rpc(base, 'tools/list');
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (list.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('sp_overview');
  });

  it('404s an unknown path and 405s a non-POST', async () => {
    const base = await start();

    const missing = await fetch(`${base}/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.status).toBe(404);

    const wrongMethod = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(wrongMethod.status).toBe(405);
  });
});
