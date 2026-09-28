import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASE_RATES,
  CONFIDENCE,
  OUTCOMES,
  baseRatePick,
  beatCrowd,
  brier,
  crowd,
  leaderboard,
  outcomeFromScore,
  points,
  quickPick,
  streak,
  validatePick,
  weekKey,
  weekStart,
  type Confidence,
  type Outcome,
  type Probs,
  type ScoredPick,
} from './scoring'

const FIX = join(import.meta.dirname, '__fixtures__', 'brier.expected.json')

describe('parity with an independent Python Brier scorer', () => {
  const { cases } = JSON.parse(readFileSync(FIX, 'utf8')) as {
    cases: { pick: Probs; actual: Outcome; brier: number; points: number }[]
  }
  it('has the fixture (run: npm run parity)', () => {
    expect(cases.length).toBe(693)
  })
  it('matches Brier and points on every 5%-grid pick and result', () => {
    for (const c of cases) {
      expect(brier(c.pick, c.actual)).toBeCloseTo(c.brier, 12)
      expect(points(c.pick, c.actual)).toBe(c.points)
    }
  })
})

describe('worked example (the one in SPEC.md)', () => {
  // Arsenal v Coventry, 3-0. Three players:
  const bold = { H: 95, D: 2, A: 3 } // "Lock" on Arsenal
  const lazy = { H: 33, D: 33, A: 34 } // no opinion
  const wrong = { H: 5, D: 15, A: 80 } // "Confident" Coventry
  it('rewards the confident right pick', () => {
    // (0.95-1)² + 0.02² + 0.03² = 0.0025 + 0.0004 + 0.0009 = 0.0038
    expect(brier(bold, 'H')).toBeCloseTo(0.0038, 12)
    expect(points(bold, 'H')).toBe(100) // 99.81 rounds up
  })
  it('gives about 67 for no opinion', () => {
    // 0.67² + 0.33² + 0.34² = 0.4489 + 0.1089 + 0.1156 = 0.6734 → 66.33
    expect(points(lazy, 'H')).toBe(66)
    expect(points({ H: 34, D: 33, A: 33 }, 'H')).toBe(67)
  })
  it('punishes the confident wrong pick hardest', () => {
    // 0.95² + 0.15² + 0.80² = 0.9025 + 0.0225 + 0.64 = 1.565 → 21.75
    expect(points(wrong, 'H')).toBe(22)
  })
})

describe('points', () => {
  it('spans 0 to 100', () => {
    expect(points({ H: 100, D: 0, A: 0 }, 'H')).toBe(100)
    expect(points({ H: 100, D: 0, A: 0 }, 'A')).toBe(0)
  })
  it('is never exactly on .5 for any whole-percentage pick', () => {
    for (let h = 0; h <= 100; h++) {
      for (let d = 0; d <= 100 - h; d++) {
        for (const o of OUTCOMES) {
          const raw = 100 - 50 * brier({ H: h, D: d, A: 100 - h - d }, o)
          expect(Math.abs((raw % 1) - 0.5)).toBeGreaterThan(1e-6)
        }
      }
    }
  })
  it('rejects bad picks', () => {
    expect(() => points({ H: 50, D: 50, A: 1 }, 'H')).toThrow(/sum to 100/)
    expect(() => points({ H: 50.5, D: 49.5, A: 0 }, 'H')).toThrow(/whole number/)
    expect(() => points({ H: 110, D: -10, A: 0 }, 'H')).toThrow(/whole number/)
  })
})

describe('validatePick', () => {
  it('accepts a normal pick', () => {
    expect(() => validatePick({ H: 65, D: 15, A: 20 })).not.toThrow()
  })
})

describe('quickPick', () => {
  const levels = Object.keys(CONFIDENCE) as Confidence[]
  it('always makes a valid pick with the chosen level on top', () => {
    for (const base of Object.values(BASE_RATES)) {
      for (const o of OUTCOMES) {
        for (const c of levels) {
          const p = quickPick(o, c, base)
          expect(() => validatePick(p)).not.toThrow()
          expect(p[o]).toBe(CONFIDENCE[c])
        }
      }
    }
  })
  it('splits the rest by base rate (EPL)', () => {
    // Likely home: 35 left for D/A in 23.9 : 31.9 → 14.99 / 20.01 → 15 / 20
    expect(quickPick('H', 'likely', BASE_RATES['en.1'])).toEqual({ H: 65, D: 15, A: 20 })
    // Lock away: 5 left for H/D in 44.2 : 23.9 → 3.25 / 1.75 → 3 / 2
    expect(quickPick('A', 'lock', BASE_RATES['en.1'])).toEqual({ H: 3, D: 2, A: 95 })
  })
  it('breaks an exact remainder tie toward the likelier outcome', () => {
    // Equal base rates for H and A: 5 left → 2.5 / 2.5, tie goes to H (listed first, equal rate).
    expect(quickPick('D', 'lock', { H: 0.4, D: 0.2, A: 0.4 })).toEqual({ H: 3, D: 95, A: 2 })
    // H:A = 3:7 → 1.5 / 3.5, tie goes to A (higher rate).
    expect(quickPick('D', 'lock', { H: 0.3, D: 0.2, A: 0.7 })).toEqual({ H: 1, D: 95, A: 4 })
  })
})

describe('outcomeFromScore', () => {
  it('reads home, draw, away', () => {
    expect(outcomeFromScore(3, 0)).toBe('H')
    expect(outcomeFromScore(1, 1)).toBe('D')
    expect(outcomeFromScore(0, 2)).toBe('A')
  })
})

