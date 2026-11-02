/**
 * Google and Microsoft both accept a local wall time plus an IANA zone name, so
 * they need no conversion. CalDAV does not: emitting DTSTART;TZID=... would
 * oblige us to ship a matching VTIMEZONE component, so instead we convert to a
 * UTC instant and emit DTSTART:...Z, which is unambiguous and renders correctly
 * in every client.
 */

/** Milliseconds that `timeZone` is ahead of UTC at the given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - instant.getTime();
}

/**
 * Interpret an offset-less ISO wall time (e.g. "2026-11-10T09:00:00") as a clock
 * reading in `timeZone` and return the corresponding UTC instant.
 *
 * The offset is resolved twice because the first guess can land on the wrong side
 * of a DST transition.
 */
export function wallTimeToUtc(wall: string, timeZone: string): Date {
  const naive = new Date(`${wall.replace(' ', 'T').replace(/Z$/, '')}Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`Unparseable wall time: ${wall}`);
  }

  const firstGuess = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  const refined = new Date(naive.getTime() - zoneOffsetMs(firstGuess, timeZone));
  return refined;
}

/** iCalendar UTC timestamp: 20261110T093000Z */
export function toIcsUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

export function nowIcsUtc(): string {
  return toIcsUtc(new Date());
}
