import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AppConfig } from '../../src/infrastructure/config/config.js';
import { createContainer, createMcpServer } from '../../src/composition-root.js';
import { CalendarService } from '../../src/application/services/calendar-service.js';
import { CaldavClient } from '../../src/infrastructure/caldav/caldav-client.js';
import { SYNC_FILE_NAMES } from '../../src/domain/sync/sync-file.js';
import { FakeClock, FakeIdGenerator, silentLogger } from '../support/fakes.js';
import { InMemoryFileStore } from '../support/in-memory-file-store.js';
import { FIXTURE_RAW } from '../support/workspace-harness.js';

/**
 * Calendar tools through a real MCP client.
 *
 * The CalDAV client underneath is driven by a scripted `fetch`, so these tests
 * assert both halves of the contract: what the model sees, and what actually
 * goes over the wire (conditional headers, preserved ICS lines).
 */

interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

const scriptedFetch = (
  responses: ScriptedResponse[],
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } => {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const scripted = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (scripted === undefined) {
      throw new Error('No scripted response');
    }
    const isBodyless = [204, 205, 304].includes(scripted.status);
    return Promise.resolve(
      new Response(isBodyless ? null : (scripted.body ?? ''), {
        status: scripted.status,
        headers: scripted.headers ?? {},
      }),
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
};

const HOME = '/remote.php/dav/calendars/alice/';

const CALENDAR_LIST = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>${HOME}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>${HOME}personal/</d:href><d:propstat><d:prop>
    <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
    <d:displayname>Personal</d:displayname>
    <d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
    <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
  </d:prop></d:propstat></d:response>
</d:multistatus>`;

const EVENT_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:event@example.com',
  'DTSTAMP:20260101T000000Z',
  'SEQUENCE:2',
  'DTSTART:20260824T090000Z',
  'DTEND:20260824T093000Z',
  'SUMMARY:Existing',
  'ATTENDEE;CN=Someone:mailto:someone@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const EVENT_REPORT = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>${HOME}personal/event.ics</d:href><d:propstat><d:prop>
    <d:getetag>"etag-1"</d:getetag>
    <c:calendar-data>${EVENT_ICS}</c:calendar-data>
  </d:prop></d:propstat></d:response>
</d:multistatus>`;

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  serverUrl: 'https://cloud.example.com',
  userName: 'tester',
  password: 'secret',
  syncFolder: 'super-productivity',
  mode: 'read-only',
  clientId: 'M_CALTEST',
  cacheTtlMs: 0,
  logLevel: 'silent',
  requestTimeoutMs: 30_000,
  transport: 'stdio',
  host: '127.0.0.1',
  port: 8787,
  calendarMode: 'read-only',
  ...overrides,
});

interface Fixture {
  readonly client: Client;
  readonly calls: { url: string; init: RequestInit }[];
  close: () => Promise<void>;
}

