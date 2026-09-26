import { describe, expect, it } from 'vitest'
import { handle } from './api'
import { SESSION_MS, sha256 } from './auth'
import type { Env } from './db'
import type { Fetcher } from './settle'
import { testDb } from './testing/sqlite'

const NOW = Date.parse('2026-10-01T12:00:00Z')

/** A stand-in for Pi's /v2/me: token → user. */
function fakePi(users: Record<string, { uid: string; username?: string }>, calls: string[] = []): Fetcher {
  return async (url, init) => {
    calls.push(url)
    const token = init?.headers?.authorization?.replace('Bearer ', '') ?? ''
    const user = users[token]
    if (!user) return { ok: false, status: 401, json: async () => ({ error: 'invalid token' }) }
    return { ok: true, status: 200, json: async () => ({ ...user, credentials: { scopes: ['username'] } }) }
  }
}

function setup(env: Partial<Env> = {}) {
  const db = testDb()
  const calls: string[] = []
  const pi = fakePi({ 'pi-token-james': { uid: 'u-123', username: 'james' }, 'pi-token-anon': { uid: 'u-999xyz' } }, calls)
  const call = async (method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; now?: number } = {}) => {
    const res = await handle(
      new Request(`https://app.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { DB: db, ...env },
      opts.now ?? NOW,
      pi,
    )
    return { status: res.status, body: (await res.json()) as any }
  }
  const signIn = async (accessToken: string, now = NOW) => call('POST', '/api/auth', { body: { accessToken }, now })
  return { db, call, calls, signIn }
}

describe('Pi sign-in', () => {
  it('verifies the token with /v2/me and issues a session', async () => {
    const { call, calls, signIn, db } = setup()
    const { status, body } = await signIn('pi-token-james')
    expect(status).toBe(200)
    expect(calls).toEqual(['https://api.minepi.com/v2/me'])
    expect(body.user).toEqual({ id: 'pi:u-123', username: 'james' })
    expect(body.expiresAt).toBe(new Date(NOW + SESSION_MS).toISOString())
    // Only the hash is stored.
    const row = db.sqlite.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }
    expect(row.token_hash).toBe(await sha256(body.token))
    expect(row.token_hash).not.toContain(body.token)

    const me = await call('GET', '/api/me', { headers: { authorization: `Bearer ${body.token}` } })
    expect(me).toEqual({ status: 200, body: { user: { id: 'pi:u-123', username: 'james' } } })
    expect(calls).toHaveLength(1) // the session doesn't go back to Pi
  })

  it('rejects a token Pi rejects', async () => {
    const { signIn, db } = setup()
    expect(await signIn('forged')).toEqual({ status: 401, body: { error: 'Pi rejected the access token' } })
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 })
  })

  it('reports Pi being down as a 502, not a bad token', async () => {
    const db = testDb()
    const res = await handle(
      new Request('https://app.test/api/auth', { method: 'POST', body: JSON.stringify({ accessToken: 'x' }) }),
      { DB: db },
      NOW,
      async () => ({ ok: false, status: 503, json: async () => null }),
    )
    expect(res.status).toBe(502)
  })

  it('uses PI_API when set', async () => {
    const { signIn, calls } = setup({ PI_API: 'https://pi.test' })
    await signIn('pi-token-james')
    expect(calls).toEqual(['https://pi.test/v2/me'])
  })

  it('names a user who declined the username scope', async () => {
    const { signIn } = setup()
    expect((await signIn('pi-token-anon')).body.user).toEqual({ id: 'pi:u-999xyz', username: 'pioneer-u-999x' })
  })

  it('expires sessions after 30 days', async () => {
    const { call, signIn } = setup()
    const { body } = await signIn('pi-token-james')
    const auth = { authorization: `Bearer ${body.token}` }
    expect((await call('GET', '/api/me', { headers: auth, now: NOW + SESSION_MS - 1 })).status).toBe(200)
    expect(await call('GET', '/api/me', { headers: auth, now: NOW + SESSION_MS })).toEqual({
      status: 401,
      body: { error: 'session expired, sign in again' },
    })
  })

  it('401s a bad session even on routes that allow anonymous use', async () => {
    const { call } = setup()
    expect((await call('GET', '/api/matches')).status).toBe(200)
    expect((await call('GET', '/api/matches', { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await call('GET', '/api/matches', { headers: { authorization: 'Basic abc' } })).status).toBe(401)
  })

  it('keeps one user across sign-ins and picks up a username change', async () => {
    const db = testDb()
    let name = 'james'
    const pi: Fetcher = async () => ({ ok: true, status: 200, json: async () => ({ uid: 'u-1', username: name }) })
    const signIn = (now: number) =>
      handle(new Request('https://app.test/api/auth', { method: 'POST', body: '{"accessToken":"t"}' }), { DB: db }, now, pi)
    await signIn(NOW)
    name = 'james_b'
    await signIn(NOW + 1000)
    expect(db.sqlite.prepare('SELECT id, username FROM users').all()).toEqual([{ id: 'pi:u-1', username: 'james_b' }])
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 2 })
  })

  it('reports the runtime config the app needs', async () => {
    expect((await setup({ PI_SANDBOX: '1' }).call('GET', '/api/config')).body).toEqual({ piSandbox: true, fakeUsers: false })
    expect((await setup({ FAKE_USERS: '1' }).call('GET', '/api/config')).body).toEqual({ piSandbox: false, fakeUsers: true })
  })
})
