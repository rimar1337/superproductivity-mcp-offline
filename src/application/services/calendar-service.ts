import { randomUUID } from 'node:crypto';
import type {
  CalendarEvent,
  CalendarInfo,
  CreateEventInput,
  UpdateEventInput,
} from '../../domain/caldav/event.js';
import {
  CalendarReadOnlyError,
  NotFoundError,
  RemoteFileNotFoundError,
  UnsafeOperationError,
  ValidationError,
} from '../../domain/errors.js';
import type { Logger } from '../../domain/ports.js';
import {
  type CaldavClient,
  type CaldavDateRange,
} from '../../infrastructure/caldav/caldav-client.js';
import {
  buildEventIcs,
  expandEvent,
  parseEvents,
  patchEventIcs,
  type ParsedEvent,
} from '../../infrastructure/caldav/ics.js';
import type { EventResource } from '../../infrastructure/caldav/xml.js';

/**
 * Calendar operations in terms of calendars and events, not HTTP verbs.
 *
 * Two rules run through it:
 *
 * **Reads span calendars, writes name one.** A listing across every configured
 * calendar is what a model wants; a write that silently picked a calendar
 * would be a write to the wrong place.
 *
 * **Every modification is conditional.** Updates and deletes carry the ETag
 * they were read at. Without one, the operation is refused rather than risking
 * a concurrent edit: the caller can re-read and reapply.
 */

export interface CalendarServiceOptions {
  readonly client: CaldavClient;
  readonly logger: Logger;
  readonly writable: boolean;
  /** Hrefs or display names to expose. Empty means every discovered calendar. */
  readonly calendarIds?: readonly string[];
  /** Href or display name writes target. Required when more than one is open. */
  readonly writeCalendarId?: string;
  readonly now: () => Date;
}

export interface ListEventsOptions {
  readonly from: Date;
  readonly to: Date;
  readonly calendarId?: string;
}

export interface EventRef {
  readonly eventId: string;
  readonly calendarId?: string;
}