describe('crowd', () => {
  it('averages picks without rounding', () => {
    expect(
      crowd([
        { H: 60, D: 20, A: 20 },
        { H: 30, D: 30, A: 40 },
        { H: 50, D: 25, A: 25 },
      ]),
    ).toEqual({ H: 140 / 3, D: 25, A: 85 / 3 })
  })
  it('is null with no picks', () => {
    expect(crowd([])).toBeNull()
  })
})

describe('baseRatePick', () => {
  it('turns fractions into percentages that brier() can score', () => {
    const p = baseRatePick(BASE_RATES['en.1'])
    expect(p.H + p.D + p.A).toBeCloseTo(100, 9)
    // 0.558² + 0.239² + 0.319² = 0.311364 + 0.057121 + 0.101761
    expect(brier(p, 'H')).toBeCloseTo(0.470246, 9)
  })
})

describe('leaderboard', () => {
  const picks = (userId: string, pts: number[]): ScoredPick[] =>
    pts.map((points, i) => ({ userId, matchId: `m${i}`, points }))

  it('ranks by total points, so picking more matches counts', () => {
    const board = leaderboard([
      ...picks('ada', [80, 70, 90]), // 240
      ...picks('bo', [100, 100]), // 200: perfect, but fewer picks
      ...picks('cy', [60, 70, 80, 90]), // 300
    ])
    expect(board.map((r) => [r.rank, r.userId, r.totalPoints, r.avgPoints])).toEqual([
      [1, 'cy', 300, 75],
      [2, 'ada', 240, 80],
      [3, 'bo', 200, 100],
    ])
  })
  it('breaks equal totals by fewer picks (the higher average)', () => {
    const board = leaderboard([...picks('many', [50, 50, 50, 50]), ...picks('few', [100, 100])])
    expect(board.map((r) => [r.rank, r.userId])).toEqual([
      [1, 'few'],
      [2, 'many'],
    ])
  })
  it('shares ranks when total and picks are both equal (1, 2, 2, 4)', () => {
    const board = leaderboard([
      ...picks('a', [90, 90, 90]),
      ...picks('c', [60, 80, 70]), // 210
      ...picks('b', [70, 70, 70]), // 210, same picks
      ...picks('d', [50, 50, 50]),
    ])
    expect(board.map((r) => [r.rank, r.userId])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [2, 'c'],
      [4, 'd'],
    ])
  })
  it('ranks anyone with a scored pick, and is empty with none', () => {
    expect(leaderboard(picks('solo', [42]))).toEqual([{ rank: 1, userId: 'solo', picks: 1, totalPoints: 42, avgPoints: 42 }])
    expect(leaderboard([])).toEqual([])
  })
})

describe('beatCrowd', () => {
  it('counts matches where you beat the crowd on raw Brier', () => {
    const c = { H: 50, D: 25, A: 25 }
    expect(
      beatCrowd([
        { pick: { H: 80, D: 10, A: 10 }, crowd: c, actual: 'H' }, // beat
        { pick: { H: 80, D: 10, A: 10 }, crowd: c, actual: 'A' }, // lost
        { pick: { H: 50, D: 25, A: 25 }, crowd: c, actual: 'D' }, // equal, not a win
        { pick: { H: 51, D: 25, A: 24 }, crowd: c, actual: 'H' }, // same points, better Brier
      ]),
    ).toEqual({ beat: 2, of: 4 })
  })
})

describe('weekKey', () => {
  const key = (iso: string) => weekKey(Date.parse(iso))
  it('runs Tuesday to Monday in UTC', () => {
    const tue = key('2026-09-15T00:00:00Z')
    expect(new Date(weekStart(tue)).toISOString()).toBe('2026-09-15T00:00:00.000Z')
    expect(key('2026-09-20T14:00:00Z')).toBe(tue) // Sunday
    expect(key('2026-09-21T23:59:59Z')).toBe(tue) // Monday night
    expect(key('2026-09-22T00:00:00Z')).toBe(tue + 7) // next Tuesday
    expect(key('2026-09-14T23:59:59Z')).toBe(tue - 7)
  })
})

describe('streak', () => {
  const W = 1000 // any week key; weeks are 7 apart
  const wk = (i: number, matches: number, picks: number) => ({ week: W + 7 * i, matches, picks })
  it('counts weeks in a row that reached the target', () => {
    expect(streak([wk(0, 20, 10), wk(1, 20, 12), wk(2, 20, 15)], W + 14)).toBe(3)
    expect(streak([wk(0, 20, 10), wk(1, 20, 9), wk(2, 20, 15)], W + 14)).toBe(1)
  })
  it('needs every match in a short week', () => {
    expect(streak([wk(0, 20, 10), wk(1, 4, 4)], W + 7)).toBe(2)
    expect(streak([wk(0, 20, 10), wk(1, 4, 3)], W + 7)).toBe(1) // this week isn't done yet
    expect(streak([wk(0, 20, 10), wk(1, 4, 3), wk(2, 20, 10)], W + 14)).toBe(1)
  })
  it('skips weeks with no matches (international breaks)', () => {
    expect(streak([wk(0, 20, 10), wk(1, 0, 0), wk(2, 0, 0), wk(3, 20, 11)], W + 21)).toBe(2)
    expect(streak([wk(0, 20, 10)], W + 21)).toBe(1) // missing weeks = no matches
  })
  it("doesn't break on the week in progress, and adds it once it's done", () => {
    expect(streak([wk(0, 20, 10), wk(1, 20, 2)], W + 7)).toBe(1)
    expect(streak([wk(0, 20, 10), wk(1, 20, 10)], W + 7)).toBe(2)
  })
  it('ignores future weeks and starts at zero', () => {
    expect(streak([wk(0, 20, 10), wk(1, 20, 20)], W)).toBe(1)
    expect(streak([], W)).toBe(0)
    expect(streak([wk(0, 20, 3)], W + 7)).toBe(0)
  })
})
