// A stateful stand-in for Pi's Platform API (/v2/me and /v2/payments) plus
// the user's side of a payment (create, sign, cancel), for tests. It keeps
// Pi's rules: approve before signing, complete only with the right txid.

import type { PaymentDTO } from '../payments'
import type { Fetcher } from '../settle'

export const API_KEY = 'test-server-key'

export class FakePi {
  users = new Map<string, { uid: string; username: string }>() // access token → user
  payments = new Map<string, PaymentDTO>()
  calls: string[] = []
  network = 'Pi Testnet'
  /** Status to return from /complete instead of doing it, to simulate an outage. */
  failComplete: number | null = null
  /** Whether a signed transaction shows as verified straight away. */
  verifyOnSign = true
  private seq = 0

  addUser(token: string, uid: string, username: string) {
    this.users.set(token, { uid, username })
  }

  /** What Pi.createPayment does on Pi's side: a new, unapproved payment. */
  create(uid: string, data: { amount: number; memo: string; metadata: Record<string, unknown> }): string {
    const id = `pay_${++this.seq}`
    this.payments.set(id, {
      identifier: id,
      user_uid: uid,
      amount: data.amount,
      memo: data.memo,
      metadata: data.metadata,
      direction: 'user_to_app',
      network: this.network,
      status: {
        developer_approved: false,
        transaction_verified: false,
        developer_completed: false,
        cancelled: false,
        user_cancelled: false,
      },
      transaction: null,
    })
    return id
  }

  /** The user signs in the wallet. Pi only allows it once the app approved. */
  sign(id: string): string {
    const p = this.payments.get(id)!
    if (!p.status.developer_approved) throw new Error('Pi: payment not approved by the developer')
    const txid = `tx_${id}`
    p.transaction = { txid, verified: this.verifyOnSign }
    p.status.transaction_verified = this.verifyOnSign
    return txid
  }

  verify(id: string) {
    const p = this.payments.get(id)!
    p.transaction!.verified = true
    p.status.transaction_verified = true
  }

  userCancel(id: string) {
    this.payments.get(id)!.status.user_cancelled = true
  }

  fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const auth = init?.headers?.authorization ?? ''
    this.calls.push(`${method} ${path}`)
    const reply = (status: number, body: unknown = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => structuredClone(body),
    })
    if (path === '/v2/me') {
      const user = this.users.get(auth.replace(/^Bearer /, ''))
      return user ? reply(200, user) : reply(401)
    }
    const m = /^\/v2\/payments\/([^/]+)(?:\/(approve|complete))?$/.exec(path)
    if (!m) return reply(404)
    if (auth !== `Key ${API_KEY}`) return reply(401)
    const p = this.payments.get(decodeURIComponent(m[1]))
    if (!p) return reply(404)
    if (m[2] === 'approve') {
      if (p.status.cancelled || p.status.user_cancelled) return reply(400, { error: 'cancelled' })
      p.status.developer_approved = true
    } else if (m[2] === 'complete') {
      if (this.failComplete) return reply(this.failComplete)
      const { txid } = JSON.parse(init?.body ?? '{}') as { txid?: string }
      if (!p.transaction || p.transaction.txid !== txid) return reply(400, { error: 'bad txid' })
      p.status.developer_completed = true
    }
    return reply(200, p)
  }
}
