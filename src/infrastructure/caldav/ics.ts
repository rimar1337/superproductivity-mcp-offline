import { expandRecurringEvent, sync as icalSync, type VEvent } from 'node-ical';
import type {
  CalendarEvent,
  CreateEventInput,
  UpdateEventInput,
} from '../../domain/caldav/event.js';
import { ValidationError } from '../../domain/errors.js';

/**
 * iCalendar reading, writing and occurrence expansion.
 *
 * Parsing and RRULE expansion are delegated to `node-ical`, because recurrence
 * rules and timezones are exactly the sort of thing a hand-rolled parser gets
 * subtly wrong. Writing is ours, and is deliberately **line-preserving**: an
 * update rewrites only the properties the caller changed and leaves everything
 * else — alarms, attendees, categories, recurrence rules — byte-identical.
 * Re-serialising a whole VEVENT from a model would silently drop whatever the
 * model did not know about, which on someone's real calendar is data loss.
 */

/** A VEVENT plus the metadata about where it came from. */
export interface ParsedEvent {
  readonly base: CalendarEvent;
  readonly source: VEvent;
}

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (value !== null && typeof value === 'object' && 'val' in value) {
    const val = (value as { val?: unknown }).val;
    return typeof val === 'string' ? val : undefined;
  }
  return undefined;
};

const toIso = (value: unknown): string | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return null;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const isDateOnly = (value: string): boolean => DATE_ONLY.test(value);

const assertDate = (value: string, field: string): Date => {
  const parsed = new Date(isDateOnly(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} is not a valid date or timestamp: "${value}"`);
  }
  return parsed;
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** RFC 5545 UTC timestamp: `20260824T093000Z`. */
const icsUtc = (value: Date): string =>
  `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}T` +
  `${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;

/** RFC 5545 date: `20260824`. */
const icsDate = (value: Date): string =>
  `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}`;

const nextDay = (value: string): string => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/** Escapes a TEXT value per RFC 5545 §3.3.11. */
const escapeText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** Folds a content line at 75 octets, continuing with a single space. */
const foldLine = (line: string): string[] => {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) {
    return [line];
  }

  const out: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    // Do not split a multi-byte character across lines.
    let end = Math.min(offset + limit, bytes.length);
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    const chunk = bytes.subarray(offset, end).toString('utf8');
    out.push(offset === 0 ? chunk : ` ${chunk}`);
    offset = end;
    limit = 74; // the leading space counts toward the octet limit
  }
  return out;
};

/**
 * Refuses to emit something the server would reject with an opaque 415.
 *
 * Two invariants are load-bearing and easy to break: physical lines stay within
 * 75 octets, and a line that is not a property (`NAME:value`) must be a folded
 * continuation — i.e. start with a space. Emitting an unfolded chunk without
 * that space turns the rest of a long DESCRIPTION into invalid content lines.
 */
const assertWellFormed = (ics: string): string => {
  const physical = ics.split('\r\n');
  physical.forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    if (line.includes('\r') || line.includes('\n')) {
      throw new ValidationError(
        `Refusing to write iCalendar with a raw newline inside physical line ${index + 1}.`,
      );
    }
    const octets = Buffer.byteLength(line, 'utf8');
    if (octets > 75) {
      throw new ValidationError(
        `Refusing to write iCalendar: physical line ${index + 1} is ${octets} octets (max 75).`,
      );
    }
    if (
      index > 0 &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !/[;:]/.test(line)
    ) {
      throw new ValidationError(
        `Refusing to write iCalendar: line ${index + 1} looks like an unfolded ` +
          'continuation (no property name, no leading space).',
      );
    }
  });
  return ics;
};

const dtStartLine = (value: string, allDay: boolean): string =>
  allDay
    ? `DTSTART;VALUE=DATE:${icsDate(assertDate(value, 'start'))}`
    : `DTSTART:${icsUtc(assertDate(value, 'start'))}`;

const dtEndLine = (value: string, allDay: boolean): string =>
  allDay
    ? `DTEND;VALUE=DATE:${icsDate(assertDate(value, 'end'))}`
    : `DTEND:${icsUtc(assertDate(value, 'end'))}`;

/**
 * Builds a complete VCALENDAR containing one VEVENT.
 *
 * `now` is injected so tests are not clock-dependent, and `sequence` is a
 * parameter because an update must increment whatever the server already had.
 */
