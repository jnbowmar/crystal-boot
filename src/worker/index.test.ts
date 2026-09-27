import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { testDb } from './testing/sqlite'

afterEach(() => vi.unstubAllGlobals())

// workerd throws "Illegal invocation" when the global fetch is called as a
// method of anything but globalThis. This stand-in does the same.
function strictFetch(this: unknown, input: string) {
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
  const url = String(input)
  if (url.endsWith('/v2/me')) return Promise.resolve(Response.json({ uid: 'u1', username: 'james' }))
  return Promise.resolve(new Response('{}', { status: 404 }))
}

describe('Worker entry', () => {
  it('serves the Pi domain validation key as plain text, or 404 when unset', async () => {
    const get = (env: object) => worker.fetch(new Request('https://app.test/validation-key.txt'), { DB: testDb(), ...env })
    const res = await get({ PI_VALIDATION_KEY: 'abc123' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('abc123')
    expect((await get({})).status).toBe(404)
  })

  it('the stand-in really rejects method-style calls', () => {
    expect(() => ({ f: strictFetch }).f('https://x/v2/me')).toThrow('Illegal invocation')
  })

  it('reaches Pi from PiServer (this.fetcher(...)) without an illegal invocation', async () => {
    vi.stubGlobal('fetch', strictFetch)
    const env = { DB: testDb(), PI_API_KEY: 'k' }
    const auth = await worker.fetch(
      new Request('https://app.test/api/auth', { method: 'POST', body: '{"accessToken":"t"}' }),
      env,
    )
    const { token } = (await auth.json()) as { token: string }
    const res = await worker.fetch(
      new Request('https://app.test/api/payments/approve', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ paymentId: 'p1' }),
      }),
      env,
    )
    // Pi answered (404, no such payment) instead of the call blowing up (500).
    expect(await res.json()).toEqual({ error: 'Pi has no such payment' })
    expect(res.status).toBe(404)
  })
})
