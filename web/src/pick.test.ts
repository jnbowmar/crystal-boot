import { describe, expect, it } from 'vitest'
import { OUTCOMES, type Probs } from '../../src/scoring/scoring'
import { kickoffLabel, localDay, lockLabel, rebalance, shortName } from './pick'

describe('rebalance', () => {
  it('keeps the other two in proportion', () => {
    expect(rebalance({ H: 40, D: 20, A: 40 }, 'H', 70)).toEqual({ H: 70, D: 10, A: 20 })
    expect(rebalance({ H: 50, D: 25, A: 25 }, 'D', 0)).toEqual({ H: 67, D: 0, A: 33 })
  })

  it('splits evenly when the other two are both zero', () => {
    expect(rebalance({ H: 100, D: 0, A: 0 }, 'H', 40)).toEqual({ H: 40, D: 30, A: 30 })
    expect(rebalance({ H: 100, D: 0, A: 0 }, 'H', 41)).toEqual({ H: 41, D: 30, A: 29 })
  })

  it('clamps and rounds the slider value', () => {
    expect(rebalance({ H: 34, D: 33, A: 33 }, 'A', 140)).toEqual({ H: 0, D: 0, A: 100 })
    expect(rebalance({ H: 34, D: 33, A: 33 }, 'A', -5).A).toBe(0)
    expect(rebalance({ H: 34, D: 33, A: 33 }, 'A', 12.6).A).toBe(13)
  })

  it('always gives whole percentages summing to 100', () => {
    let p: Probs = { H: 34, D: 33, A: 33 }
    let seed = 7
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 48271) % 2147483647
      p = rebalance(p, OUTCOMES[seed % 3], seed % 101)
      for (const o of OUTCOMES) expect(Number.isInteger(p[o]) && p[o] >= 0).toBe(true)
      expect(p.H + p.D + p.A).toBe(100)
    }
  })
})

describe('shortName', () => {
  it('drops club suffixes and prefixes', () => {
    expect(shortName('Arsenal FC')).toBe('Arsenal')
    expect(shortName('AFC Bournemouth')).toBe('Bournemouth')
    expect(shortName('Valencia CF')).toBe('Valencia')
    expect(shortName('RC Celta de Vigo')).toBe('Celta de Vigo')
    expect(shortName('RCD Espanyol de Barcelona')).toBe('Espanyol de Barcelona')
    expect(shortName('Club Atlético de Madrid')).toBe('Club Atlético de Madrid')
    expect(shortName('Athletic Club')).toBe('Athletic Club')
  })
})

describe('kickoff labels', () => {
  const ko = '2026-10-10T11:30:00.000Z'

  it("shows kickoff in the viewer's timezone", () => {
    expect(kickoffLabel(ko, true, 'en-GB', 'Europe/London')).toBe('Sat 10 Oct · 12:30')
    expect(kickoffLabel(ko, true, 'en-GB', 'Africa/Lagos')).toBe('Sat 10 Oct · 12:30')
    expect(kickoffLabel(ko, true, 'en-GB', 'Asia/Ho_Chi_Minh')).toBe('Sat 10 Oct · 18:30')
    expect(kickoffLabel(ko, false, 'en-GB', 'Europe/London')).toBe('Sat 10 Oct · time TBC')
    expect(localDay(ko, 'Pacific/Kiritimati')).toBe('2026-10-11')
  })

  it('counts down in the last day', () => {
    const t = Date.parse(ko)
    expect(lockLabel(ko, t - 25 * 3600_000)).toBeNull()
    expect(lockLabel(ko, t - (2 * 60 + 5) * 60_000)).toBe('Locks in 2h 5m')
    expect(lockLabel(ko, t - 30_000)).toBe('Locks in 1m')
    expect(lockLabel(ko, t)).toBe('Locked')
  })
})
