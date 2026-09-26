// M4 proof, server side: the full approve → sign → complete loop for a paid
// league, cancel handled, and nothing delivered unless Pi confirms.

import { beforeEach, describe, expect, it } from 'vitest'
import { handle } from './api'
import type { Env } from './db'
import { API_KEY, FakePi } from './testing/fakePi'
import { testDb } from './testing/sqlite'

const NOW = Date.parse('2026-10-01T12:00:00Z')

let pi: FakePi
let env: Env & { DB: ReturnType<typeof testDb> }

beforeEach(() => {
  pi = new FakePi()
  pi.addUser('tok-james', 'u-james', 'james')
  pi.addUser('tok-ada', 'u-ada', 'ada')
  env = { DB: testDb(), PI_API_KEY: API_KEY, FAKE_USERS: '1' }
})

async function call(method: string, path: string, opts: { token?: string; fake?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.fake) headers['x-fake-user'] = opts.fake
  const res = await handle(
    new Request(`https://app.test${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env,
    NOW,
    pi.fetcher,
  )
  return { status: res.status, body: (await res.json()) as any }
}

async function signIn(piToken: string): Promise<string> {
  const { body } = await call('POST', '/api/auth', { body: { accessToken: piToken } })
  return body.token
}

/** The app's side: order, then Pi.createPayment with the order's data. */
async function startPayment(session: string, uid: string, name = 'Office League') {
  const order = await call('POST', '/api/leagues/order', { token: session, body: { name } })
  expect(order.status).toBe(200)
  const paymentId = pi.create(uid, order.body)
  return { order: order.body, paymentId }
}

const rows = (sql: string) => env.DB.sqlite.prepare(sql).all()

describe('paying for a league', () => {
  it('runs approve → sign → complete and delivers the league', async () => {
    const s = await signIn('tok-james')
    const { order, paymentId } = await startPayment(s, 'u-james')
    expect(order).toMatchObject({ amount: 0.5, memo: 'Crystal Boot league: Office League', metadata: { orderId: order.orderId } })

    const approved = await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    expect(approved).toEqual({ status: 200, body: { orderId: order.orderId, status: 'paying' } })
    expect(pi.payments.get(paymentId)!.status.developer_approved).toBe(true)

    const txid = pi.sign(paymentId)
    const done = await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({
      status: 'completed',
      league: { name: 'Office League', ownerId: 'pi:u-james', members: 1 },
    })
    expect(done.body.league.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(pi.payments.get(paymentId)!.status.developer_completed).toBe(true)
    expect(rows('SELECT status, payment_id, txid FROM orders')).toEqual([{ status: 'completed', payment_id: paymentId, txid }])

    const mine = await call('GET', '/api/leagues', { token: s })
    expect(mine.body.leagues).toEqual([{ ...done.body.league, isOwner: true }])
    expect(pi.calls).toEqual([
      'GET /v2/me',
      `GET /v2/payments/${paymentId}`,
      `POST /v2/payments/${paymentId}/approve`,
      `GET /v2/payments/${paymentId}`,
      `POST /v2/payments/${paymentId}/complete`,
    ])
  })

  it('is idempotent under SDK retries: one approval, one completion, one league', async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    expect((await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })).status).toBe(200)
    const txid = pi.sign(paymentId)
    const a = await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })
    const b = await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })
    expect(b.body.league).toEqual(a.body.league)
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 1 }])
    expect(pi.calls.filter((c) => c.endsWith('/approve'))).toHaveLength(1)
    expect(pi.calls.filter((c) => c.endsWith('/complete'))).toHaveLength(1)
  })

  it('delivers nothing while Pi /complete fails, then delivers on retry', async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    const txid = pi.sign(paymentId)
    pi.failComplete = 500
    expect((await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })).status).toBe(502)
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 0 }])
    expect(rows('SELECT status FROM orders')).toEqual([{ status: 'paying' }])
    pi.failComplete = null
    expect((await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })).body.status).toBe('completed')
  })

  it('waits for Pi to verify the transaction before delivering', async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    pi.verifyOnSign = false
    const txid = pi.sign(paymentId)
    const early = await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })
    expect(early).toEqual({ status: 409, body: { error: 'Pi has not confirmed this payment yet' } })
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 0 }])
    pi.verify(paymentId)
    expect((await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })).body.status).toBe('completed')
  })

  it('resumes an incomplete payment on the next sign-in', async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    // Approved, but the user hasn't signed yet: nothing to complete.
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    expect((await call('POST', '/api/payments/incomplete', { token: s, body: { paymentId } })).body).toMatchObject({
      status: 'no-transaction',
    })
    // Signed, then the app closed before completion. onIncompletePaymentFound
    // hands us the payment on the next sign-in.
    pi.sign(paymentId)
    const s2 = await signIn('tok-james')
    const resumed = await call('POST', '/api/payments/incomplete', { token: s2, body: { paymentId } })
    expect(resumed.body).toMatchObject({ status: 'completed', league: { name: 'Office League' } })
  })
})

describe('cancel', () => {
  it('cancels the order when the user backs out before signing', async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    pi.userCancel(paymentId)
    const res = await call('POST', '/api/payments/cancel', { token: s, body: { paymentId } })
    expect(res.body).toMatchObject({ status: 'cancelled' })
    expect(rows('SELECT status FROM orders')).toEqual([{ status: 'cancelled' }])
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 0 }])
    // A retry of the same payment can't revive it; a new order is needed.
    expect((await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })).status).toBe(409)
  })

  it('handles a cancel before approval (order not yet bound)', async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    pi.userCancel(paymentId)
    expect((await call('POST', '/api/payments/cancel', { token: s, body: { paymentId } })).body.status).toBe('cancelled')
    expect(rows('SELECT status FROM orders')).toEqual([{ status: 'cancelled' }])
  })

  it("won't cancel a payment that has a transaction, and still delivers it", async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    const txid = pi.sign(paymentId)
    expect((await call('POST', '/api/payments/cancel', { token: s, body: { paymentId } })).status).toBe(409)
    expect((await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })).body.status).toBe('completed')
  })

  it("delivers even if an order was marked cancelled, when Pi shows it was paid", async () => {
    const s = await signIn('tok-james')
    const { order, paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    const txid = pi.sign(paymentId)
    env.DB.sqlite.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.orderId)
    expect((await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid } })).body.status).toBe('completed')
  })
})

describe('never trusting the client', () => {
  it('rejects a payment for the wrong amount, without approving it', async () => {
    const s = await signIn('tok-james')
    const order = (await call('POST', '/api/leagues/order', { token: s, body: { name: 'Cheap League' } })).body
    const paymentId = pi.create('u-james', { ...order, amount: 0.01 })
    const res = await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    expect(res).toEqual({ status: 400, body: { error: 'payment amount does not match the order' } })
    expect(pi.payments.get(paymentId)!.status.developer_approved).toBe(false)
  })

  it("rejects someone else's order or payment", async () => {
    const james = await signIn('tok-james')
    const ada = await signIn('tok-ada')
    const { order, paymentId } = await startPayment(james, 'u-james')
    // Ada tries to approve James's payment.
    expect((await call('POST', '/api/payments/approve', { token: ada, body: { paymentId } })).status).toBe(404)
    // Ada pays against James's order id.
    const adaPayment = pi.create('u-ada', order)
    expect((await call('POST', '/api/payments/approve', { token: ada, body: { paymentId: adaPayment } })).status).toBe(404)
    // James approves a payment Ada made carrying his order id.
    expect((await call('POST', '/api/payments/approve', { token: james, body: { paymentId: adaPayment } })).body).toEqual({
      error: 'payment belongs to another user',
    })
    // Ada can't complete or cancel James's payment either.
    await call('POST', '/api/payments/approve', { token: james, body: { paymentId } })
    const txid = pi.sign(paymentId)
    expect((await call('POST', '/api/payments/complete', { token: ada, body: { paymentId, txid } })).status).toBe(404)
    expect((await call('POST', '/api/payments/cancel', { token: ada, body: { paymentId } })).status).toBe(403)
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 0 }])
  })

  it('rejects a completion with no transaction or the wrong txid', async () => {
    const s = await signIn('tok-james')
    const { paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    const lie = await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid: 'tx_made_up' } })
    expect(lie).toEqual({ status: 409, body: { error: 'Pi has no transaction for this payment yet' } })
    pi.sign(paymentId)
    const wrong = await call('POST', '/api/payments/complete', { token: s, body: { paymentId, txid: 'tx_other' } })
    expect(wrong).toEqual({ status: 400, body: { error: 'txid does not match the payment' } })
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 0 }])
    expect(pi.calls.filter((c) => c.endsWith('/complete'))).toHaveLength(0)
  })

  it('rejects a payment on the wrong network', async () => {
    const s = await signIn('tok-james')
    pi.network = 'Pi Network'
    const { paymentId } = await startPayment(s, 'u-james')
    expect((await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })).body).toEqual({
      error: 'payment is on Pi Network, expected Pi Testnet',
    })
    env.PI_NETWORK = 'Pi Network'
    expect((await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })).status).toBe(200)
  })

  it('lets one order take only one payment', async () => {
    const s = await signIn('tok-james')
    const { order, paymentId } = await startPayment(s, 'u-james')
    await call('POST', '/api/payments/approve', { token: s, body: { paymentId } })
    const second = pi.create('u-james', order)
    expect((await call('POST', '/api/payments/approve', { token: s, body: { paymentId: second } })).body).toEqual({
      error: 'this order already has a payment',
    })
  })

  it("doesn't let test players pay, or anyone pay when payments are off", async () => {
    expect((await call('POST', '/api/leagues/order', { fake: 'tester', body: { name: 'Test League' } })).body).toEqual({
      error: 'sign in with Pi to pay',
    })
    const s = await signIn('tok-james')
    env.PI_API_KEY = undefined
    expect((await call('POST', '/api/leagues/order', { token: s, body: { name: 'Test League' } })).status).toBe(503)
    expect((await call('POST', '/api/payments/approve', { token: s, body: { paymentId: 'pay_1' } })).status).toBe(503)
  })

  it('checks league names and uses the configured price', async () => {
    const s = await signIn('tok-james')
    expect((await call('POST', '/api/leagues/order', { token: s, body: { name: '  x ' } })).status).toBe(400)
    expect((await call('POST', '/api/leagues/order', { token: s, body: { name: 'y'.repeat(41) } })).status).toBe(400)
    env.LEAGUE_PRICE_PI = '0.25'
    const { body } = await call('POST', '/api/leagues/order', { token: s, body: { name: '  The   Five-a-side  ' } })
    expect(body).toMatchObject({ amount: 0.25, memo: 'Crystal Boot league: The Five-a-side' })
  })
})
