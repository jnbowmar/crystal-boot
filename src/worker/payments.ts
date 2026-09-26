// Pi payments (user to app), following Pi's three-phase flow:
//
//   1. The app asks us for an order (POST /api/leagues/order), then calls
//      Pi.createPayment with {orderId} in the metadata.
//   2. onReadyForServerApproval → POST /api/payments/approve. We read the
//      payment from Pi, check it against the order, bind the two and approve.
//   3. The user signs. onReadyForServerCompletion → POST /api/payments/complete.
//      We call Pi's /complete, and only once Pi's own record shows the payment
//      completed with a verified transaction do we deliver the item.
//
// The client is never trusted about money: every check reads Pi's record of
// the payment with our Server API Key. The SDK retries approve and complete,
// so both are idempotent.

import type { Db, Env } from './db'
import { HttpError } from './http'
import { createLeagueForOrder, type LeagueView } from './leagues'
import { PI_API } from './auth'
import type { Fetcher } from './settle'

export interface PaymentDTO {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: Record<string, unknown> | null
  direction?: string
  network?: string
  status: {
    developer_approved: boolean
    transaction_verified: boolean
    developer_completed: boolean
    cancelled: boolean
    user_cancelled: boolean
  }
  transaction: null | { txid: string; verified: boolean }
}

export interface OrderRow {
  id: string
  user_id: string
  kind: 'league'
  amount: number
  memo: string
  payload: string
  status: 'pending' | 'paying' | 'completed' | 'cancelled'
  payment_id: string | null
  txid: string | null
}

/** Pi Platform API calls made with the Server API Key. */
export class PiServer {
  private readonly fetcher: Fetcher
  private readonly base: string
  private readonly key: string

  constructor(env: Env, fetcher: Fetcher) {
    if (!env.PI_API_KEY) throw new HttpError(503, 'payments are not set up on this server')
    this.fetcher = fetcher
    this.base = env.PI_API || PI_API
    this.key = env.PI_API_KEY
  }

