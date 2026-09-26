// Wall-clock time in a named zone → UTC, using the runtime's tz database
// (Intl), so BST/CET changes are handled without a date library.

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(tz, f)
  }
  return f
}

/** The zone's UTC offset at instant t, in ms (London in summer: +3600000). */
function offsetAt(t: number, tz: string): number {
  const p: Record<string, number> = {}
  for (const { type, value } of formatter(tz).formatToParts(t)) p[type] = Number(value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t
}

/**
 * `date` (YYYY-MM-DD) at `time` (HH:MM) on the wall clock in `tz`, as ms since
 * epoch. Kickoffs never fall in the skipped hour of a clock change, so the
 * two-pass offset lookup is exact for every time we see.
 */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  const first = wall - offsetAt(wall, tz)
  return wall - offsetAt(first, tz)
}