export const buildEventIcs = (
  input: CreateEventInput,
  options: { uid: string; now: Date; sequence?: number; prodId?: string },
): string => {
  const allDay = input.allDay ?? isDateOnly(input.start);
  const start = assertDate(input.start, 'start');
  const end = input.end === undefined ? null : assertDate(input.end, 'end');

  if (end !== null && end.getTime() <= start.getTime()) {
    throw new ValidationError('end must be later than start');
  }

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${options.prodId ?? '-//superproductivity-mcp//EN'}`,
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${options.uid}`,
    `DTSTAMP:${icsUtc(options.now)}`,
    `SEQUENCE:${options.sequence ?? 0}`,
    dtStartLine(input.start, allDay),
  ];

  if (allDay) {
    // DTEND is exclusive for all-day events; a one-day event ends tomorrow.
    const endValue = input.end ?? nextDay(input.start);
    lines.push(`DTEND;VALUE=DATE:${icsDate(assertDate(endValue, 'end'))}`);
  } else if (end === null) {
    lines.push(`DTEND:${icsUtc(new Date(start.getTime() + 60 * 60 * 1000))}`);
  } else {
    lines.push(`DTEND:${icsUtc(end)}`);
  }

  lines.push(`SUMMARY:${escapeText(input.summary)}`);
  if (input.description !== undefined) {
    lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  }
  if (input.location !== undefined) {
    lines.push(`LOCATION:${escapeText(input.location)}`);
  }
  lines.push('STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR');

  return assertWellFormed(lines.flatMap(foldLine).join('\r\n') + '\r\n');
};

/** Unfolds CRLF- or LF-terminated content lines. */
const unfold = (ics: string): string[] => {
  const physical = ics.replace(/\r\n/g, '\n').split('\n');
  const logical: string[] = [];
  for (const line of physical) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const last = logical.length - 1;
      if (last >= 0) {
        logical[last] = (logical[last] ?? '') + line.slice(1);
      }
      continue;
    }
    logical.push(line);
  }
  return logical;
};