const connect = async (
  responses: ScriptedResponse[],
  options: { writable?: boolean } = {},
): Promise<Fixture> => {
  const scripted = scriptedFetch(responses);
  const calendar = new CalendarService({
    client: new CaldavClient({
      baseUrl: 'https://cloud.example.com',
      username: 'alice',
      password: 'secret',
      logger: silentLogger(),
      fetchImpl: scripted.fetchImpl,
    }),
    logger: silentLogger(),
    writable: options.writable ?? false,
    writeCalendarId: 'Personal',
    now: () => new Date('2026-08-01T00:00:00Z'),
  });

  const store = new InMemoryFileStore();
  store.seed(SYNC_FILE_NAMES.single, FIXTURE_RAW);
  const container = createContainer(config(), {
    store,
    clock: new FakeClock(1_780_000_000_000, '2026-05-29'),
    ids: new FakeIdGenerator('cal'),
    logger: silentLogger(),
    calendar,
  });

  const server = createMcpServer(container);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    calls: scripted.calls,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

const parse = <T>(result: unknown): T => {
  const typed = result as { content: { type: string; text: string }[] };
  return JSON.parse(typed.content[0]!.text) as T;
};

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe('calendar tools', () => {
  it('exposes reads but not writes in read-only mode', async () => {
    fixture = await connect([{ status: 207, body: CALENDAR_LIST }]);
    const { tools } = await fixture.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'calendar_list_calendars',
        'calendar_list_events',
        'calendar_get_event',
        'calendar_search_events',
      ]),
    );
    expect(names).not.toContain('calendar_create_event');
    expect(names).not.toContain('calendar_delete_event');
  });

  it('lists calendars with the ids a model needs', async () => {
    fixture = await connect([{ status: 207, body: CALENDAR_LIST }]);
    const result = await fixture.client.callTool({
      name: 'calendar_list_calendars',
      arguments: {},
    });

    const body = parse<{ calendars: { href: string; displayName: string }[] }>(result);
    expect(body.calendars).toEqual([
      { href: `${HOME}personal/`, displayName: 'Personal', writable: true },
    ]);
  });

  it('lists and expands events in a window', async () => {
    fixture = await connect([
      { status: 207, body: CALENDAR_LIST },
      { status: 207, body: EVENT_REPORT },
    ]);

    const result = await fixture.client.callTool({
      name: 'calendar_list_events',
      arguments: { from: '2026-08-24', to: '2026-08-25' },
    });

    const body = parse<{ events: { uid: string; summary: string; start: string }[] }>(
      result,
    );
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.summary).toBe('Existing');
    expect(body.events[0]?.uid).toBe('event@example.com');
  });

  it('creates an event with If-None-Match', async () => {
    fixture = await connect(
      [
        { status: 207, body: CALENDAR_LIST },
        { status: 201, headers: { etag: '"new"' } },
        { status: 200, headers: { etag: '"new"' }, body: EVENT_ICS },
      ],
      { writable: true },
    );

    const result = await fixture.client.callTool({
      name: 'calendar_create_event',
      arguments: {
        summary: 'Focus block',
        start: '2026-08-24T09:00:00Z',
        end: '2026-08-24T10:00:00Z',
      },
    });

    const body = parse<{ summary: string; calendarHref: string }>(result);
    expect(body.summary).toBe('Focus block');

    const put = fixture.calls.find((call) => call.init.method === 'PUT');
    expect(put).toBeDefined();
    expect((put?.init.headers as Record<string, string>)['if-none-match']).toBe('*');
    expect(put?.init.body).toContain('SUMMARY:Focus block');
  });

  it('updates an event, preserving lines it does not model', async () => {
    fixture = await connect(
      [
        { status: 207, body: CALENDAR_LIST },
        { status: 200, headers: { etag: '"etag-1"' }, body: EVENT_ICS },
        { status: 204, headers: { etag: '"etag-2"' } },
        { status: 200, headers: { etag: '"etag-2"' }, body: EVENT_ICS },
      ],
      { writable: true },
    );

    const result = await fixture.client.callTool({
      name: 'calendar_update_event',
      arguments: { eventId: 'event@example.com', summary: 'Renamed' },
    });

    expect(parse<{ summary: string }>(result).summary).toBe('Renamed');

    const put = fixture.calls.find((call) => call.init.method === 'PUT');
    expect((put?.init.headers as Record<string, string>)['if-match']).toBe('"etag-1"');
    expect(put?.init.body).toContain('SUMMARY:Renamed');
    expect(put?.init.body).toContain('ATTENDEE;CN=Someone');
    expect(put?.init.body).toContain('SEQUENCE:3');
  });

  it('deletes an event conditionally and verifies it is gone', async () => {
    fixture = await connect(
      [
        { status: 207, body: CALENDAR_LIST },
        { status: 200, headers: { etag: '"etag-1"' }, body: EVENT_ICS },
        { status: 204 },
        { status: 404 },
      ],
      { writable: true },
    );

    const result = await fixture.client.callTool({
      name: 'calendar_delete_event',
      arguments: { eventId: 'event@example.com' },
    });
    expect(parse<{ deleted: boolean }>(result).deleted).toBe(true);

    const del = fixture.calls.find((call) => call.init.method === 'DELETE');
    expect((del?.init.headers as Record<string, string>)['if-match']).toBe('"etag-1"');
  });

  it('refuses to delete an event served without a strong ETag', async () => {
    fixture = await connect(
      [
        { status: 207, body: CALENDAR_LIST },
        { status: 200, body: EVENT_ICS },
      ],
      { writable: true },
    );

    const result = await fixture.client.callTool({
      name: 'calendar_delete_event',
      arguments: { eventId: 'event@example.com' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/strong ETag/);
    expect(fixture.calls.some((call) => call.init.method === 'DELETE')).toBe(false);
  });

  it('refuses a write in read-only mode at the service boundary', async () => {
    // Writes are not registered in read-only mode, so this asserts the second
    // line of defence: a caller that reaches the service directly still cannot
    // modify the calendar.
    fixture = await connect([], { writable: false });
    const calendar = new CalendarService({
      client: new CaldavClient({
        baseUrl: 'https://cloud.example.com',
        username: 'alice',
        password: 'secret',
        logger: silentLogger(),
      }),
      logger: silentLogger(),
      writable: false,
      writeCalendarId: 'Personal',
      now: () => new Date(),
    });

    await expect(
      calendar.createEvent({ summary: 'Nope', start: '2026-08-24T09:00:00Z' }),
    ).rejects.toThrow(/calendar writes are disabled/);
  });
});
