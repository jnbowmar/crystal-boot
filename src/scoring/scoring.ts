// Crystal Boot scoring. Pure functions, no I/O: the Worker settles with these
// and the React app previews with them, so both always agree.
//
// A pick is stored as whole percentages that sum to 100 ({H: 65, D: 15, A: 20}).
// Integers keep the database exact and make "you said 65%" literally true.

export type Outcome = 'H' | 'D' | 'A'
export type Probs = Record<Outcome, number>
export type League = 'en.1' | 'es.1'

export const OUTCOMES: readonly Outcome[] = ['H', 'D', 'A']

// Home/draw/away shares from 5 finished seasons, 2021-22 to 2025-26
// (m0/base_rates.py). Fractions, not percentages.
export const BASE_RATES: Record<League, Probs> = {
  'en.1': { H: 0.442, D: 0.239, A: 0.319 },
  'es.1': { H: 0.458, D: 0.261, A: 0.281 },
}

export const CONFIDENCE = { lean: 50, likely: 65, confident: 80, lock: 95 } as const
export type Confidence = keyof typeof CONFIDENCE

// Leaderboards rank by average points, but only once you've made enough picks,
// so skipping the hard matches can't win.
export const MIN_PICKS = { week: 10, season: 50 } as const

/** Throws unless p is three whole percentages in 0..100 summing to 100. */
export function validatePick(p: Probs): void {
  for (const o of OUTCOMES) {
    const v = p[o]
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      throw new RangeError(`pick.${o} must be a whole number 0-100, got ${v}`)
    }
  }
  const sum = p.H + p.D + p.A
  if (sum !== 100) throw new RangeError(`pick must sum to 100, got ${sum}`)
}

/**
 * The two-tap pick: the chosen outcome gets the confidence level, and the rest
 * splits between the other two in base-rate proportion. Rounded to whole
 * percentages by largest remainder so the total is always exactly 100.
 */
export function quickPick(outcome: Outcome, confidence: Confidence, base: Probs): Probs {
  const top = CONFIDENCE[confidence]
  const others = OUTCOMES.filter((o) => o !== outcome)
  const rest = 100 - top
  const weight = base[others[0]] + base[others[1]]
  const raw = others.map((o) => (rest * base[o]) / weight)
  const floors = raw.map(Math.floor)
  // Hand the leftover point (at most one) to the bigger remainder;
  // on a tie, to the outcome with the higher base rate.
  if (floors[0] + floors[1] < rest) {
    const r0 = raw[0] - floors[0]
    const r1 = raw[1] - floors[1]
    const first = r0 > r1 || (r0 === r1 && base[others[0]] >= base[others[1]])
    floors[first ? 0 : 1] += 1
  }
  return { [outcome]: top, [others[0]]: floors[0], [others[1]]: floors[1] } as Probs
}

export function outcomeFromScore(home: number, away: number): Outcome {
  return home > away ? 'H' : home === away ? 'D' : 'A'
}

/**
 * Three-outcome Brier score: sum of (p - hit)^2 over H, D, A.
 * 0 is perfect, 2 is a 100% pick on the wrong result.
 */
export function brier(p: Probs, actual: Outcome): number {
  let total = 0
  for (const o of OUTCOMES) {
    const hit = o === actual ? 1 : 0
    total += (p[o] / 100 - hit) ** 2
  }
  return total
}

/**
 * Points shown to players: 100 perfect, 67 for a lazy 33/33/34, 0 worst.
 * Equal to round(100 - 50 * brier), done in integers so float noise can't
 * flip a rounding. Ties can't happen: if the two wrong outcomes got a% and b%,
 * the raw score is 100 - (a² + ab + b²) / 100, and a² + ab + b² is never
 * 2 mod 4, so it can't end in 50 and the raw score never ends in exactly .5.
 */
export function points(p: Probs, actual: Outcome): number {
  validatePick(p)
  let s = 0
  for (const o of OUTCOMES) s += (p[o] - (o === actual ? 100 : 0)) ** 2
  return Math.floor((20000 - s + 100) / 200)
}

/**
 * The crowd's forecast for one match: the average of every pick, frozen at
 * kickoff. Kept as fractional percentages (not rounded) so it's a fair
 * benchmark; returns null when nobody picked.
 */
export function crowd(picks: readonly Probs[]): Probs | null {
  if (picks.length === 0) return null
  const sum = { H: 0, D: 0, A: 0 }
  for (const p of picks) for (const o of OUTCOMES) sum[o] += p[o]
  return { H: sum.H / picks.length, D: sum.D / picks.length, A: sum.A / picks.length }
}

/** Base rates as a pick (fractions to percentages), for the "base rate" baseline. */
export function baseRatePick(base: Probs): Probs {
  return { H: base.H * 100, D: base.D * 100, A: base.A * 100 }
}

export interface ScoredPick {
  userId: string
  matchId: string
  points: number
}

export interface Standing {
  rank: number
  userId: string
  picks: number
  avgPoints: number
}

/**
 * Rank players by average points, dropping anyone under minPicks.
 * Ties share a rank (1, 2, 2, 4). Tie order within a rank: more picks first,
 * then userId, so the list is stable between refreshes.
 */
export function leaderboard(scored: readonly ScoredPick[], minPicks: number): Standing[] {
  const byUser = new Map<string, { total: number; n: number }>()
  for (const s of scored) {
    const u = byUser.get(s.userId) ?? { total: 0, n: 0 }
    u.total += s.points
    u.n += 1
    byUser.set(s.userId, u)
  }
  const rows = [...byUser]
    .filter(([, u]) => u.n >= minPicks)
    .map(([userId, u]) => ({ userId, picks: u.n, total: u.total }))
  // Compare averages by cross-multiplying so equal averages tie exactly
  // (70/3 vs 140/6) instead of by floating-point accident.
  rows.sort(
    (a, b) =>
      b.total * a.picks - a.total * b.picks || b.picks - a.picks || (a.userId < b.userId ? -1 : 1),
  )
  const out: Standing[] = []
  rows.forEach((r, i) => {
    const prev = rows[i - 1]
    const tied = prev !== undefined && r.total * prev.picks === prev.total * r.picks
    out.push({
      rank: tied ? out[i - 1].rank : i + 1,
      userId: r.userId,
      picks: r.picks,
      avgPoints: r.total / r.picks,
    })
  })
  return out
}

/**
 * "You beat the crowd on 7 of 10": matches where your Brier is lower than the
 * crowd's. Compared on raw Brier, not rounded points, so a near-miss isn't a tie.
 */
export function beatCrowd(
  yours: readonly { pick: Probs; crowd: Probs; actual: Outcome }[],
): { beat: number; of: number } {
  let beat = 0
  for (const m of yours) {
    if (brier(m.pick, m.actual) < brier(m.crowd, m.actual)) beat += 1
  }
  return { beat, of: yours.length }
}
