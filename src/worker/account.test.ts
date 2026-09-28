import { beforeEach, describe, expect, it } from 'vitest'
import { DELETED_USERNAME } from './account'
import { handle } from './api'
import type { Env } from './db'
import { API_KEY, FakePi } from './testing/fakePi'
import { testDb } from './testing/sqlite'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const MATCH = 'en.1|2026-27|Arsenal FC|Leeds United FC'

let pi: FakePi
let env: Env & { DB: ReturnType<typeof testDb> }

beforeEach(() => {
  pi = new FakePi()
  pi.addUser('tok-james', 'u-james', 'james')
  env = { DB: testDb(), PI_API_KEY: API_KEY, FAKE_USERS: '1' }
  env.DB.sqlite
    .prepare(
      `INSERT INTO matches (id, league, season, home, away, date, kickoff_at, updated_at)
       VALUES (?, 'en.1', '2026-27', 'Arsenal FC', 'Leeds United FC', '2026-10-10', ?, ?)`,
    )
    .run(MATCH, Date.parse('2026-10-10T14:00:00Z'), NOW)
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

const signIn = async () => (await call('POST', '/api/auth', { body: { accessToken: 'tok-james' } })).body.token as string

function pick(userId: string) {
  env.DB.sqlite
    .prepare('INSERT INTO picks (user_id, match_id, h, d, a, created_at, updated_at) VALUES (?, ?, 60, 20, 20, ?, ?)')
    .run(userId, MATCH, NOW, NOW)
}

/** James pays for a league; returns it once Pi confirms. */
async function paidLeague(session: string, name: string) {
  const order = (await call('POST', '/api/leagues/order', { token: session, body: { name } })).body
  const paymentId = pi.create('u-james', order)
  await call('POST', '/api/payments/approve', { token: session, body: { paymentId } })
  const txid = pi.sign(paymentId)
  return (await call('POST', '/api/payments/complete', { token: session, body: { paymentId, txid } })).body.league
}

const count = (sql: string, ...args: unknown[]) => (env.DB.sqlite.prepare(sql).get(...(args as [])) as { n: number }).n

describe('deleting an account', () => {
  it("removes a player who never paid: row, picks, sessions and memberships, but not a friend's league", async () => {
    await call('GET', '/api/me', { fake: 'amy' })
    const amysLeague = await (async () => {
      const s = await signIn()
      return paidLeague(s, 'Amy and James')
    })()
    // Amy joins James's league; James isn't part of this test beyond owning it.
    await call('POST', '/api/leagues/join', { fake: 'amy', body: { code: amysLeague.inviteCode } })
    pick('fake:amy')

    expect((await call('POST', '/api/account/delete', { fake: 'amy' })).status).toBe(200)

    expect(count("SELECT count(*) AS n FROM users WHERE id = 'fake:amy'")).toBe(0)
    expect(count("SELECT count(*) AS n FROM picks WHERE user_id = 'fake:amy'")).toBe(0)
    expect(count("SELECT count(*) AS n FROM league_members WHERE user_id = 'fake:amy'")).toBe(0)
    expect(count('SELECT count(*) AS n FROM leagues')).toBe(1)
  })

  it('keeps payment records under an anonymised row, and the leagues friends still play in', async () => {
    const session = await signIn()
    const shared = await paidLeague(session, 'Office League')
    await paidLeague(session, 'Just Me')
    await call('POST', '/api/leagues/join', { fake: 'amy', body: { code: shared.inviteCode } })
    pick('pi:u-james')

    expect((await call('POST', '/api/account/delete', { token: session })).status).toBe(200)

    expect(env.DB.sqlite.prepare("SELECT username, country FROM users WHERE id = 'pi:u-james'").get()).toEqual({
      username: DELETED_USERNAME,
      country: null,
    })
    expect(count("SELECT count(*) AS n FROM orders WHERE user_id = 'pi:u-james' AND status = 'completed'")).toBe(2)
    expect(count("SELECT count(*) AS n FROM picks WHERE user_id = 'pi:u-james'")).toBe(0)
    expect(count("SELECT count(*) AS n FROM sessions WHERE user_id = 'pi:u-james'")).toBe(0)
    // The empty league is gone; the one Amy is in stays, with Amy still in it.
    expect(env.DB.sqlite.prepare('SELECT name FROM leagues').all()).toEqual([{ name: 'Office League' }])
    expect(count('SELECT count(*) AS n FROM league_members')).toBe(1)
    // The old session no longer works.
    expect((await call('GET', '/api/me', { token: session })).status).toBe(401)
  })

  it('cancels an order not yet sent to Pi', async () => {
    const session = await signIn()
    await call('POST', '/api/leagues/order', { token: session, body: { name: 'Later' } })
    await call('POST', '/api/account/delete', { token: session })
    expect(env.DB.sqlite.prepare('SELECT status FROM orders').all()).toEqual([{ status: 'cancelled' }])
  })

  it('refuses while a payment is in progress, and changes nothing', async () => {
    const session = await signIn()
    const order = (await call('POST', '/api/leagues/order', { token: session, body: { name: 'Mid-payment' } })).body
    const paymentId = pi.create('u-james', order)
    await call('POST', '/api/payments/approve', { token: session, body: { paymentId } })
    pick('pi:u-james')

    const res = await call('POST', '/api/account/delete', { token: session })
    expect(res.status).toBe(409)
    expect(count("SELECT count(*) AS n FROM picks WHERE user_id = 'pi:u-james'")).toBe(1)
    expect((await call('GET', '/api/me', { token: session })).status).toBe(200)
  })

  it('lets the player sign in again later as a fresh account', async () => {
    const session = await signIn()
    pick('pi:u-james')
    await call('POST', '/api/account/delete', { token: session })

    const again = await signIn()
    expect((await call('GET', '/api/me', { token: again })).body.user).toEqual({ id: 'pi:u-james', username: 'james' })
    expect((await call('GET', '/api/picks', { token: again })).body.picks).toEqual([])
  })

  it('needs a signed-in player', async () => {
    expect((await call('POST', '/api/account/delete')).status).toBe(401)
  })
})