const propertyName = (line: string): string => {
  const upper = line.toUpperCase();
  const end = Math.min(
    ...[':', ';'].map((char) => {
      const index = upper.indexOf(char);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  return Number.isFinite(end) ? upper.slice(0, end) : upper;
};

const existingSequence = (lines: readonly string[]): number => {
  const line = lines.find((candidate) => propertyName(candidate) === 'SEQUENCE');
  const value =
    line === undefined ? NaN : Number(line.slice(line.indexOf(':') + 1).trim());
  return Number.isInteger(value) ? value : 0;
};

const replaceEventProperties = (
  ics: string,
  replacements: Map<string, string[]>,
  removals: Set<string>,
): string => {
  const lines = unfold(ics);
  const begin = lines.findIndex(
    (line) => propertyName(line) === 'BEGIN' && /:VEVENT$/i.test(line),
  );
  const end = lines.findIndex(
    (line) => propertyName(line) === 'END' && /:VEVENT$/i.test(line),
  );

  if (begin === -1 || end === -1) {
    throw new ValidationError('The stored calendar entry has no VEVENT to update');
  }

  const out: string[] = [...lines.slice(0, begin + 1)];
  const emitted = new Set<string>();

  for (const line of lines.slice(begin + 1, end)) {
    const name = propertyName(line);
    if (removals.has(name)) {
      continue;
    }
    const replacement = replacements.get(name);
    if (replacement === undefined) {
      out.push(line);
      continue;
    }
    if (!emitted.has(name)) {
      out.push(...replacement);
      emitted.add(name);
    }
  }

  // A property that was absent from the original still has to be added.
  for (const [name, value] of replacements) {
    if (!emitted.has(name)) {
      // DTEND must follow DTSTART, not trail the description; but servers all
      // accept any order within a VEVENT, and keeping it simple here avoids a
      // class of ordering bug for no interoperability gain.
      out.push(...value);
    }
  }

  out.push(...lines.slice(end));
  return assertWellFormed(out.flatMap(foldLine).join('\r\n') + '\r\n');
};

/**
 * Rewrites only the properties present in `changes`, leaving every other line —
 * including VALARM, ATTENDEE, RRULE and EXDATE — untouched. DTSTAMP and
 * SEQUENCE are always bumped, as RFC 5545 expects of a modification.
 */
export const patchEventIcs = (
  ics: string,
  changes: UpdateEventInput,
  now: Date,
): string => {
  const lines = unfold(ics);
  const sequence = existingSequence(lines);
  const existingAllDay = lines.some((line) => /^DTSTART;VALUE=DATE:/i.test(line));
  const allDay = changes.allDay ?? existingAllDay;

  const replacements = new Map<string, string[]>();
  const removals = new Set<string>();

  if (changes.summary !== undefined) {
    replacements.set('SUMMARY', [`SUMMARY:${escapeText(changes.summary)}`]);
  }
  if (changes.description === null) {
    removals.add('DESCRIPTION');
  } else if (changes.description !== undefined) {
    replacements.set('DESCRIPTION', [`DESCRIPTION:${escapeText(changes.description)}`]);
  }
  if (changes.location === null) {
    removals.add('LOCATION');
  } else if (changes.location !== undefined) {
    replacements.set('LOCATION', [`LOCATION:${escapeText(changes.location)}`]);
  }
  if (changes.status !== undefined) {
    replacements.set('STATUS', [`STATUS:${changes.status}`]);
  }
  if (changes.start !== undefined) {
    replacements.set('DTSTART', [dtStartLine(changes.start, allDay)]);
  }
  if (changes.end !== undefined) {
    replacements.set('DTEND', [dtEndLine(changes.end, allDay)]);
  }

  replacements.set('DTSTAMP', [`DTSTAMP:${icsUtc(now)}`]);
  replacements.set('SEQUENCE', [`SEQUENCE:${sequence + 1}`]);

  return replaceEventProperties(ics, replacements, removals);
};

/** Parses every VEVENT in an `.ics` document, with no recurrence expansion. */
export const parseEvents = (
  ics: string,
  meta: { href: string; calendarHref: string; etag: string | null },
): ParsedEvent[] => {
  let parsed: ReturnType<typeof icalSync.parseICS>;
  try {
    parsed = icalSync.parseICS(ics);
  } catch (error) {
    throw new ValidationError(
      `Could not parse calendar data at ${meta.href}: ${(error as Error).message}`,
    );
  }

  const events: ParsedEvent[] = [];
  for (const component of Object.values(parsed)) {
    if (component?.type !== 'VEVENT') {
      continue;
    }
    const source = component;
    const start = toIso(source.start);
    if (start === null) {
      continue;
    }
    const end = toIso(source.end);
    const allDay = source.datetype === 'date';
    const description = text(source.description);
    const location = text(source.location);
    events.push({
      source,
      base: {
        uid: source.uid,
        href: meta.href,
        calendarHref: meta.calendarHref,
        etag: meta.etag,
        summary: text(source.summary) ?? '(no title)',
        ...(description === undefined ? {} : { description }),
        ...(location === undefined ? {} : { location }),
        start: allDay ? start.slice(0, 10) : start,
        end: end === null ? null : allDay ? end.slice(0, 10) : end,
        allDay,
        ...(typeof source.status === 'string' ? { status: source.status } : {}),
        isRecurring: source.rrule !== undefined,
      },
    });
  }
  return events;
};

/**
 * Expands a parsed event into the occurrences that overlap `[from, to)`.
 *
 * Non-recurring events are returned as-is when they overlap; recurring ones go
 * through `node-ical`'s expander, which applies RRULE, EXDATE and
 * RECURRENCE-ID overrides together.
 */
export const expandEvent = (
  parsed: ParsedEvent,
  from: Date,
  to: Date,
): CalendarEvent[] => {
  const { base, source } = parsed;

  if (source.rrule === undefined) {
    const start = new Date(
      base.start.length === 10 ? `${base.start}T00:00:00Z` : base.start,
    );
    const end =
      base.end === null
        ? new Date(start.getTime() + 60 * 60 * 1000)
        : new Date(base.end.length === 10 ? `${base.end}T00:00:00Z` : base.end);
    return start < to && end > from ? [base] : [];
  }

  let instances: ReturnType<typeof expandRecurringEvent>;
  try {
    instances = expandRecurringEvent(source, { from, to, expandOngoing: true });
  } catch {
    // A malformed RRULE should cost one event, not the whole listing.
    return [];
  }

  return instances.map((instance) => {
    const start = instance.start;
    const end = instance.end ?? start;
    return {
      ...base,
      start: instance.isFullDay ? start.toISOString().slice(0, 10) : start.toISOString(),
      end: instance.isFullDay ? end.toISOString().slice(0, 10) : end.toISOString(),
      allDay: instance.isFullDay,
      isRecurring: true,
      recurrenceId: instance.isFullDay
        ? start.toISOString().slice(0, 10)
        : start.toISOString(),
    };
  });
};
