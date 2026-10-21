import {
  RemoteAccessError,
  RemoteFileNotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import type { Logger } from '../../domain/ports.js';
import type { CalendarInfo } from '../../domain/caldav/event.js';
import {
  normaliseHref,
  parseCalendarList,
  parseEventReport,
  type EventResource,
} from './xml.js';

/**
 * A CalDAV client scoped to one Nextcloud calendar home.
 *
 * Deliberately separate from `WebdavClient`: the sync file lives at a fixed
 * path and uses `If-Match`, while calendars are discovered with PROPFIND and
 * queried with REPORT. Forcing both through one abstraction would produce an
 * interface that fits neither.
 *
 * Like the WebDAV client, it never forwards credentials to a different origin:
 * redirects are followed manually, and only a same-origin `http:` → `https:`
 * upgrade is honoured.
 */

export interface CaldavClientOptions {
  /**
   * Server root (`https://cloud.example.com`), DAV root, calendar home, or a
   * single calendar URL. All four are accepted because operators paste all four.
   */
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
}

export interface CaldavDateRange {
  readonly from: Date;
  readonly to: Date;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns/">
  <d:prop>
    <d:resourcetype />
    <d:displayname />
    <d:current-user-privilege-set />
    <c:supported-calendar-component-set />
    <cs:getctag />
    <oc:calendar-color />
    <c:calendar-description />
  </d:prop>
</d:propfind>`;

const reportBody = (range: CaldavDateRange | null): string => {
  const stamp = (date: Date): string =>
    date
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const timeRange =
    range === null
      ? ''
      : `\n        <c:time-range start="${stamp(range.from)}" end="${stamp(range.to)}" />`;
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">${timeRange}
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
};

const withSlash = (value: string): string => (value.endsWith('/') ? value : `${value}/`);

/**
 * Where the calendar collections live.
 *
 * The explicit-calendar case matters: pointing `CALDAV_URL` at
 * `…/calendars/alice/personal/` should expose that one calendar, not every
 * sibling in the account.
 */
export const resolveCalendarHome = (baseUrl: string, username: string): string => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const user = encodeURIComponent(username);

  if (/\/calendars\/[^/]+\/[^/]+$/i.test(path)) {
    return withSlash(path.slice(0, path.lastIndexOf('/')));
  }
  if (/\/calendars\/[^/]+$/i.test(path)) {
    return withSlash(path);
  }
  if (/\/remote\.php\/dav$/i.test(path)) {
    return `${path}/calendars/${user}/`;
  }
  if (path === '') {
    return `/remote.php/dav/calendars/${user}/`;
  }
  // A bare DAV server (Radicale, Baïkal) usually exposes the home at the root.
  return withSlash(path);
};

/** The one calendar the operator pinned via a full calendar URL, if any. */
const pinnedCalendar = (baseUrl: string): string | null => {
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '');
  return /\/calendars\/[^/]+\/[^/]+$/i.test(path) ? withSlash(path) : null;
};

export class CaldavClient {
  readonly #base: URL;
  readonly #home: string;
  readonly #pinnedCalendar: string | null;
  readonly #username: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #logger: Logger | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: CaldavClientOptions) {
    this.#base = new URL(options.baseUrl);
    this.#home = resolveCalendarHome(options.baseUrl, options.username);
    this.#pinnedCalendar = pinnedCalendar(options.baseUrl);
    this.#username = options.username;
    this.#authorization = `Basic ${Buffer.from(
      `${options.username}:${options.password}`,
      'utf8',
    ).toString('base64')}`;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get calendarHome(): string {
    return this.#home;
  }

  /** Absolute URL for a server href, refusing to cross origins. */
  #url(href: string): URL {
    const resolved = new URL(href, this.#base);
    if (resolved.origin !== this.#base.origin) {
      throw new ValidationError(
        `Refusing to follow a calendar link to another host: ${resolved.origin}`,
      );
    }
    return resolved;
  }

  async #request(
    method: string,
    href: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    let url = this.#url(href);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            authorization: this.#authorization,
            ...(init.headers ?? {}),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        throw new RemoteAccessError(`Could not reach the calendar server`, {
          cause: error,
        });
      }

      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      const location = response.headers.get('location');
      if (location === null) {
        return response;
      }
      const next = new URL(location, url);
      // Only an upgrade on the same host is allowed; a redirect to another host
      // is where credentials would leak.
      if (next.host !== url.host) {
        throw new RemoteAccessError(
          `Refusing to follow a calendar redirect to another host: ${next.origin}`,
          { status: response.status, isRetryable: false },
        );
      }
      url = next;
    }

    throw new RemoteAccessError('Too many calendar redirects', {
      status: 310,
      isRetryable: false,
    });
  }

  async #expect(response: Response, what: string): Promise<Response> {
    if (response.ok) {
      return response;
    }
    const body = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new RemoteFileNotFoundError(what);
    }
    throw new RemoteAccessError(
      `${what} failed with HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`,
      { status: response.status },
    );
  }

  /** Lists the calendars under the configured home. */
  async listCalendars(): Promise<CalendarInfo[]> {
    const response = await this.#request('PROPFIND', this.#home, {
      body: PROPFIND_BODY,
      headers: {
        depth: '1',
        'content-type': 'application/xml; charset=utf-8',
        accept: 'application/xml, text/xml',
      },
    });
    await this.#expect(response, 'Listing calendars');

    const calendars = parseCalendarList(await response.text(), this.#home);
    this.#logger?.debug('Discovered calendars', {
      home: this.#home,
      count: calendars.length,
    });

    if (this.#pinnedCalendar === null) {
      return calendars;
    }
    return calendars.filter((calendar) => calendar.href === this.#pinnedCalendar);
  }

  /** Raw `.ics` resources overlapping a window, from one calendar. */
  async listEventResources(
    calendarHref: string,
    range: CaldavDateRange,
  ): Promise<EventResource[]> {
    return this.#report(calendarHref, range);
  }

  /**
   * Every resource in a calendar, with no time filter.
   *
   * Used only to resolve a UID that was not stored under the filename we
   * guessed. Deliberately not used for listings: it scales with the whole
   * calendar rather than a window.
   */
  async listAllEventResources(calendarHref: string): Promise<EventResource[]> {
    return this.#report(calendarHref, null);
  }

  async #report(
    calendarHref: string,
    range: CaldavDateRange | null,
  ): Promise<EventResource[]> {
    const response = await this.#request('REPORT', withSlash(calendarHref), {
      body: reportBody(range),
      headers: {
        depth: '1',
        'content-type': 'application/xml; charset=utf-8',
        accept: 'application/xml, text/xml',
      },
    });
    await this.#expect(response, `Querying calendar ${calendarHref}`);
    return parseEventReport(await response.text());
  }

  async getEventResource(href: string): Promise<EventResource> {
    const response = await this.#request('GET', href, {
      headers: { accept: 'text/calendar' },
    });
    await this.#expect(response, `Reading calendar event ${href}`);
    const etagHeader = response.headers.get('etag');
    const etag =
      etagHeader !== null && /^"[\x21\x23-\x7E\x80-\xFF]*"$/.test(etagHeader.trim())
        ? etagHeader.trim()
        : null;
    return { href: normaliseHref(href), etag, ics: await response.text() };
  }

  /**
   * Creates or updates a resource.
   *
   * `etag === null` means "this must not already exist"; a string means "only if
   * it still looks like this". Sending neither would let a concurrent edit be
   * silently overwritten, so there is no third option.
   */
  async putEvent(
    href: string,
    ics: string,
    etag: string | null,
  ): Promise<{ href: string; etag: string | null }> {
    const response = await this.#request('PUT', href, {
      body: ics,
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        ...(etag === null ? { 'if-none-match': '*' } : { 'if-match': etag }),
      },
    });
    await this.#expect(response, `Writing calendar event ${href}`);

    const newEtag = response.headers.get('etag');
    return {
      href: normaliseHref(href),
      etag:
        newEtag !== null && /^"[\x21\x23-\x7E\x80-\xFF]*"$/.test(newEtag.trim())
          ? newEtag.trim()
          : null,
    };
  }

  async deleteEvent(href: string, etag: string | null): Promise<void> {
    const response = await this.#request('DELETE', href, {
      ...(etag === null ? {} : { headers: { 'if-match': etag } }),
    });
    await this.#expect(response, `Deleting calendar event ${href}`);
  }

  /** The credentials this client is using, for diagnostics without the secret. */
  describe(): { home: string; username: string; baseUrl: string } {
    return {
      home: this.#home,
      username: this.#username,
      baseUrl: this.#base.origin,
    };
  }
}