interface LocatedEvent {
  readonly calendar: CalendarInfo;
  readonly resource: EventResource;
  readonly parsed: readonly ParsedEvent[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Compares hrefs ignoring trailing slashes, and falls back to a display name. */
const matches = (calendar: CalendarInfo, needle: string): boolean => {
  const href = calendar.href.replace(/\/+$/, '');
  const target = needle.trim().replace(/\/+$/, '');
  if (href === target || href.endsWith(`/${target}`)) {
    return true;
  }
  return calendar.displayName.toLowerCase() === target.toLowerCase();
};

const overlaps = (event: CalendarEvent, range: CaldavDateRange): boolean => {
  const start = new Date(event.allDay ? `${event.start}T00:00:00Z` : event.start);
  const end =
    event.end === null
      ? start
      : new Date(event.allDay ? `${event.end}T00:00:00Z` : event.end);
  return start < range.to && end > range.from;
};

export class CalendarService {
  readonly #client: CaldavClient;
  readonly #logger: Logger;
  readonly #writable: boolean;
  readonly #calendarIds: readonly string[];
  readonly #writeCalendarId: string | undefined;
  readonly #now: () => Date;

  constructor(options: CalendarServiceOptions) {
    this.#client = options.client;
    this.#logger = options.logger;
    this.#writable = options.writable;
    this.#calendarIds = options.calendarIds ?? [];
    this.#writeCalendarId = options.writeCalendarId;
    this.#now = options.now;
  }

  get writable(): boolean {
    return this.#writable;
  }

  /** Every calendar the operator chose to expose. */
  async listCalendars(): Promise<CalendarInfo[]> {
    const calendars = await this.#client.listCalendars();
    if (this.#calendarIds.length === 0) {
      return calendars;
    }

    const selected = calendars.filter((calendar) =>
      this.#calendarIds.some((id) => matches(calendar, id)),
    );
    if (selected.length === 0) {
      throw new ValidationError(
        `None of the configured calendars exist. Configured: ${this.#calendarIds.join(', ')}. ` +
          `Available: ${calendars.map((calendar) => calendar.displayName).join(', ') || '(none)'}.`,
      );
    }
    return selected;
  }

  async #calendar(id: string | undefined): Promise<CalendarInfo> {
    const calendars = await this.listCalendars();
    if (id === undefined) {
      const first = calendars[0];
      if (first === undefined) {
        throw new ValidationError('No calendars are configured on this server.');
      }
      return first;
    }
    const found = calendars.find((calendar) => matches(calendar, id));
    if (found === undefined) {
      throw new ValidationError(
        `Calendar "${id}" was not found. Available: ${calendars
          .map((c) => c.displayName)
          .join(', ')}.`,
      );
    }
    return found;
  }

  async #writeCalendar(id: string | undefined): Promise<CalendarInfo> {
    if (!this.#writable) {
      throw new CalendarReadOnlyError('calendar write');
    }
    const calendars = await this.listCalendars();
    const target =
      id ??
      this.#writeCalendarId ??
      (calendars.length === 1 ? calendars[0]?.displayName : undefined);

    if (target === undefined) {
      throw new ValidationError(
        'No write calendar is configured. Set CALDAV_WRITE_CALENDAR to the href or ' +
          'display name of the calendar that should receive events. Available: ' +
          calendars.map((calendar) => calendar.displayName).join(', ') +
          '.',
      );
    }

    const calendar = calendars.find((candidate) => matches(candidate, target));
    if (calendar === undefined) {
      throw new ValidationError(
        `Write calendar "${target}" was not found. Available: ${calendars
          .map((c) => c.displayName)
          .join(', ')}.`,
      );
    }
    if (!calendar.writable) {
      throw new ValidationError(
        `Calendar "${calendar.displayName}" is read-only for this account.`,
      );
    }
    return calendar;
  }

  async listEvents(options: ListEventsOptions): Promise<CalendarEvent[]> {
    const range = this.#range(options.from, options.to);
    const calendars = await this.#calendarsToRead(options.calendarId);

    const results: CalendarEvent[] = [];
    for (const calendar of calendars) {
      const resources = await this.#client.listEventResources(calendar.href, range);
      for (const resource of resources) {
        const parsed = parseEvents(resource.ics, {
          href: resource.href,
          calendarHref: calendar.href,
          etag: resource.etag,
        });
        for (const event of parsed) {
          results.push(...expandEvent(event, range.from, range.to));
        }
      }
    }

    return results
      .filter((event) => overlaps(event, range))
      .sort((left, right) => left.start.localeCompare(right.start));
  }

