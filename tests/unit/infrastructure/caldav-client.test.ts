import { describe, expect, it, vi } from 'vitest';
import {
  CaldavClient,
  resolveCalendarHome,
} from '../../../src/infrastructure/caldav/caldav-client.js';
import { RemoteAccessError } from '../../../src/domain/errors.js';
import { silentLogger } from '../../support/fakes.js';

/**
 * The CalDAV client, driven by a scripted `fetch`.
 *
 * Like the WebDAV suite, the interesting assertions are about what the client
 * refuses to do: send credentials to another host, or write without a
 * validator.
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

const client = (
  responses: ScriptedResponse[],
  baseUrl = 'https://cloud.example.com',
): ReturnType<typeof scriptedFetch> & { client: CaldavClient } => {
  const scripted = scriptedFetch(responses);
  return {
    ...scripted,
    client: new CaldavClient({
      baseUrl,
      username: 'alice',
      password: 'secret',
      logger: silentLogger(),
      fetchImpl: scripted.fetchImpl,
    }),
  };
};

const HOME = '/remote.php/dav/calendars/alice/';

const CALENDAR_LIST = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns/">
  <d:response>
    <d:href>${HOME}</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>${HOME}personal/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Personal</d:displayname>
      <oc:calendar-color>#0082c9</oc:calendar-color>
      <d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
      <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>${HOME}tasks/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Tasks</d:displayname>
      <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:event@example.com',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260824T090000Z',
  'DTEND:20260824T093000Z',
  'SUMMARY:Meeting',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const EVENT_REPORT = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${HOME}personal/event.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>"etag-1"</d:getetag>
      <c:calendar-data>${ICS}</c:calendar-data>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

describe('resolveCalendarHome', () => {
  it.each([
    ['https://cloud.example.com', '/remote.php/dav/calendars/alice/'],
    ['https://cloud.example.com/', '/remote.php/dav/calendars/alice/'],
    ['https://cloud.example.com/remote.php/dav', '/remote.php/dav/calendars/alice/'],
    [
      'https://cloud.example.com/remote.php/dav/calendars/alice',
      '/remote.php/dav/calendars/alice/',
    ],
    [
      'https://cloud.example.com/remote.php/dav/calendars/alice/personal/',
      '/remote.php/dav/calendars/alice/',
    ],
    ['https://radicale.example.com/alice/', '/alice/'],
  ])('maps %s to %s', (baseUrl, expected) => {
    expect(resolveCalendarHome(baseUrl, 'alice')).toBe(expected);
  });
});

describe('CaldavClient', () => {
  it('lists calendars, ignores the home and VTODO-only lists', async () => {
    const { client: dav, calls } = client([{ status: 207, body: CALENDAR_LIST }]);

    const calendars = await dav.listCalendars();

    expect(calendars).toEqual([
      {
        href: `${HOME}personal/`,
        displayName: 'Personal',
        color: '#0082c9',
        writable: true,
      },
    ]);
    expect(calls[0]?.url).toBe(`https://cloud.example.com${HOME}`);
    expect((calls[0]?.init.headers as Record<string, string>)['depth']).toBe('1');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toMatch(
      /^Basic /,
    );
  });

  it('pins a single calendar when baseUrl names one', async () => {
    const { client: dav } = client(
      [{ status: 207, body: CALENDAR_LIST }],
      `https://cloud.example.com${HOME}personal/`,
    );
    const calendars = await dav.listCalendars();
    expect(calendars.map((calendar) => calendar.displayName)).toEqual(['Personal']);
  });

  it('reports events with hrefs, etags and calendar data', async () => {
    const { client: dav, calls } = client([{ status: 207, body: EVENT_REPORT }]);

    const resources = await dav.listEventResources(`${HOME}personal/`, {
      from: new Date('2026-08-24T00:00:00Z'),
      to: new Date('2026-08-25T00:00:00Z'),
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]?.href).toBe(`${HOME}personal/event.ics`);
    expect(resources[0]?.etag).toBe('"etag-1"');
    // XML text content is trimmed, so the trailing CRLF is not part of the value.
    expect(resources[0]?.ics.trim()).toBe(ICS.trim());
    expect(calls[0]?.init.method).toBe('REPORT');
    expect(calls[0]?.init.body).toContain('20260824T000000Z');
  });

  it('creates with If-None-Match and updates with If-Match', async () => {
    const { client: dav, calls } = client([
      { status: 201, headers: { etag: '"new"' } },
      { status: 204, headers: { etag: '"next"' } },
    ]);

    await dav.putEvent(`${HOME}personal/new.ics`, ICS, null);
    await dav.putEvent(`${HOME}personal/new.ics`, ICS, '"new"');

    const headers = calls.map((call) => call.init.headers as Record<string, string>);
    expect(headers[0]?.['if-none-match']).toBe('*');
    expect(headers[0]?.['if-match']).toBeUndefined();
    expect(headers[1]?.['if-match']).toBe('"new"');
  });

  it('deletes with the ETag it read', async () => {
    const { client: dav, calls } = client([{ status: 204 }]);

    await dav.deleteEvent(`${HOME}personal/event.ics`, '"etag-1"');

    expect(calls[0]?.init.method).toBe('DELETE');
    expect((calls[0]?.init.headers as Record<string, string>)['if-match']).toBe(
      '"etag-1"',
    );
  });

  it('refuses a redirect to another host', async () => {
    const { client: dav } = client([
      { status: 302, headers: { location: 'https://evil.example.com/steal' } },
    ]);

    await expect(dav.listCalendars()).rejects.toThrow(/another host/);
  });

  it('follows a same-host upgrade', async () => {
    const { client: dav, calls } = client([
      {
        status: 301,
        headers: {
          location: 'https://cloud.example.com/remote.php/dav/calendars/alice/',
        },
      },
      { status: 207, body: CALENDAR_LIST },
    ]);

    await dav.listCalendars();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`https://cloud.example.com${HOME}`);
  });

  it('maps an HTTP failure to a RemoteAccessError', async () => {
    const { client: dav } = client([{ status: 500, body: 'boom' }]);

    await expect(dav.listCalendars()).rejects.toThrow(RemoteAccessError);
  });
});
