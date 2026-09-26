// Pure helpers for the pick screen: the exact-pick sliders, team names and
// kickoff labels. Kept out of the components so they're easy to test.

import { OUTCOMES, type Outcome, type Probs } from '../../src/scoring/scoring'

/**
 * Move one outcome's slider to `value` and rebalance the other two so the
 * pick still sums to 100, keeping their ratio to each other. When both are 0
 * the rest splits evenly. Whole percentages, rounded by largest remainder.
 */
export function rebalance(p: Probs, outcome: Outcome, value: number): Probs {
  const v = Math.max(0, Math.min(100, Math.round(value)))
  const [o1, o2] = OUTCOMES.filter((o) => o !== outcome)
  const rest = 100 - v
  const w1 = p[o1] + p[o2] === 0 ? 0.5 : p[o1] / (p[o1] + p[o2])
  const raw1 = rest * w1
  let a = Math.floor(raw1)
  let b = Math.floor(rest - raw1)
  if (a + b < rest) {
    // One point left over: it goes to the bigger remainder.
    if (raw1 - a >= rest - raw1 - b) a += 1
    else b += 1
  }
  return { [outcome]: v, [o1]: a, [o2]: b } as Probs
}

const SUFFIX = /\s+(FC|AFC|CF|SAD)$/
const PREFIX = /^(AFC|FC|CF|RCD|RC|CA|SD)\s+/

/** "AFC Bournemouth" → "Bournemouth", "Arsenal FC" → "Arsenal". Full name stays in the title. */
export function shortName(team: string): string {
  const s = team.replace(SUFFIX, '').replace(PREFIX, '')
  return s || team
}

/** "Sat 10 Oct · 12:30" in the viewer's own timezone. */
export function kickoffLabel(iso: string, timeKnown: boolean, locale?: string, timeZone?: string): string {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(d)
  if (!timeKnown) return `${day} · time TBC`
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(d)
  return `${day} · ${time}`
}

/** "Locks in 2h 5m" inside the last day, "Locked" after kickoff, else null. */
export function lockLabel(kickoffIso: string, now: number): string | null {
  const ms = Date.parse(kickoffIso) - now
  if (ms <= 0) return 'Locked'
  if (ms >= 24 * 3600_000) return null
  const mins = Math.floor(ms / 60_000)
  const h = Math.floor(mins / 60)
  return h > 0 ? `Locks in ${h}h ${mins % 60}m` : `Locks in ${Math.max(1, mins)}m`
}

/** Day key in the viewer's timezone, for grouping ("2026-10-10"). */
export function localDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(
    new Date(iso),
  )
}

export const OUTCOME_LABEL: Record<Outcome, string> = { H: 'Home', D: 'Draw', A: 'Away' }
