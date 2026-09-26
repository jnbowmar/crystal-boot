import { beforeEach, describe, expect, it } from 'vitest'
import { handle } from './api'
import type { Env } from './db'
import { CODE, MAX_MEMBERS, inviteCode, normaliseCode } from './leagues'
import { API_KEY, FakePi } from './testing/fakePi'
import { testDb } from './testing/sqlite'

const NOW = Date.parse('2026-10-01T12:00:00Z')

let pi: FakePi
let env: Env & { DB: ReturnType<typeof testDb> }

beforeEach(() => {
  pi = new FakePi()
  pi.addUser('tok-james', 'u-james', 'james')
  env = { DB: testDb(), PI_API_KEY: API_KEY, FAKE_USERS: '1' }
})

async function call(method: string, path: string, opts: { token?: string; fake?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.fake) headers['x-fake-user'] = opts.fake
  const res = await handle(
    new Request(`https://app.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    env,
    NOW,
    pi.fetcher,
  )
  return { status: res.status, body: (await res.json()) as any }
}

/** James signs in with Pi and pays for a league. */
async function paidLeague(name = 'Office League') {
  const session = (await call('POST', '/api/auth', { body: { accessToken: 'tok-james' } })).body.token
  const order = (await call('POST', '/api/leagues/order', { token: session, body: { name } })).body
  const paymentId = pi.create('u-james', order)
  await call('POST', '/api/payments/approve', { token: session, body: { paymentId } })
  const txid = pi.sign(paymentId)
  const { league } = (await call('POST', '/api/payments/complete', { token: session, body: { paymentId, txid } })).body
  return { session, league }
}

describe('invite codes', () => {
  it('are 8 unambiguous characters', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const c = inviteCode()
      expect(c).toMatch(CODE)
      expect(c).not.toMatch(/[01IO]/)
      seen.add(c)
    }
    expect(seen.size).toBe(2000)
  })

  it('forgive case, spaces and dashes', () => {
    expect(normaliseCode(' abcd-efgh ')).toBe('ABCDEFGH')
    expect(() => normaliseCode('ABCDEFG0')).toThrow(/8 letters/)
    expect(() => normaliseCode(42)).toThrow()
  })
})

describe('joining and leaving', () => {
  it('lets anyone with the code preview and join for free', async () => {
    const { league } = await paidLeague()
    const code = league.inviteCode.toLowerCase().replace(/(.{4})/, '$1-')
    expect((await call('GET', `/api/leagues/preview?code=${code}`)).body).toEqual({ name: 'Office League', members: 1 })

    const piCallsBefore = pi.calls.length
    const joined = await call('POST', '/api/leagues/join', { fake: 'ada', body: { code } })
    expect(joined.body.league).toMatchObject({ id: league.id, members: 2, isOwner: false })
    // Joining twice is harmless.
    expect((await call('POST', '/api/leagues/join', { fake: 'ada', body: { code } })).body.league.members).toBe(2)
    expect((await call('GET', '/api/leagues', { fake: 'ada' })).body.leagues).toHaveLength(1)
    expect(pi.calls.length).toBe(piCallsBefore) // joining never touches Pi
  })

  it('rejects bad and unknown codes', async () => {
    expect((await call('POST', '/api/leagues/join', { fake: 'ada', body: { code: 'nope' } })).status).toBe(400)
    expect((await call('POST', '/api/leagues/join', { fake: 'ada', body: { code: 'ABCDEFGH' } })).status).toBe(404)
    expect((await call('GET', '/api/leagues/preview?code=ABCDEFGH')).status).toBe(404)
  })

  it("lets members leave but not the creator", async () => {
    const { session, league } = await paidLeague()
    await call('POST', '/api/leagues/join', { fake: 'ada', body: { code: league.inviteCode } })
    expect((await call('POST', '/api/leagues/leave', { fake: 'ada', body: { leagueId: league.id } })).status).toBe(200)
    expect((await call('GET', '/api/leagues', { fake: 'ada' })).body.leagues).toEqual([])
    expect((await call('POST', '/api/leagues/leave', { token: session, body: { leagueId: league.id } })).body).toEqual({
      error: "the league's creator can't leave it",
    })
  })

  it(`caps a league at ${MAX_MEMBERS} players`, async () => {
    const { league } = await paidLeague()
    const add = env.DB.sqlite.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, 0)')
    const join = env.DB.sqlite.prepare('INSERT INTO league_members VALUES (?, ?, 0)')
    for (let i = 1; i < MAX_MEMBERS; i++) {
      add.run(`fake:filler${i}`, `filler${i}`)
      join.run(league.id, `fake:filler${i}`)
    }
    const full = await call('POST', '/api/leagues/join', { fake: 'latecomer', body: { code: league.inviteCode } })
    expect(full).toEqual({ status: 409, body: { error: `this league is full (${MAX_MEMBERS} players)` } })
  })
})

describe('league tables', () => {
  it('rank only members, and only members can see them', async () => {
    const { session, league } = await paidLeague()
    await call('POST', '/api/leagues/join', { fake: 'ada', body: { code: league.inviteCode } })
    // A settled match with picks from two members and one outsider.
    env.DB.sqlite.exec(`
      INSERT INTO users (id, username, created_at) VALUES ('fake:outsider', 'outsider', 0);
      INSERT INTO matches (id, league, season, home, away, date, kickoff_at, home_goals, away_goals,
        score_source, status, result, updated_at)
        VALUES ('m1', 'en.1', '2026-27', 'A', 'B', '2026-09-27', ${NOW - 86400000}, 2, 0, 'feed', 'settled', 'H', 0);
      INSERT INTO picks VALUES ('pi:u-james', 'm1', 70, 20, 10, 94, 0, 0);
      INSERT INTO picks VALUES ('fake:ada', 'm1', 40, 30, 30, 69, 0, 0);
      INSERT INTO picks VALUES ('fake:outsider', 'm1', 95, 3, 2, 100, 0, 0);
    `)
    const path = `/api/leaderboard?period=season&scope=league:${league.id}`
    const table = await call('GET', path, { token: session })
    expect(table.status).toBe(200)
    expect(table.body.scope).toBe(`league:${league.id}`)
    expect(table.body.me).toMatchObject({ userId: 'pi:u-james', picks: 1, avgPoints: 94 })
    // Nobody has the season's 50 picks yet, so compare the members' own lines:
    // the outsider's 100 counts globally but not in the league.
    const ada = await call('GET', path, { fake: 'ada' })
    expect(ada.body.me).toMatchObject({ userId: 'fake:ada', avgPoints: 69 })
    const all = await call('GET', '/api/leaderboard?period=season&scope=global', { fake: 'outsider' })
    expect(all.body.me).toMatchObject({ avgPoints: 100 })
    expect((await call('GET', path, { fake: 'outsider' })).status).toBe(403)
    expect((await call('GET', path)).status).toBe(401)
    expect((await call('GET', '/api/leaderboard?scope=bogus')).status).toBe(400)
  })

  it('ranks only members once they have enough picks', async () => {
    const { session, league } = await paidLeague()
    const insMatch = env.DB.sqlite.prepare(
      `INSERT INTO matches (id, league, season, home, away, date, kickoff_at, home_goals, away_goals, score_source,
        status, result, updated_at) VALUES (?, 'en.1', '2026-27', ?, 'X', '2026-09-26', ?, 1, 0, 'feed', 'settled', 'H', 0)`,
    )
    const insPick = env.DB.sqlite.prepare("INSERT INTO picks VALUES ('pi:u-james', ?, 60, 20, 20, 90, 0, 0)")
    const outsider = env.DB.sqlite.prepare("INSERT INTO picks VALUES ('fake:outsider', ?, 95, 3, 2, 100, 0, 0)")
    env.DB.sqlite.exec("INSERT INTO users (id, username, created_at) VALUES ('fake:outsider', 'outsider', 0)")
    for (let i = 0; i < 10; i++) {
      insMatch.run(`m${i}`, `Team ${i}`, Date.parse('2026-09-26T14:00:00Z'))
      insPick.run(`m${i}`)
      outsider.run(`m${i}`)
    }
    const q = '/api/leaderboard?period=week&date=2026-09-26'
    const global = await call('GET', q, { token: session })
    expect(global.body.standings.map((s: { username: string }) => s.username)).toEqual(['outsider', 'james'])
    const week = await call('GET', `${q}&scope=league:${league.id}`, { token: session })
    expect(week.body.standings).toEqual([
      { rank: 1, userId: 'pi:u-james', username: 'james', picks: 10, avgPoints: 90 },
    ])
  })
})