  private async call(method: string, path: string, body?: unknown): Promise<PaymentDTO> {
    const res = await this.fetcher(`${this.base}/v2${path}`, {
      method,
      headers: { authorization: `Key ${this.key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 404) throw new HttpError(404, 'Pi has no such payment')
    if (!res.ok) throw new HttpError(502, `Pi payments API returned ${res.status}`)
    return (await res.json()) as PaymentDTO
  }

  get(id: string) {
    return this.call('GET', `/payments/${encodeURIComponent(id)}`)
  }
  approve(id: string) {
    return this.call('POST', `/payments/${encodeURIComponent(id)}/approve`)
  }
  complete(id: string, txid: string) {
    return this.call('POST', `/payments/${encodeURIComponent(id)}/complete`, { txid })
  }
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** The Pi uid behind a user id. Test players can't pay. */
export function piUid(userId: string): string {
  if (!userId.startsWith('pi:')) throw new HttpError(403, 'sign in with Pi to pay')
  return userId.slice(3)
}

export async function createOrder(
  db: Db,
  userId: string,
  kind: OrderRow['kind'],
  payload: unknown,
  amount: number,
  memo: string,
  now: number,
): Promise<{ orderId: string; amount: number; memo: string; metadata: { orderId: string } }> {
  piUid(userId)
  const id = randomId()
  await db
    .prepare(
      `INSERT INTO orders (id, user_id, kind, amount, memo, payload, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    )
    .bind(id, userId, kind, amount, memo, JSON.stringify(payload), now)
    .run()
  return { orderId: id, amount, memo, metadata: { orderId: id } }
}

/** Why Pi's record of a payment doesn't match our order, or null if it does. */
export function mismatch(p: PaymentDTO, order: OrderRow, uid: string, network: string): string | null {
  if (p.user_uid !== uid) return 'payment belongs to another user'
  if (p.metadata?.orderId !== order.id) return 'payment is for a different order'
  if (Math.abs(p.amount - order.amount) > 1e-9) return 'payment amount does not match the order'
  if (p.direction !== undefined && p.direction !== 'user_to_app') return 'payment goes the wrong way'
  if (p.network !== undefined && p.network !== network) return `payment is on ${p.network}, expected ${network}`
  return null
}

async function orderById(db: Db, id: unknown, userId: string): Promise<OrderRow | null> {
  if (typeof id !== 'string') return null
  return db.prepare('SELECT * FROM orders WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<OrderRow>()
}

/** Phase 1: check the payment against its order, bind them, approve with Pi. */
export async function approvePayment(
  env: Env,
  fetcher: Fetcher,
  userId: string,
  paymentId: string,
  now: number,
): Promise<{ orderId: string; status: 'paying' }> {
  const uid = piUid(userId)
  const pi = new PiServer(env, fetcher)
  const p = await pi.get(paymentId)
  const order = await orderById(env.DB, p.metadata?.orderId, userId)
  if (!order) throw new HttpError(404, 'no such order')
  const bad = mismatch(p, order, uid, env.PI_NETWORK || 'Pi Testnet')
  if (bad) throw new HttpError(400, bad)
  if (p.status.cancelled || p.status.user_cancelled) throw new HttpError(409, 'payment was cancelled')
  if (order.payment_id !== null && order.payment_id !== paymentId) {
    throw new HttpError(409, 'this order already has a payment')
  }
  if (order.status === 'completed' || order.status === 'cancelled') {
    throw new HttpError(409, `order is ${order.status}`)
  }
  // Claim the order for this payment. The WHERE makes a concurrent claim by
  // another payment lose.
  const { meta } = await env.DB.prepare(
    `UPDATE orders SET status = 'paying', payment_id = ?2, updated_at = ?3
     WHERE id = ?1 AND (payment_id IS NULL OR payment_id = ?2) AND status IN ('pending', 'paying')`,
  )
    .bind(order.id, paymentId, now)
    .run()
  if (meta.changes === 0) throw new HttpError(409, 'this order already has a payment')
  if (!p.status.developer_approved) await pi.approve(paymentId)
  return { orderId: order.id, status: 'paying' }
}

export type CompleteResult =
  | { status: 'completed'; orderId: string; league: LeagueView }
  | { status: 'no-transaction'; orderId: string }

/**
 * Phase 3: complete with Pi, then deliver. `txid` is what the SDK reported;
 * null when resuming an incomplete payment, in which case Pi's record is
 * used. Delivery happens only when Pi says the payment is developer-completed
 * with a verified transaction whose txid matches.
 */
export async function completePayment(
  env: Env,
  fetcher: Fetcher,
  userId: string,
  paymentId: string,
  txid: string | null,
  now: number,
): Promise<CompleteResult> {
  const uid = piUid(userId)
  const pi = new PiServer(env, fetcher)
  let p = await pi.get(paymentId)
  const order =
    (await env.DB.prepare('SELECT * FROM orders WHERE payment_id = ?1 AND user_id = ?2')
      .bind(paymentId, userId)
      .first<OrderRow>()) ?? null
  if (!order) throw new HttpError(404, 'no order for this payment')
  const bad = mismatch(p, order, uid, env.PI_NETWORK || 'Pi Testnet')
  if (bad) throw new HttpError(400, bad)
  if (order.status === 'completed') {
    return { status: 'completed', orderId: order.id, league: await createLeagueForOrder(env.DB, order, order.txid!, now) }
  }
  if (!p.transaction) {
    if (txid !== null) throw new HttpError(409, 'Pi has no transaction for this payment yet')
    return { status: 'no-transaction', orderId: order.id }
  }
  if (txid !== null && p.transaction.txid !== txid) throw new HttpError(400, 'txid does not match the payment')
  const tx = p.transaction.txid
  if (!p.status.developer_completed) p = await pi.complete(paymentId, tx)
  if (!p.status.developer_completed || !p.status.transaction_verified || p.transaction?.txid !== tx) {
    throw new HttpError(409, 'Pi has not confirmed this payment yet')
  }
  // Paid. This also covers an order we'd marked cancelled: Pi's record wins.
  return { status: 'completed', orderId: order.id, league: await createLeagueForOrder(env.DB, order, tx, now) }
}

/** onCancel: the user backed out. Only honoured while there's no transaction. */
export async function cancelPayment(
  env: Env,
  fetcher: Fetcher,
  userId: string,
  paymentId: string,
  now: number,
): Promise<{ orderId: string | null; status: 'cancelled' }> {
  const uid = piUid(userId)
  const p = await new PiServer(env, fetcher).get(paymentId)
  if (p.user_uid !== uid) throw new HttpError(403, 'payment belongs to another user')
  const order =
    (await env.DB.prepare('SELECT * FROM orders WHERE payment_id = ?1 AND user_id = ?2')
      .bind(paymentId, userId)
      .first<OrderRow>()) ?? (await orderById(env.DB, p.metadata?.orderId, userId))
  if (!order) return { orderId: null, status: 'cancelled' }
  if (p.transaction) throw new HttpError(409, 'this payment has a transaction, so it will be completed instead')
  await env.DB.prepare(
    `UPDATE orders SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status IN ('pending', 'paying')`,
  )
    .bind(order.id, now)
    .run()
  return { orderId: order.id, status: 'cancelled' }
}
