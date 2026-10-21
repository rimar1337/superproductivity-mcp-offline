import type { CalendarInfo } from '../../domain/caldav/event.js';

/**
 * A small CalDAV multistatus parser.
 *
 * Same rationale as the WebDAV PROPFIND parser: the needed subset is fixed and
 * shallow, namespaces vary by server, and a full XML parser would add an attack
 * surface for no capability we use.
 */

const RESPONSE_BLOCK = /<[a-z0-9]*:?response[\s>][\s\S]*?<\/[a-z0-9]*:?response>/gi;

const tagContent = (xml: string, tag: string): string | null => {
  const pattern = new RegExp(
    `<[a-z0-9]*:?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</[a-z0-9]*:?${tag}>`,
    'i',
  );
  return pattern.exec(xml)?.[1]?.trim() ?? null;
};

const hasTag = (xml: string, tag: string): boolean =>
  new RegExp(`<[a-z0-9]*:?${tag}(?:\\s[^>]*)?\\s*/?>`, 'i').test(xml);

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');

const cdata = (value: string): string =>
  value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');

const STRONG_ETAG = /^"[\x21\x23-\x7E\x80-\xFF]*"$/;

const strongEtag = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }
  const value = decodeXmlEntities(cdata(raw)).trim();
  return STRONG_ETAG.test(value) ? value : null;
};

/** Strips an origin from an href and normalises the trailing slash. */
export const normaliseHref = (href: string): string => {
  const path = ((): string => {
    try {
      return new URL(href, 'http://placeholder.invalid').pathname;
    } catch {
      return href;
    }
  })();
  return path.endsWith('/') ? path : path;
};

const withTrailingSlash = (href: string): string =>
  href.endsWith('/') ? href : `${href}/`;

/**
 * Parses a Depth:1 PROPFIND on the calendar home.
 *
 * The home collection itself is a response too, and is filtered out by href so
 * it cannot masquerade as a calendar with no events.
 */
export const parseCalendarList = (xml: string, homeHref: string): CalendarInfo[] => {
  const home = withTrailingSlash(normaliseHref(homeHref));
  const calendars: CalendarInfo[] = [];

  for (const block of xml.match(RESPONSE_BLOCK) ?? []) {
    const rawHref = tagContent(block, 'href');
    if (rawHref === null) {
      continue;
    }
    const href = withTrailingSlash(normaliseHref(decodeXmlEntities(rawHref)));
    if (href === home) {
      continue;
    }
    if (!hasTag(block, 'collection') || !hasTag(block, 'calendar')) {
      continue;
    }
    // A task list is also a collection; only calendars carry the component set.
    const components = tagContent(block, 'supported-calendar-component-set');
    if (components !== null && !/VEVENT/i.test(components)) {
      continue;
    }

    const privileges = tagContent(block, 'current-user-privilege-set');
    const writable =
      privileges === null
        ? true
        : /<(?:[a-z0-9]+:)?(?:write|write-content)\b/i.test(privileges);

    const name = tagContent(block, 'displayname');
    const description = tagContent(block, 'calendar-description');
    const color = tagContent(block, 'calendar-color');

    calendars.push({
      href,
      displayName:
        name === null || name === ''
          ? decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() ?? href)
          : decodeXmlEntities(cdata(name)),
      ...(description === null || description === ''
        ? {}
        : { description: decodeXmlEntities(cdata(description)) }),
      ...(color === null || color === '' ? {} : { color: decodeXmlEntities(color) }),
      writable,
    });
  }

  return calendars;
};

export interface EventResource {
  readonly href: string;
  readonly etag: string | null;
  readonly ics: string;
}

/** Parses a calendar-query REPORT that asked for `getetag` and `calendar-data`. */
export const parseEventReport = (xml: string): EventResource[] => {
  const resources: EventResource[] = [];

  for (const block of xml.match(RESPONSE_BLOCK) ?? []) {
    const href = tagContent(block, 'href');
    const data = tagContent(block, 'calendar-data');
    if (href === null || data === null) {
      continue;
    }
    resources.push({
      href: normaliseHref(decodeXmlEntities(href)),
      etag: strongEtag(tagContent(block, 'getetag')),
      ics: decodeXmlEntities(cdata(data)),
    });
  }

  return resources;
};
