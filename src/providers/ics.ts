import { nowIcsUtc, toIcsUtc, wallTimeToUtc } from '../time.ts';
import type { ClassEvent } from '../domain/types.ts';

/**
 * RFC 5545 text escaping: backslash, semicolon, comma and newlines.
 *
 * Done as a single pass over a lookup table rather than chained .replace() calls,
 * so a backslash introduced by one rule can never be re-escaped by a later one.
 */
const TEXT_ESCAPES = new Map<string, string>([
  ['\\', '\\\\'],
  [';', '\\;'],
  [',', '\\,'],
  ['\n', '\\n'],
  ['\r', ''],
]);

function escapeText(value: string): string {
  return value.replace(/[\\;,\r\n]/g, (char) => TEXT_ESCAPES.get(char) ?? char);
}

/** RFC 5545 requires lines of at most 75 octets, continued with a leading space. */
function fold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;

  const out: string[] = [];
  let current = '';
  for (const char of line) {
    const limit = out.length === 0 ? 75 : 74;
    if (Buffer.byteLength(current + char, 'utf8') > limit) {
      out.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out.join('\r\n ');
}

/**
 * Build a single-event VCALENDAR for CalDAV.
 *
 * SEQUENCE carries the platform version, which is the iCalendar-native way to say
 * "this revision supersedes the last one" -- so a client that has already seen an
 * older copy accepts the update rather than treating it as a conflict.
 */
export function buildIcs(event: ClassEvent): string {
  const start = wallTimeToUtc(event.starts_at, event.timezone);
  const end = wallTimeToUtc(event.ends_at, event.timezone);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//calendar-poc//Cross-provider class sync//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.ical_uid}`,
    `DTSTAMP:${nowIcsUtc()}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `SEQUENCE:${event.version}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    `LAST-MODIFIED:${nowIcsUtc()}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.map(fold).join('\r\n')}\r\n`;
}
