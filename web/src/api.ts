// Typed client for the Worker's /api routes.

import type { Confidence, League, Outcome, Probs } from '../../src/scoring/scoring'

export interface Match {
  id: string
  league: League
  round: string | null
  home: string
  away: string
  date: string
  time: string | null
  kickoffAt: string
  locked: boolean
  status: 'scheduled' | 'settled' | 'void'
  score: [number, number] | null
  result: Outcome | null
  crowd: (Probs & { n: number }) | null
  pick: Probs | null
  points: number | null
}

export interface Standing {
  rank: number | null
  userId: string
  username?: string
  picks: number
  avgPoints: number | null
}

export interface Leaderboard {
  scope: string
  league: League | 'all'
  period: 'week' | 'season'
  from?: string
  to?: string
  minPicks: number
  standings: Standing[]
  me: Standing | null
}

export interface LeagueView {
  id: string
  name: string
  inviteCode: string
  ownerId: string
  members: number
  isOwner?: boolean
}

export interface Config {
  piSandbox: boolean
  fakeUsers: boolean
  leaguePrice: number
  payments: boolean
}

export interface Order {
  orderId: string
  amount: number
  memo: string
  metadata: { orderId: string }
}

export type PaymentResult =
  | { status: 'completed'; orderId: string; league: LeagueView }
  | { status: 'no-transaction'; orderId: string }

export interface User {
  id: string
  username: string
}

export type Auth = { kind: 'session'; token: string } | { kind: 'fake'; name: string } | null

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type PickBody = { pick: Probs } | { outcome: Outcome; confidence: Confidence }

export function createApi(getAuth: () => Auth, fetcher: typeof fetch = (...a) => fetch(...a)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = getAuth()
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth?.kind === 'session') headers.authorization = `Bearer ${auth.token}`
    if (auth?.kind === 'fake') headers['x-fake-user'] = auth.name
    const res = await fetcher(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      // not JSON (e.g. a proxy error page)
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`
      throw new ApiError(res.status, msg)
    }
    return data as T
  }

  return {
    config: () => call<Config>('GET', '/config'),
    auth: (accessToken: string) =>
      call<{ token: string; expiresAt: string; user: User }>('POST', '/auth', { accessToken }),
    me: () => call<{ user: User }>('GET', '/me'),
    matches: (from: string, to: string, league?: League) =>
      call<{ matches: Match[] }>(
        'GET',
        `/matches?${new URLSearchParams({ from, to, ...(league && { league }) })}`,
      ),
    picks: () => call<{ picks: Match[] }>('GET', '/picks'),
    savePick: (matchId: string, body: PickBody) =>
      call<{ matchId: string; pick: Probs }>('POST', '/picks', { matchId, ...body }),
    leaderboard: (period: 'week' | 'season', league: League | 'all', scope = 'global') =>
      call<Leaderboard>('GET', `/leaderboard?${new URLSearchParams({ period, league, scope })}`),
    leagues: () => call<{ leagues: LeagueView[] }>('GET', '/leagues'),
    leaguePreview: (code: string) =>
      call<{ name: string; members: number }>('GET', `/leagues/preview?${new URLSearchParams({ code })}`),
    orderLeague: (name: string) => call<Order>('POST', '/leagues/order', { name }),
    joinLeague: (code: string) => call<{ league: LeagueView }>('POST', '/leagues/join', { code }),
    leaveLeague: (leagueId: string) => call<{ ok: true }>('POST', '/leagues/leave', { leagueId }),
    approvePayment: (paymentId: string) => call<unknown>('POST', '/payments/approve', { paymentId }),
    completePayment: (paymentId: string, txid: string) =>
      call<PaymentResult>('POST', '/payments/complete', { paymentId, txid }),
    cancelPayment: (paymentId: string) => call<unknown>('POST', '/payments/cancel', { paymentId }),
    resumePayment: (paymentId: string) => call<PaymentResult>('POST', '/payments/incomplete', { paymentId }),
  }
}

export type Api = ReturnType<typeof createApi>
