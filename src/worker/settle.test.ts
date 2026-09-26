// M2 proof: replay the real feed around the 2026-09-20 matches and check that
// they settle and score exactly as scoring.ts says.

import { describe, expect, it } from 'vitest'
import { matchId, type FeedMatch } from '../data/openfootball'
import {
  BASE_RATES,
  CONFIDENCE,
  MIN_PICKS,
  OUTCOMES,
  crowd,
  leaderboard,
  outcomeFromScore,
  points,
  quickPick,
  type Confidence,
  type League,
  type Outcome,
  type Probs,
} from '../scoring/scoring'
import { LEAGUE_IDS, handle, weekOf } from './api'
import type { Env } from './db'
import { POINTS_SQL, VOID_AFTER_MS, settle, sync, type Fetcher } from './settle'
import { feed } from './testing/feeds'
import { testDb } from './testing/sqlite'

const at = (s: string) => Date.parse(s)

/** The live feed as it looked at `asOf`: no scores for matches on or after that date. */
function feedAsOf(league: League, asOf: string) {
  const f = feed(league)
  return {
    ...f,
    matches: f.matches.map((m) => (m.date < asOf ? m : { ...m, score: undefined })),
  }
}

function fetcherFor(feeds: Partial<Record<League, unknown>>): Fetcher {
  return async (url) => {
    const league = LEAGUE_IDS.find((l) => url.endsWith(`/2026-27/${l}.json`))
    const body = league && feeds[league]
    return body
      ? { ok: true, status: 200, json: async () => structuredClone(body) }
      : { ok: false, status: 404, json: async () => null }
  }
}