  async searchEvents(
    query: string,
    options: ListEventsOptions,
  ): Promise<CalendarEvent[]> {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      throw new ValidationError('query must not be empty');
    }
    const events = await this.listEvents(options);
    return events.filter((event) =>
      [event.summary, event.description ?? '', event.location ?? '']
        .join('\n')
        .toLowerCase()
        .includes(needle),
    );
  }

  /** The base event (not expanded) behind a UID or href. */
  async getEvent(ref: EventRef): Promise<CalendarEvent> {
    const located = await this.#locate(ref);
    const [first] = located.parsed;
    if (first === undefined) {
      throw new ValidationError(`Event "${ref.eventId}" contains no VEVENT.`);
    }
    return first.base;
  }

  async createEvent(
    input: CreateEventInput,
    calendarId?: string,
  ): Promise<CalendarEvent> {
    const calendar = await this.#writeCalendar(calendarId);
    const uid = input.uid ?? `${randomUUID()}@super-productivity`;
    const now = this.#now();
    const href = `${calendar.href}${encodeURIComponent(uid)}.ics`;
    const ics = buildEventIcs(input, { uid, now });

    const written = await this.#client.putEvent(href, ics, null);
    await this.#verifyWritten(written.href, written.etag);
    this.#logger.info('Created calendar event', { uid, calendar: calendar.displayName });

    return this.#eventFromIcs(ics, {
      href: written.href,
      calendarHref: calendar.href,
      etag: written.etag,
    });
  }

  async updateEvent(ref: EventRef, changes: UpdateEventInput): Promise<CalendarEvent> {
    const located = await this.#locate(ref);
    if (located.resource.etag === null) {
      throw new UnsafeOperationError(
        `Event "${ref.eventId}" was served without a strong ETag, so an update could overwrite a concurrent edit.`,
        'Re-read the event and try again, or edit it in the calendar app.',
      );
    }

    const now = this.#now();
    const patched = patchEventIcs(located.resource.ics, changes, now);
    const written = await this.#client.putEvent(
      located.resource.href,
      patched,
      located.resource.etag,
    );
    await this.#verifyWritten(written.href, written.etag);
    this.#logger.info('Updated calendar event', {
      uid: ref.eventId,
      calendar: located.calendar.displayName,
    });

    return this.#eventFromIcs(patched, {
      href: written.href,
      calendarHref: located.calendar.href,
      etag: written.etag,
    });
  }

  async deleteEvent(ref: EventRef): Promise<{ deleted: true; uid: string }> {
    if (!this.#writable) {
      throw new CalendarReadOnlyError('calendar delete');
    }
    const located = await this.#locate(ref);
    // Same gate as update: without a strong ETag the DELETE cannot prove it is
    // removing the version we read, so it could erase a concurrent edit.
    if (located.resource.etag === null) {
      throw new UnsafeOperationError(
        `Event "${ref.eventId}" was served without a strong ETag, so a delete could remove a concurrent edit.`,
        'Re-read the event and try again, or delete it in the calendar app.',
      );
    }
    await this.#client.deleteEvent(located.resource.href, located.resource.etag);
    await this.#verifyDeleted(located.resource.href);
    this.#logger.info('Deleted calendar event', {
      uid: ref.eventId,
      calendar: located.calendar.displayName,
    });
    return { deleted: true, uid: ref.eventId };
  }

  /**
   * Confirms a write actually landed, the way Super Productivity's file-based
   * `_verifyUpload` re-GETs after upload. Best-effort: a mismatch is logged,
   * not thrown, because the write already happened and the caller needs the
   * result either way. A silent server-side drop is what this is here to catch.
   */
  async #verifyWritten(href: string, expectedEtag: string | null): Promise<void> {
    try {
      const stored = await this.#client.getEventResource(href);
      if (expectedEtag !== null && stored.etag !== null && stored.etag !== expectedEtag) {
        this.#logger.warn('Stored event ETag differs from the one returned by the write', {
          href,
          expectedEtag,
          storedEtag: stored.etag,
        });
      }
    } catch (error) {
      this.#logger.warn('Could not re-read the event to verify the write', {
        href,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #verifyDeleted(href: string): Promise<void> {
    try {
      await this.#client.getEventResource(href);
      this.#logger.warn('Event still exists after a successful delete response', { href });
    } catch (error) {
      if (!(error instanceof RemoteFileNotFoundError)) {
        this.#logger.warn('Could not re-read the event to verify the delete', {
          href,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * A calendar block for a Super Productivity task.
   *
   * The UID convention matches Super Productivity's own CalDAV integration
   * (`sp-{taskId}@super-productivity`), so a block written here is recognised
   * as the task's block there, and re-running the tool updates it instead of
   * stacking duplicates.
   */
  async timeBlockForTask(input: {
    taskId: string;
    summary: string;
    start: string;
    end: string;
    description?: string;
  }): Promise<{ event: CalendarEvent; created: boolean }> {
    const uid = `sp-${input.taskId}@super-productivity`;
    const existing = await this.#findByUid(uid);

    if (existing !== undefined) {
      const event = await this.updateEvent(
        { eventId: existing.resource.href },
        {
          summary: input.summary,
          start: input.start,
          end: input.end,
          ...(input.description === undefined ? {} : { description: input.description }),
        },
      );
      return { event, created: false };
    }

    const event = await this.createEvent({
      uid,
      summary: input.summary,
      start: input.start,
      end: input.end,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    return { event, created: true };
  }

  #eventFromIcs(
    ics: string,
    meta: { href: string; calendarHref: string; etag: string | null },
  ): CalendarEvent {
    const [parsed] = parseEvents(ics, meta);
    if (parsed === undefined) {
      throw new ValidationError(
        'The calendar server stored an event we cannot read back.',
      );
    }
    return parsed.base;
  }

  #range(from: Date, to: Date): CaldavDateRange {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ValidationError('from and to must be valid timestamps');
    }
    if (to.getTime() <= from.getTime()) {
      throw new ValidationError('to must be later than from');
    }
    return { from, to };
  }

  async #calendarsToRead(calendarId: string | undefined): Promise<CalendarInfo[]> {
    if (calendarId !== undefined) {
      return [await this.#calendar(calendarId)];
    }
    return this.listCalendars();
  }

  /**
   * Finds the resource behind `eventId`.
   *
   * Resolution order is cheapest-first: an href is used directly, a UID is
   * tried as the conventional filename, and only then is the calendar scanned.
   */
  async #locate(ref: EventRef): Promise<LocatedEvent> {
    const eventId = ref.eventId.trim();
    if (eventId === '') {
      throw new ValidationError('eventId must not be empty');
    }

    if (eventId.startsWith('/')) {
      const calendars = await this.#calendarsToRead(ref.calendarId);
      const calendar = calendars.find((candidate) => eventId.startsWith(candidate.href));
      if (calendar === undefined) {
        throw new NotFoundError('event in the configured calendars', eventId);
      }
      const resource = await this.#client.getEventResource(eventId);
      return { calendar, resource, parsed: this.#parse([resource], calendar) };
    }

    const calendars = await this.#calendarsToRead(ref.calendarId);
    for (const calendar of calendars) {
      const href = `${calendar.href}${encodeURIComponent(eventId)}.ics`;
      try {
        const resource = await this.#client.getEventResource(href);
        const parsed = this.#parse([resource], calendar);
        if (parsed.some((event) => event.base.uid === eventId)) {
          return { calendar, resource, parsed };
        }
      } catch (error) {
        // The conventional filename is a guess; a 404 just means this UID is
        // stored under some other name, which the scan below will find.
        if (!(error instanceof RemoteFileNotFoundError)) {
          throw error;
        }
      }
    }

    const found = await this.#findByUid(eventId, ref.calendarId);
    if (found !== undefined) {
      return found;
    }
    throw new NotFoundError('event', eventId);
  }

  async #findByUid(uid: string, calendarId?: string): Promise<LocatedEvent | undefined> {
    const calendars = await this.#calendarsToRead(calendarId);
    for (const calendar of calendars) {
      const resources = await this.#client.listAllEventResources(calendar.href);
      for (const resource of resources) {
        const parsed = this.#parse([resource], calendar);
        if (parsed.some((event) => event.base.uid === uid)) {
          return { calendar, resource, parsed };
        }
      }
    }
    return undefined;
  }

  #parse(resources: readonly EventResource[], calendar: CalendarInfo): ParsedEvent[] {
    return resources.flatMap((resource) =>
      parseEvents(resource.ics, {
        href: resource.href,
        calendarHref: calendar.href,
        etag: resource.etag,
      }),
    );
  }
}

/** Default window when a caller does not say: today forward one month. */
export const defaultEventWindow = (now: Date): { from: Date; to: Date } => {
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to: new Date(from.getTime() + 30 * DAY_MS) };
};
