import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CalendarService } from '../../application/services/calendar-service.js';
import type { Logger } from '../../domain/ports.js';
import { guarded, ok } from './tool-result.js';
import {
  calendarCreateEventShape,
  calendarDeleteEventShape,
  calendarGetEventShape,
  calendarListEventsShape,
  calendarListShape,
  calendarSearchShape,
  calendarTimeBlockShape,
  calendarUpdateEventShape,
} from './schemas.js';

/**
 * The calendar surface.
 *
 * Naming is `calendar_*` rather than `sp_*` on purpose: these read and write
 * the user's CalDAV calendar, which is a different store from the Super
 * Productivity sync file, and a model should be able to tell from the name
 * which system a call will touch.
 *
 * Writes are only registered when calendar writes are enabled, so a read-only
 * server does not offer a tool that can only fail.
 */

export interface CalendarToolDependencies {
  readonly calendar: CalendarService;
  readonly logger: Logger;
  readonly writable: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const asDate = (value: string): Date =>
  new Date(value.length === 10 ? `${value}T00:00:00Z` : value);

const window = (
  from: string | undefined,
  to: string | undefined,
  now: Date,
): { from: Date; to: Date } => {
  const start = from === undefined ? new Date(now) : asDate(from);
  if (from === undefined) {
    start.setUTCHours(0, 0, 0, 0);
  }
  const end = to === undefined ? new Date(start.getTime() + 30 * DAY_MS) : asDate(to);
  return { from: start, to: end };
};

export const registerCalendarTools = (
  server: McpServer,
  deps: CalendarToolDependencies,
  now: () => Date,
): void => {
  const { calendar, logger, writable } = deps;

  server.registerTool(
    'calendar_list_calendars',
    {
      title: 'List calendars',
      description:
        'The calendars this server can see, with the href and display name every ' +
        'other calendar tool accepts as calendarId. Start here before creating an ' +
        'event, so you know which calendar to target.',
      inputSchema: calendarListShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(logger, async () => ok({ calendars: await calendar.listCalendars() })),
  );

  server.registerTool(
    'calendar_list_events',
    {
      title: 'List calendar events',
      description:
        'Events in a date window across the configured calendars. Recurring events ' +
        'are expanded, so each occurrence appears with its own start and end. ' +
        'Defaults to the next 30 days. Use calendar_search_events for text search.',
      inputSchema: calendarListEventsShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(logger, async (args) => {
      const range = window(args.from, args.to, now());
      return ok({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        events: await calendar.listEvents({
          ...range,
          ...(args.calendarId === undefined ? {} : { calendarId: args.calendarId }),
        }),
      });
    }),
  );

  server.registerTool(
    'calendar_get_event',
    {
      title: 'Get one calendar event',
      description:
        'Full details of a single event by UID or href, including notes, location, ' +
        'status and recurrence flag. For a recurring series this returns the series ' +
        'definition, not one occurrence.',
      inputSchema: calendarGetEventShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(logger, async (args) =>
      ok(
        await calendar.getEvent({
          eventId: args.eventId,
          ...(args.calendarId === undefined ? {} : { calendarId: args.calendarId }),
        }),
      ),
    ),
  );

  server.registerTool(
    'calendar_search_events',
    {
      title: 'Search calendar events',
      description:
        'Case-insensitive search over event titles, notes and locations within a ' +
        'date window. Defaults to the next 30 days, like calendar_list_events.',
      inputSchema: calendarSearchShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(logger, async (args) => {
      const range = window(args.from, args.to, now());
      return ok({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        query: args.query,
        events: await calendar.searchEvents(args.query, {
          ...range,
          ...(args.calendarId === undefined ? {} : { calendarId: args.calendarId }),
        }),
      });
    }),
  );

  if (!writable) {
    return;
  }

  server.registerTool(
    'calendar_create_event',
    {
      title: 'Create a calendar event',
      description:
        'Create an event in the write calendar. Pass a date (2026-08-24) for an ' +
        'all-day event or a timestamp with an offset for a timed one. The event ' +
        "appears in the user's calendar app on the next refresh.",
      inputSchema: calendarCreateEventShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(logger, async (args) =>
      ok(
        await calendar.createEvent(
          {
            summary: args.summary,
            start: args.start,
            ...(args.end === undefined ? {} : { end: args.end }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.location === undefined ? {} : { location: args.location }),
            ...(args.allDay === undefined ? {} : { allDay: args.allDay }),
            ...(args.uid === undefined ? {} : { uid: args.uid }),
          },
          args.calendarId,
        ),
      ),
    ),
  );

  server.registerTool(
    'calendar_update_event',
    {
      title: 'Update a calendar event',
      description:
        'Change fields on an existing event. Only the fields you pass are touched; ' +
        'everything else — recurrence, alarms, attendees — is preserved. Pass null ' +
        'for description or location to remove them. Refused if the event has no ' +
        'strong ETag, because the update could then clobber a concurrent edit.',
      inputSchema: calendarUpdateEventShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(logger, async (args) =>
      ok(
        await calendar.updateEvent(
          {
            eventId: args.eventId,
            ...(args.calendarId === undefined ? {} : { calendarId: args.calendarId }),
          },
          {
            ...(args.summary === undefined ? {} : { summary: args.summary }),
            ...(args.start === undefined ? {} : { start: args.start }),
            ...(args.end === undefined ? {} : { end: args.end }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.location === undefined ? {} : { location: args.location }),
            ...(args.allDay === undefined ? {} : { allDay: args.allDay }),
            ...(args.status === undefined ? {} : { status: args.status }),
          },
        ),
      ),
    ),
  );

  server.registerTool(
    'calendar_delete_event',
    {
      title: 'Delete a calendar event',
      description:
        'Delete one event by UID or href. Deleting a recurring series removes the ' +
        'series from this point forward as the server defines it — check with the ' +
        'user before deleting something recurring.',
      inputSchema: calendarDeleteEventShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(logger, async (args) =>
      ok(
        await calendar.deleteEvent({
          eventId: args.eventId,
          ...(args.calendarId === undefined ? {} : { calendarId: args.calendarId }),
        }),
      ),
    ),
  );

  server.registerTool(
    'calendar_time_block_from_task',
    {
      title: 'Time-block a task on the calendar',
      description:
        'Put a Super Productivity task on the calendar as a work block. Uses the ' +
        "same UID convention as Super Productivity's own CalDAV integration, so " +
        'running it again for the same task updates the existing block instead of ' +
        'creating a duplicate.',
      inputSchema: calendarTimeBlockShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(logger, async (args) =>
      ok(
        await calendar.timeBlockForTask({
          taskId: args.taskId,
          summary: args.summary,
          start: args.start,
          end: args.end,
          ...(args.description === undefined ? {} : { description: args.description }),
        }),
      ),
    ),
  );
};
