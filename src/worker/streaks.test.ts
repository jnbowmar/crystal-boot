import { beforeEach, describe, expect, it } from 'vitest'
import { points, weekKey } from '../scoring/scoring'
import { handle } from './api'
import type { Env } from './db'
import { settle } from './settle'
import { WEEK_SQL } from './streaks'
import { testDb } from './testing/sqlite'

const H = 3600_000
const SAT = Date.parse('2026-10-10T14:00:00Z') // week of Tue 6 Oct
const SUN = Date.parse('2026-10-11T14:00:00Z')
const NEXT_SAT = Date.parse('2026-10-17T14:00:00Z')
const FRIDAY = Date.parse('2026-10-09T09:00:00Z') // before any kickoff

let env: Env & { DB: ReturnType<typeof testDb> }

function addMatch(id: string, kickoff: number) {
  env.DB.sqlite
    .prepare(
      `INSERT INTO matches (id, league, season, home, away, date, kickoff_at, updated_at)
       VALUES (?, 'en.1', '2026-27', ?, 'Away FC', ?, ?, 0)`,
    )
    .run(id, `Home ${id}`, new Date(kickoff).toISOString().slice(0, 10), kickoff)
}

beforeEach(() => {
  env = { DB: testDb(), FAKE_USERS: '1' }
  addMatch('a', SAT)
  addMatch('b', SAT + 2 * H)
  addMatch('c', SUN)
  addMatch('n', NEXT_SAT)
})

async function call(now: number, method: string, path: string, body?: unknown, user = 'james') {
  const res = await handle(
    new Request(`https://app.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-fake-user': user },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    now,
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

const pick = (matchId: string, user = 'james', now = FRIDAY) =>
  call(now, 'POST', '/api/picks', { matchId, pick: { H: 60, D: 20, A: 20 } }, user)
const bank = (matchId: string, on = true, now = FRIDAY) => call(now, 'POST', '/api/banker', { matchId, on })
const bankers = () =>
  (env.DB.sqlite.prepare('SELECT match_id FROM picks WHERE banker_week IS NOT NULL ORDER BY match_id').all() as {
    match_id: string
  }[]).map((r) => r.match_id)

describe('banker', () => {
  it('needs a pick on the match first', async () => {
    expect((await bank('a')).status).toBe(404)
  })

  it('is one per week, and moves until kickoff', async () => {
    await pick('a')
    await pick('b')
    await pick('n')
    expect((await bank('a')).status).toBe(200)
    expect(bankers()).toEqual(['a'])
    expect((await bank('b')).status).toBe(200)
    expect(bankers()).toEqual(['b']) // moved, not added
    expect((await bank('n')).status).toBe(200) // next week has its own
    expect(bankers()).toEqual(['b', 'n'])
    const { body } = await call(FRIDAY, 'GET', '/api/matches?from=2026-10-09&to=2026-10-20')
    expect(body.matches.filter((m: { banker: boolean }) => m.banker).map((m: { id: string }) => m.id)).toEqual(['b', 'n'])
  })

  it('locks once the banked match kicks off', async () => {
    await pick('a')
    await pick('c')
    await bank('a')
    const afterA = SAT + H
    const move = await bank('c', true, afterA)
    expect(move.status).toBe(409)
    expect(move.body.error).toBe("this week's banker has already kicked off")
    expect((await bank('a', false, afterA)).status).toBe(409)
    expect(bankers()).toEqual(['a'])
  })

  it("can't be put on a match that has kicked off, and can be taken off before", async () => {
    await pick('a')
    await pick('c')
    expect((await bank('a', true, SAT + H)).status).toBe(409)
    await bank('c')
    expect((await bank('c', false)).status).toBe(200)
    expect(bankers()).toEqual([])
  })

  it('doubles the points at settlement', async () => {
    await pick('a')
    await pick('b')
    await pick('a', 'amy')
    await bank('a')
    env.DB.sqlite.exec("UPDATE matches SET home_goals = 1, away_goals = 0 WHERE id IN ('a', 'b')")
    await settle(env.DB, SUN + 6 * H)
    const base = points({ H: 60, D: 20, A: 20 }, 'H')
    const rows = env.DB.sqlite.prepare('SELECT user_id, match_id, points FROM picks ORDER BY user_id, match_id').all()
    expect(rows).toEqual([
      { user_id: 'fake:amy', match_id: 'a', points: base },
      { user_id: 'fake:james', match_id: 'a', points: 2 * base },
      { user_id: 'fake:james', match_id: 'b', points: base },
    ])
    const table = await call(SUN + 7 * H, 'GET', '/api/leaderboard?period=week&date=2026-10-10')
    expect(table.body.me.totalPoints).toBe(3 * base)
  })

  it('checks its input', async () => {
    expect((await call(FRIDAY, 'POST', '/api/banker', { on: true })).status).toBe(400)
    expect((await call(FRIDAY, 'POST', '/api/banker', { matchId: 'a' })).status).toBe(400)
  })
})

describe('streaks', () => {
  function fillWeek(prefix: string, kickoff: number, n: number) {
    for (let i = 0; i < n; i++) addMatch(`${prefix}${i}`, kickoff + i * H)
  }

  it("shows this week's progress and the run so far", async () => {
    // Two earlier weeks of 12 matches, an international break, then this week.
    const w1 = Date.parse('2026-09-12T12:00:00Z')
    const w2 = Date.parse('2026-09-19T12:00:00Z')
    fillWeek('x', w1, 12)
    fillWeek('y', w2, 12)
    for (let i = 0; i < 10; i++) {
      await pick(`x${i}`, 'james', w1 - H)
      await pick(`y${i}`, 'james', w2 - H)
    }
    await pick('a')
    const status = await call(FRIDAY, 'GET', '/api/streak')
    // This week has 3 matches (a, b, c), so all 3 are needed; 1 picked so far.
    expect(status.body).toEqual({ streak: 2, week: { matches: 3, picks: 1, target: 3 } })

    await pick('b')
    await pick('c')
    expect((await call(FRIDAY, 'GET', '/api/streak')).body.streak).toBe(3)
  })

  it('shows on the table next to each player', async () => {
    const w1 = Date.parse('2026-09-19T12:00:00Z')
    fillWeek('y', w1, 10)
    for (let i = 0; i < 10; i++) await pick(`y${i}`, 'james', w1 - H)
    await pick('y0', 'amy', w1 - H)
    env.DB.sqlite.exec("UPDATE matches SET home_goals = 2, away_goals = 1 WHERE id LIKE 'y%'")
    await settle(env.DB, w1 + 20 * H)
    const { body } = await call(FRIDAY, 'GET', '/api/leaderboard?period=season')
    expect(body.standings.map((s: { username: string; streak: number }) => [s.username, s.streak])).toEqual([
      ['james', 1],
      ['amy', 0],
    ])
  })

  it('WEEK_SQL agrees with weekKey()', () => {
    const { sqlite } = env.DB
    for (let t = Date.parse('2026-08-01T00:00:00Z'); t < Date.parse('2027-06-01T00:00:00Z'); t += 5 * H + 17_000) {
      const row = sqlite.prepare(`SELECT ${WEEK_SQL('?')} AS w`.replaceAll('?', String(t))).get() as { w: number }
      expect(row.w).toBe(weekKey(t))
    }
  })
})