function setup() {
  const db = testDb()
  const env: Env = { DB: db, FAKE_USERS: '1', ADMIN_TOKEN: 'secret' }
  const noFetch: Fetcher = async () => {
    throw new Error('unexpected fetch')
  }
  async function call(now: number, method: string, path: string, opts: { user?: string; body?: unknown; admin?: boolean } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.user) headers['x-fake-user'] = opts.user
    if (opts.admin) headers.authorization = 'Bearer secret'
    const res = await handle(
      new Request(`https://api.test${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      env,
      now,
      noFetch,
    )
    return { status: res.status, body: (await res.json()) as any }
  }
  return { db, env, call }
}

/** Deterministic pseudo-random picks so the test is reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x80000000
  }
}

function randomPick(r: () => number): Probs {
  const h = Math.floor(r() * 101)
  const d = Math.floor(r() * (101 - h))
  return { H: h, D: d, A: 100 - h - d }
}

describe('POINTS_SQL', () => {
  it('matches points() for every whole-percent pick and result', () => {
    const { sqlite } = testDb()
    sqlite.exec('CREATE TABLE t (h INTEGER, d INTEGER, a INTEGER, result TEXT)')
    const ins = sqlite.prepare('INSERT INTO t VALUES (?, ?, ?, ?)')
    sqlite.exec('BEGIN')
    for (let h = 0; h <= 100; h++)
      for (let d = 0; d <= 100 - h; d++) for (const o of OUTCOMES) ins.run(h, d, 100 - h - d, o)
    sqlite.exec('COMMIT')
    const rows = sqlite.prepare(`SELECT h, d, a, result, ${POINTS_SQL} AS pts FROM t AS r`).all() as {
      h: number; d: number; a: number; result: Outcome; pts: number
    }[]
    expect(rows).toHaveLength(5151 * 3)
    for (const r of rows) expect(r.pts).toBe(points({ H: r.h, D: r.d, A: r.a }, r.result))
  })
})

describe('weekOf', () => {
  it('runs Tuesday to Tuesday UTC', () => {
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
    for (const day of ['2026-09-15', '2026-09-18', '2026-09-20', '2026-09-21']) {
      const w = weekOf(at(`${day}T21:00:00Z`))
      expect([iso(w.start), iso(w.end)]).toEqual(['2026-09-15', '2026-09-22'])
    }
    expect(iso(weekOf(at('2026-09-22T00:00:00Z')).start)).toBe('2026-09-22')
  })
})

describe('M2 proof: the 9/20 matches settle and score correctly', async () => {
  const { db, call } = setup()
  const users = Array.from({ length: 12 }, (_, i) => `fan_${i + 1}`)
  const r = rng(20260920)

  // Friday 9/18: the feed has results through 9/17 and fixtures after.
  const friday = at('2026-09-18T09:00:00Z')
  const first = await sync(db, friday, fetcherFor({ 'en.1': feedAsOf('en.1', '2026-09-18'), 'es.1': feedAsOf('es.1', '2026-09-18') }), LEAGUE_IDS)

  // Everyone picks every match from Friday to Sunday: half two-tap, half exact.
  const { body: upcoming } = await call(friday, 'GET', '/matches?from=2026-09-18&to=2026-09-20')
  const made = new Map<string, Probs>() // `${user}|${matchId}`
  for (const user of users) {
    for (const m of upcoming.matches) {
      let body: object
      if (r() < 0.5) {
        const outcome = OUTCOMES[Math.floor(r() * 3)]
        const confidence = (Object.keys(CONFIDENCE) as Confidence[])[Math.floor(r() * 4)]
        body = { matchId: m.id, outcome, confidence }
        made.set(`${user}|${m.id}`, quickPick(outcome, confidence, BASE_RATES[m.league as League]))
      } else {
        const pick = randomPick(r)
        body = { matchId: m.id, pick }
        made.set(`${user}|${m.id}`, pick)
      }
      const res = await call(friday, 'POST', '/picks', { user, body })
      expect(res.status).toBe(200)
    }
  }

  // Tuesday 9/22: results through 9/20 are in the feed (pushed that day).
  const tuesday = at('2026-09-22T18:00:00Z')
  const second = await sync(db, tuesday, fetcherFor({ 'en.1': feed('en.1'), 'es.1': feed('es.1') }), LEAGUE_IDS)

  const truth = LEAGUE_IDS.flatMap((l) =>
    feed(l).matches
      .filter((m) => m.date >= '2026-09-18' && m.date <= '2026-09-20')
      .map((m: FeedMatch) => {
        const s = Array.isArray(m.score) ? m.score : m.score!.ft!
        return { id: matchId(l, '2026-27', m.team1, m.team2), date: m.date, actual: outcomeFromScore(s[0], s[1]) }
      }),
  )

  it('synced both leagues and settled only what had finished', () => {
    expect(first.leagues).toEqual({ 'en.1': { fixtures: 380, skipped: 0 }, 'es.1': { fixtures: 380, skipped: 0 } })
    // Before the 9/18 cutoff: 40 EPL + 59 La Liga already had results.
    expect(first.settled).toBe(99)
    // Friday to Sunday: 10 EPL + 10 La Liga.
    expect(second.settled).toBe(20)
    expect(first.voided + second.voided).toBe(0)
  })

  it('had picks on every Friday-Sunday match, including all nine on 9/20', () => {
    expect(upcoming.matches).toHaveLength(20)
    expect(truth).toHaveLength(20)
    expect(truth.filter((t) => t.date === '2026-09-20')).toHaveLength(9)
  })

  it('settles each match with the feed result and the frozen crowd', async () => {
    for (const t of truth) {
      const m = db.sqlite.prepare('SELECT * FROM matches WHERE id = ?').get(t.id) as Record<string, unknown>
      expect(m.status).toBe('settled')
      expect(m.result).toBe(t.actual)
      const c = crowd(users.map((u) => made.get(`${u}|${t.id}`)!))!
      expect(m.crowd_n).toBe(users.length)
      expect(m.crowd_h).toBeCloseTo(c.H, 10)
      expect(m.crowd_d).toBeCloseTo(c.D, 10)
      expect(m.crowd_a).toBeCloseTo(c.A, 10)
    }
  })

  it('scores every pick exactly as points() does', async () => {
    const rows = db.sqlite.prepare('SELECT user_id, match_id, h, d, a, points FROM picks').all() as {
      user_id: string; match_id: string; h: number; d: number; a: number; points: number
    }[]
    expect(rows).toHaveLength(users.length * truth.length)
    const actual = new Map(truth.map((t) => [t.id, t.actual]))
    for (const p of rows) {
      const pick = made.get(`${p.user_id.replace('fake:', '')}|${p.match_id}`)!
      expect({ H: p.h, D: p.d, A: p.a }).toEqual(pick)
      expect(p.points).toBe(points(pick, actual.get(p.match_id)!))
    }
  })

  it('ranks the week the way leaderboard() does', async () => {
    const { status, body } = await call(tuesday, 'GET', '/leaderboard?period=week&date=2026-09-20')
    expect(status).toBe(200)
    expect(body.from).toBe('2026-09-15T00:00:00.000Z')
    expect(body.minPicks).toBe(MIN_PICKS.week)
    const actual = new Map(truth.map((t) => [t.id, t.actual]))
    const expected = leaderboard(
      [...made].map(([key, pick]) => {
        const [user, id] = key.split(/\|(.*)/s)
        return { userId: `fake:${user}`, matchId: id, points: points(pick, actual.get(id)!) }
      }),
      MIN_PICKS.week,
    )
    expect(body.standings.map(({ username: _, ...s }: { username: string }) => s)).toEqual(expected)
    expect(body.standings).toHaveLength(12)
  })

  it('shows a player their scored picks', async () => {
    const { body } = await call(tuesday, 'GET', '/picks', { user: 'fan_1' })
    expect(body.picks).toHaveLength(truth.length)
    for (const p of body.picks) {
      expect(p.status).toBe('settled')
      expect(p.points).toBe(points(p.pick, p.result))
      expect(p.crowd.n).toBe(12)
    }
  })

  it('is idempotent: another cron run changes nothing', async () => {
    const again = await sync(db, tuesday + 6 * 3600_000, fetcherFor({ 'en.1': feed('en.1'), 'es.1': feed('es.1') }), LEAGUE_IDS)
    expect(again).toMatchObject({ settled: 0, voided: 0 })
  })
})

describe('pick locking', () => {
  it('accepts picks until kickoff and refuses them from kickoff on', async () => {
    const { db, call } = setup()
    const friday = at('2026-09-18T09:00:00Z')
    await sync(db, friday, fetcherFor({ 'en.1': feedAsOf('en.1', '2026-09-18') }), ['en.1'])
    const id = matchId('en.1', '2026-27', 'AFC Bournemouth', 'Liverpool FC') // Sun 14:00 BST
    const kickoff = at('2026-09-20T13:00:00Z')
    const pick = { matchId: id, pick: { H: 20, D: 25, A: 55 } }

    expect((await call(kickoff - 1, 'POST', '/picks', { user: 'late_fan', body: pick })).status).toBe(200)
    const locked = await call(kickoff, 'POST', '/picks', { user: 'late_fan', body: { ...pick, pick: { H: 0, D: 0, A: 100 } } })
    expect(locked).toEqual({ status: 409, body: { error: 'picks are locked for this match' } })
    const { body } = await call(kickoff, 'GET', '/picks', { user: 'late_fan' })
    expect(body.picks[0].pick).toEqual({ H: 20, D: 25, A: 55 })
    expect(body.picks[0].locked).toBe(true)
  })

  it('rejects bad picks', async () => {
    const { db, call } = setup()
    const now = at('2026-09-18T09:00:00Z')
    await sync(db, now, fetcherFor({ 'en.1': feedAsOf('en.1', '2026-09-18') }), ['en.1'])
    const id = matchId('en.1', '2026-27', 'AFC Bournemouth', 'Liverpool FC')
    const post = (body: unknown, user: string | null = 'fan') =>
      call(now, 'POST', '/picks', { user: user ?? undefined, body })
    expect((await post({ matchId: id, pick: { H: 50, D: 50, A: 1 } })).status).toBe(400)
    expect((await post({ matchId: id, pick: { H: 50.5, D: 49.5, A: 0 } })).status).toBe(400)
    expect((await post({ matchId: id, outcome: 'X', confidence: 'lock' })).status).toBe(400)
    expect((await post({ matchId: id, outcome: 'H', confidence: 'sure' })).status).toBe(400)
    expect((await post({ matchId: 'nope', outcome: 'H', confidence: 'lock' })).status).toBe(404)
    expect((await post({ matchId: id, outcome: 'H', confidence: 'lock' }, null)).status).toBe(401)
    expect((await post({ matchId: id, outcome: 'H', confidence: 'lock' }, 'a b')).status).toBe(400)
  })

  it('ignores X-Fake-User unless FAKE_USERS is on', async () => {
    const db = testDb()
    const res = await handle(
      new Request('https://api.test/picks', { headers: { 'x-fake-user': 'fan' } }),
      { DB: db },
      Date.now(),
      fetch,
    )
    expect(res.status).toBe(401)
  })
})

describe('feed changes after picks', () => {
  const id = matchId('en.1', '2026-27', 'AFC Bournemouth', 'Liverpool FC')
  const only = (patch: Partial<FeedMatch>) => ({
    matches: [{ round: 'Matchday 5', date: '2026-09-20', time: '14:00', team1: 'AFC Bournemouth', team2: 'Liverpool FC', ...patch }],
  })

  it('keeps picks on a rescheduled match and moves the lock', async () => {
    const { db, call } = setup()
    const t0 = at('2026-09-18T09:00:00Z')
    await sync(db, t0, fetcherFor({ 'en.1': only({}) }), ['en.1'])
    await call(t0, 'POST', '/picks', { user: 'fan', body: { matchId: id, outcome: 'A', confidence: 'likely' } })
    // Postponed to Wednesday 19:30.
    await sync(db, t0 + 1, fetcherFor({ 'en.1': only({ date: '2026-09-23', time: '19:30' }) }), ['en.1'])
    const sunday = at('2026-09-20T15:00:00Z')
    const { body } = await call(sunday, 'GET', '/picks', { user: 'fan' })
    expect(body.picks[0]).toMatchObject({ date: '2026-09-23', kickoffAt: '2026-09-23T18:30:00.000Z', locked: false })
    expect((await call(sunday, 'POST', '/picks', { user: 'fan', body: { matchId: id, outcome: 'D', confidence: 'lean' } })).status).toBe(200)
  })

  it('re-scores when the feed corrects a result, and not otherwise', async () => {
    const { db, call } = setup()
    const t0 = at('2026-09-18T09:00:00Z')
    await sync(db, t0, fetcherFor({ 'en.1': only({}) }), ['en.1'])
    await call(t0, 'POST', '/picks', { user: 'fan', body: { matchId: id, pick: { H: 10, D: 20, A: 70 } } })
    const t1 = at('2026-09-22T00:00:00Z')
    expect((await sync(db, t1, fetcherFor({ 'en.1': only({ score: [0, 1] }) }), ['en.1'])).settled).toBe(1)
    const pts = () => (db.sqlite.prepare('SELECT points FROM picks').get() as { points: number }).points
    expect(pts()).toBe(points({ H: 10, D: 20, A: 70 }, 'A'))
    // Same result, different score: nothing to re-score.
    expect((await sync(db, t1 + 1, fetcherFor({ 'en.1': only({ score: [0, 2] }) }), ['en.1'])).settled).toBe(0)
    // Corrected to a draw.
    expect((await sync(db, t1 + 2, fetcherFor({ 'en.1': only({ score: [1, 1] }) }), ['en.1'])).settled).toBe(1)
    expect(pts()).toBe(points({ H: 10, D: 20, A: 70 }, 'D'))
    // The score vanishing from the feed doesn't unsettle it.
    expect((await sync(db, t1 + 3, fetcherFor({ 'en.1': only({}) }), ['en.1'])).settled).toBe(0)
    expect(pts()).toBe(points({ H: 10, D: 20, A: 70 }, 'D'))
  })

  it('voids a match with no result after 14 days, and revives it if one arrives', async () => {
    const { db, call } = setup()
    const t0 = at('2026-09-18T09:00:00Z')
    await sync(db, t0, fetcherFor({ 'en.1': only({}) }), ['en.1'])
    await call(t0, 'POST', '/picks', { user: 'fan', body: { matchId: id, pick: { H: 10, D: 20, A: 70 } } })
    const kickoff = at('2026-09-20T13:00:00Z')
    expect((await settle(db, kickoff + VOID_AFTER_MS)).voided).toBe(0)
    expect((await settle(db, kickoff + VOID_AFTER_MS + 1)).voided).toBe(1)
    const m = () => db.sqlite.prepare('SELECT status, result FROM matches').get()
    expect(m()).toEqual({ status: 'void', result: null })
    const late = kickoff + VOID_AFTER_MS + 2
    expect((await sync(db, late, fetcherFor({ 'en.1': only({ score: [2, 2] }) }), ['en.1'])).settled).toBe(1)
    expect(m()).toEqual({ status: 'settled', result: 'D' })
  })

  it('lets an admin enter a score the feed never sends, and keeps it over the feed', async () => {
    const { db, call } = setup()
    const t0 = at('2026-09-18T09:00:00Z')
    await sync(db, t0, fetcherFor({ 'en.1': only({}) }), ['en.1'])
    await call(t0, 'POST', '/picks', { user: 'fan', body: { matchId: id, pick: { H: 10, D: 20, A: 70 } } })
    const early = await call(t0, 'POST', '/admin/score', { admin: true, body: { matchId: id, home: 2, away: 0 } })
    expect(early).toEqual({ status: 409, body: { error: 'match has not kicked off' } })
    const t1 = at('2026-09-21T00:00:00Z')
    expect((await call(t1, 'POST', '/admin/score', { body: { matchId: id, home: 2, away: 0 } })).status).toBe(401)
    expect((await call(t1, 'POST', '/admin/score', { admin: true, body: { matchId: 'nope', home: 2, away: 0 } })).status).toBe(404)
    const res = await call(t1, 'POST', '/admin/score', { admin: true, body: { matchId: id, home: 2, away: 0 } })
    expect(res).toEqual({ status: 200, body: { settled: 1, voided: 0 } })
    await sync(db, t1 + 1, fetcherFor({ 'en.1': only({ score: [0, 1] }) }), ['en.1'])
    expect(db.sqlite.prepare('SELECT home_goals, away_goals, score_source, result FROM matches').get()).toEqual({
      home_goals: 2, away_goals: 0, score_source: 'admin', result: 'H',
    })
  })

  it('keeps settling when one league feed is down', async () => {
    const { db } = setup()
    const report = await sync(db, at('2026-09-22T18:00:00Z'), fetcherFor({ 'es.1': feed('es.1') }), LEAGUE_IDS)
    expect(report.leagues['en.1']).toEqual({ error: 'HTTP 404' })
    expect(report.settled).toBe(69)
  })
})
