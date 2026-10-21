/**
 * Calendar types, deliberately transport-agnostic.
 *
 * Times are ISO strings rather than `Date` so they survive JSON tool results
 * unchanged. All-day events use `YYYY-MM-DD`; timed events use a full ISO 8601
 * timestamp. `allDay` is stated explicitly rather than left for a caller to
 * infer from the shape of the string, because "2026-08-24" is also a perfectly
 * valid instant at midnight and guessing wrong shifts an event by a day.
 */

export interface CalendarInfo {
  /** Absolute path on the server, e.g. `/remote.php/dav/calendars/alice/personal/`. */
  readonly href: string;
  readonly displayName: string;
  readonly description?: string;
  readonly color?: string;
  /** True when the server reports the authenticated user may write to it. */
  readonly writable: boolean;
}

export interface CalendarEvent {
  readonly uid: string;
  /** Absolute path of the `.ics` resource. */
  readonly href: string;
  readonly calendarHref: string;
  /** Validator to send back on update/delete. `null` if the server offered none. */
  readonly etag: string | null;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: string;
  readonly end: string | null;
  readonly allDay: boolean;
  readonly status?: string;
  readonly isRecurring: boolean;
  /** Set on expanded occurrences of a recurring event. */
  readonly recurrenceId?: string;
}

export interface CreateEventInput {
  readonly summary: string;
  readonly start: string;
  readonly end?: string;
  readonly description?: string;
  readonly location?: string;
  readonly allDay?: boolean;
  /** Supply one to make repeated creates idempotent; otherwise minted. */
  readonly uid?: string;
}

export interface UpdateEventInput {
  readonly summary?: string;
  readonly start?: string;
  readonly end?: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly allDay?: boolean;
  readonly status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
}
