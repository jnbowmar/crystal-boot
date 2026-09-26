import { describe, expect, it } from 'vitest'
import { fullTime, matchId, parseFeed } from './openfootball'
import { zonedToUtc } from './time'
import { feed } from '../worker/testing/feeds'

const iso = (t: number) => new Date(t).toISOString()

describe('zonedToUtc', () => {
  it('handles BST and GMT in London', () => {
    expect(iso(zonedToUtc('2026-09-20', '14:00', 'Europe/London'))).toBe('2026-09-20T13:00:00.000Z')
    // Clocks go back 2026-10-25.
    expect(iso(zonedToUtc('2026-10-24', '15:00', 'Europe/London'))).toBe('2026-10-24T14:00:00.000Z')
    expect(iso(zonedToUtc('2026-10-25', '15:00', 'Europe/London'))).toBe('2026-10-25T15:00:00.000Z')
    expect(iso(zonedToUtc('2026-12-26', '12:30', 'Europe/London'))).toBe('2026-12-26T12:30:00.000Z')
    expect(iso(zonedToUtc('2027-04-03', '15:00', 'Europe/London'))).toBe('2027-04-03T14:00:00.000Z')
  })

  it('handles CEST and CET in Madrid', () => {
    expect(iso(zonedToUtc('2026-09-20', '21:00', 'Europe/Madrid'))).toBe('2026-09-20T19:00:00.000Z')
    expect(iso(zonedToUtc('2026-11-01', '21:00', 'Europe/Madrid'))).toBe('2026-11-01T20:00:00.000Z')
    expect(iso(zonedToUtc('2026-10-25', '00:00', 'Europe/Madrid'))).toBe('2026-10-24T22:00:00.000Z')
  })
})

describe('fullTime', () => {
  it('reads both score shapes', () => {
    expect(fullTime({ score: { ht: [2, 0], ft: [3, 0] } as never })).toEqual([3, 0])
    expect(fullTime({ score: [0, 0] })).toEqual([0, 0])
  })

  it('is null for unplayed or malformed scores', () => {
    expect(fullTime({})).toBeNull()
    expect(fullTime({ score: null })).toBeNull()
    expect(fullTime({ score: { ht: [1, 0] } as never })).toBeNull()
    expect(fullTime({ score: [1] as never })).toBeNull()
    expect(fullTime({ score: [-1, 2] })).toBeNull()
    expect(fullTime({ score: ['1', '2'] as never })).toBeNull()
  })
})

describe('parseFeed on the real 2026-27 feeds', () => {
  const en = parseFeed('en.1', '2026-27', feed('en.1'))
  const es = parseFeed('es.1', '2026-27', feed('es.1'))

  it('reads every match with unique IDs', () => {
    for (const { fixtures, skipped } of [en, es]) {
      expect(fixtures).toHaveLength(380)
      expect(skipped).toEqual([])
      expect(new Set(fixtures.map((f) => f.id)).size).toBe(380)
    }
  })

  it('pins kickoffs to the league timezone', () => {
    const arsenal = en.fixtures.find((f) => f.id === matchId('en.1', '2026-27', 'Arsenal FC', 'Coventry City FC'))
    expect(arsenal).toMatchObject({ date: '2026-08-21', time: '20:00', score: [3, 0] })
    expect(iso(arsenal!.kickoffAt)).toBe('2026-08-21T19:00:00.000Z')
  })

  it('locks La Liga matches with no time at 00:00 Madrid', () => {
    const noTime = es.fixtures.filter((f) => f.time === null)
    expect(noTime.length).toBeGreaterThan(200)
    for (const f of noTime) {
      expect(f.kickoffAt).toBe(zonedToUtc(f.date, '00:00', 'Europe/Madrid'))
      expect(f.score).toBeNull()
    }
  })

  it('reads the bare [h, a] scores', () => {
    const leeds = en.fixtures.find((f) => f.home === 'Leeds United FC' && f.away === 'Crystal Palace FC')
    expect(leeds?.score).toEqual([0, 0])
  })

  it('skips malformed rows instead of failing the sync', () => {
    const { fixtures, skipped } = parseFeed('en.1', '2026-27', {
      matches: [
        { date: '2026-09-26', time: '15:00', team1: 'A', team2: 'B' },
        { date: '26/09/2026', team1: 'A', team2: 'C' },
        { date: '2026-09-26', time: '3pm', team1: 'A', team2: 'D' },
        { date: '2026-09-26', team1: '', team2: 'E' },
        null,
      ],
    })
    expect(fixtures).toHaveLength(1)
    expect(skipped).toHaveLength(4)
  })

  it('rejects a feed with no matches array', () => {
    expect(() => parseFeed('en.1', '2026-27', { name: 'x' })).toThrow(/no matches/)
  })
})
