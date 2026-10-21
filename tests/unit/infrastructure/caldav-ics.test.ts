import { describe, expect, it } from 'vitest';
import {
  buildEventIcs,
  expandEvent,
  parseEvents,
  patchEventIcs,
} from '../../../src/infrastructure/caldav/ics.js';
import { ValidationError } from '../../../src/domain/errors.js';

const META = {
  href: '/remote.php/dav/calendars/alice/personal/event.ics',
  calendarHref: '/remote.php/dav/calendars/alice/personal/',
  etag: '"abc"',
};

/**
 * RFC 5545 §3.1: every physical line ≤75 octets, and every continuation after
 * the first must start with a space. SabreDAV rejects a body that violates the
 * second rule with an opaque HTTP 415, which is what this pins down.
 */
const assertFolded = (ics: string): void => {
  const lines = ics.split('\r\n');
  expect(lines.at(-1)).toBe('');
  for (const [index, line] of lines.entries()) {
    if (line === '') continue;
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    if (index > 0 && !/[;:]/.test(line)) {
      expect(line.startsWith(' ')).toBe(true);
    }
  }
};

const RAW = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Other App//EN',
  'BEGIN:VEVENT',
  'UID:existing@example.com',
  'DTSTAMP:20260101T000000Z',
  'SEQUENCE:3',
  'DTSTART:20260824T093000Z',
  'DTEND:20260824T103000Z',
  'SUMMARY:Old title',
  'ATTENDEE;CN=Someone:mailto:someone@example.com',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

describe('buildEventIcs', () => {
  const now = new Date('2026-08-01T00:00:00Z');

  it('writes a timed event in UTC and parses back', () => {
    const ics = buildEventIcs(
      { summary: 'Standup', start: '2026-08-24T09:30:00Z', end: '2026-08-24T10:00:00Z' },
      { uid: 'uid-1', now },
    );

    expect(ics).toContain('UID:uid-1');
    expect(ics).toContain('DTSTART:20260824T093000Z');
    expect(ics).toContain('DTEND:20260824T100000Z');
    expect(ics.endsWith('\r\n')).toBe(true);

    const [event] = parseEvents(ics, META);
    expect(event?.base.summary).toBe('Standup');
    expect(event?.base.allDay).toBe(false);
    expect(event?.base.start).toBe('2026-08-24T09:30:00.000Z');
  });

  it('treats a date as all-day and makes DTEND exclusive', () => {
    const ics = buildEventIcs(
      { summary: 'Holiday', start: '2026-08-24' },
      { uid: 'uid-2', now },
    );

    expect(ics).toContain('DTSTART;VALUE=DATE:20260824');
    expect(ics).toContain('DTEND;VALUE=DATE:20260825');
    expect(parseEvents(ics, META)[0]?.base.allDay).toBe(true);
  });

  it('escapes text values and folds long lines', () => {
    const long = 'x'.repeat(200);
    const ics = buildEventIcs(
      {
        summary: 'A, B; C\nD',
        start: '2026-08-24T09:30:00Z',
        description: long,
      },
      { uid: 'uid-3', now },
    );

    expect(ics).toContain('SUMMARY:A\\, B\\; C\\nD');
    assertFolded(ics);
    // The full value survives unfolding and parsing — the property the server
    // actually validates. A continuation without its leading space fails here.
    expect(parseEvents(ics, META)[0]?.base.description).toBe(long);
  });

  it('folds a long title, not just the description', () => {
    const summary = 'A very long meeting title that comfortably exceeds seventy-five octets';
    const ics = buildEventIcs({ summary, start: '2026-08-24T09:30:00Z' }, {
      uid: 'uid-long-title',
      now,
    });

    assertFolded(ics);
    expect(parseEvents(ics, META)[0]?.base.summary).toBe(summary);
  });

  it('keeps an existing long description intact across an update', () => {
    // An event written by another client may already carry a long DESCRIPTION.
    // Update must re-fold it correctly instead of turning it into garbage.
    const long = 'Keep every one of these words. '.repeat(20).trim();
    const original = buildEventIcs(
      { summary: 'Original', start: '2026-08-24T09:30:00Z', description: long },
      { uid: 'uid-patch-long', now },
    );

    const patched = patchEventIcs(original, { summary: 'Renamed' }, now);

    assertFolded(patched);
    const parsed = parseEvents(patched, META)[0]?.base;
    expect(parsed?.summary).toBe('Renamed');
    expect(parsed?.description).toBe(long);
  });

  it('rejects an end before the start', () => {
    expect(() =>
      buildEventIcs(
        {
          summary: 'Backwards',
          start: '2026-08-24T10:00:00Z',
          end: '2026-08-24T09:00:00Z',
        },
        { uid: 'uid-4', now },
      ),
    ).toThrow(ValidationError);
  });
});

describe('patchEventIcs', () => {
  it('changes only the requested fields and preserves everything else', () => {
    const patched = patchEventIcs(
      RAW,
      {
        summary: 'New title',
        start: '2026-08-25T09:30:00Z',
        end: '2026-08-25T10:30:00Z',
      },
      new Date('2026-08-01T12:00:00Z'),
    );

    expect(patched).toContain('SUMMARY:New title');
    expect(patched).toContain('DTSTART:20260825T093000Z');
    expect(patched).toContain('SEQUENCE:4');
    expect(patched).toContain('DTSTAMP:20260801T120000Z');
    // The whole point: properties we do not model survive untouched.
    expect(patched).toContain('ATTENDEE;CN=Someone:mailto:someone@example.com');
    expect(patched).toContain('BEGIN:VALARM');
    expect(patched).toContain('TRIGGER:-PT15M');
    expect(patched).not.toContain('SUMMARY:Old title');
  });

  it('removes a property when asked with null', () => {
    const patched = patchEventIcs(RAW, { description: null, location: null }, new Date());
    expect(patched).not.toContain('DESCRIPTION:');
  });

  it('refuses an ics with no VEVENT', () => {
    expect(() =>
      patchEventIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { summary: 'x' }, new Date()),
    ).toThrow(ValidationError);
  });
});

describe('expandEvent', () => {
  const recurring = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:daily@example.com',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260824T090000Z',
    'DTEND:20260824T093000Z',
    'RRULE:FREQ=DAILY;COUNT=3',
    'SUMMARY:Daily',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  it('expands a recurring event into occurrences', () => {
    const [parsed] = parseEvents(recurring, META);
    expect(parsed?.base.isRecurring).toBe(true);

    const occurrences = expandEvent(
      parsed!,
      new Date('2026-08-24T00:00:00Z'),
      new Date('2026-08-28T00:00:00Z'),
    );

    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((event) => event.start)).toEqual([
      '2026-08-24T09:00:00.000Z',
      '2026-08-25T09:00:00.000Z',
      '2026-08-26T09:00:00.000Z',
    ]);
    expect(occurrences[1]?.recurrenceId).toBe('2026-08-25T09:00:00.000Z');
  });

  it('omits an event outside the window', () => {
    const [parsed] = parseEvents(recurring, META);
    expect(
      expandEvent(
        parsed!,
        new Date('2026-09-01T00:00:00Z'),
        new Date('2026-09-02T00:00:00Z'),
      ),
    ).toEqual([]);
  });
});
