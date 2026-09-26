// HTTP API, under /api (the Worker serves the app's static files for
// everything else). Players sign in with Pi (auth.ts) and send
// Authorization: Bearer <session>. With FAKE_USERS=1, an X-Fake-User header
// works instead, for local dev and tests.

import { LEAGUES } from '../data/openfootball'
import {
  BASE_RATES,
  CONFIDENCE,
  MIN_PICKS,
  OUTCOMES,
  leaderboard,
  quickPick,
  validatePick,
  type Confidence,
  type League,
  type Outcome,
  type Probs,
  type ScoredPick,
} from '../scoring/scoring'
import { AuthError, sessionUser, startSession, verifyPiToken } from './auth'
import type { Env } from './db'
import { settle, sync, type Fetcher } from './settle'

const DAY = 24 * 60 * 60 * 1000

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function isLeague(s: string | null): s is League {
  return s !== null && Object.hasOwn(LEAGUES, s)
}

export const LEAGUE_IDS = Object.keys(LEAGUES) as League[]

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'body must be a JSON object')
}

const USERNAME = /^[A-Za-z0-9_]{3,20}$/

/**
 * The calling player, or null for an anonymous request. A session token that
 * is unknown or expired is a 401, so the app knows to sign in again.
 */
async function currentUser(req: Request, env: Env, now: number): Promise<string | null> {
  const auth = req.headers.get('authorization')
  if (auth !== null) {
    const token = /^Bearer (\S+)$/.exec(auth)?.[1]
    const user = token ? await sessionUser(env.DB, token, now) : null
    if (user === null) throw new HttpError(401, 'session expired, sign in again')
    return user
  }
  const name = req.headers.get('x-fake-user')
  if (name === null || env.FAKE_USERS !== '1') return null
  if (!USERNAME.test(name)) throw new HttpError(400, 'X-Fake-User must be 3-20 letters, digits or _')
  const id = `fake:${name}`
  await env.DB.prepare('INSERT INTO users (id, username, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
    .bind(id, name, now)
    .run()
  return id
}

async function requireUser(req: Request, env: Env, now: number): Promise<string> {
  const user = await currentUser(req, env, now)
  if (user === null) throw new HttpError(401, 'sign in required')
  return user
}

/** POST /api/auth {accessToken}: verify with Pi, start a session. */
async function postAuth(req: Request, env: Env, now: number, fetcher: Fetcher): Promise<Response> {
  const { accessToken } = await readJson(req)
  if (typeof accessToken !== 'string' || !accessToken) throw new HttpError(400, 'accessToken is required')
  const pi = await verifyPiToken(accessToken, fetcher, env.PI_API || undefined)
  const id = `pi:${pi.uid}`
  const session = await startSession(env.DB, { id, username: pi.username }, now)
  return json({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), user: { id, username: pi.username } })
}

/** GET /api/me: who the session belongs to. */
async function getMe(req: Request, env: Env, now: number): Promise<Response> {
  const id = await requireUser(req, env, now)
  const user = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?1').bind(id).first()
  return json({ user })
}

function requireAdmin(req: Request, env: Env): void {
  if (!env.ADMIN_TOKEN) throw new HttpError(404, 'not found')
  if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
    throw new HttpError(401, 'bad admin token')
  }
}

interface MatchRow {
  id: string
  league: League
  round: string | null
  home: string
  away: string
  date: string
  time: string | null
  kickoff_at: number
  status: 'scheduled' | 'settled' | 'void'
  home_goals: number | null
  away_goals: number | null
  result: Outcome | null
  crowd_h: number | null
  crowd_d: number | null
  crowd_a: number | null
  crowd_n: number | null
  h: number | null
  d: number | null
  a: number | null
  points: number | null
}

function matchView(m: MatchRow, now: number) {
  return {
    id: m.id,
    league: m.league,
    round: m.round,
    home: m.home,
    away: m.away,
    date: m.date,
    time: m.time,
    kickoffAt: new Date(m.kickoff_at).toISOString(),
    locked: now >= m.kickoff_at,
    status: m.status,
    score: m.home_goals === null || m.status !== 'settled' ? null : [m.home_goals, m.away_goals],
    result: m.result,
    crowd: m.crowd_n ? { H: m.crowd_h, D: m.crowd_d, A: m.crowd_a, n: m.crowd_n } : null,
    pick: m.h === null ? null : { H: m.h, D: m.d, A: m.a },
    points: m.points,
  }
}

const MATCH_COLUMNS = `m.id, m.league, m.round, m.home, m.away, m.date, m.time, m.kickoff_at,
  m.status, m.home_goals, m.away_goals, m.result, m.crowd_h, m.crowd_d, m.crowd_a, m.crowd_n,
  p.h, p.d, p.a, p.points`

const DATE = /^\d{4}-\d{2}-\d{2}$/

function dateParam(url: URL, name: string, fallback: string): string {
  const v = url.searchParams.get(name) ?? fallback
  if (!DATE.test(v)) throw new HttpError(400, `${name} must be YYYY-MM-DD`)
  return v
}

function isoDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

/** GET /api/matches?league=en.1&from=YYYY-MM-DD&to=YYYY-MM-DD (league-local dates). */
async function getMatches(req: Request, env: Env, url: URL, now: number): Promise<Response> {
  const league = url.searchParams.get('league')
  if (league !== null && !isLeague(league)) throw new HttpError(400, `unknown league ${league}`)
  const from = dateParam(url, 'from', isoDate(now - 3 * DAY))
  const to = dateParam(url, 'to', isoDate(now + 10 * DAY))
  const user = await currentUser(req, env, now)
  const { results } = await env.DB.prepare(
    `SELECT ${MATCH_COLUMNS}
     FROM matches m LEFT JOIN picks p ON p.match_id = m.id AND p.user_id = ?1
     WHERE m.date BETWEEN ?2 AND ?3 AND (?4 IS NULL OR m.league = ?4)
     ORDER BY m.kickoff_at, m.league, m.home`,
  )
    .bind(user, from, to, league)
    .all<MatchRow>()
  return json({ matches: results.map((m) => matchView(m, now)) })
}

/** GET /api/picks: the caller's picks, newest kickoff first. */
async function getPicks(req: Request, env: Env, now: number): Promise<Response> {
  const user = await requireUser(req, env, now)
  const { results } = await env.DB.prepare(
    `SELECT ${MATCH_COLUMNS}
     FROM picks p JOIN matches m ON m.id = p.match_id
     WHERE p.user_id = ?1 ORDER BY m.kickoff_at DESC`,
  )
    .bind(user)
    .all<MatchRow>()
  return json({ picks: results.map((m) => matchView(m, now)) })
}

/**
 * POST /api/picks with {matchId, pick: {H, D, A}} (whole percentages) or the
 * two-tap {matchId, outcome: 'H'|'D'|'A', confidence: 'lean'|...|'lock'}.
 * Replaces any earlier pick until kickoff. The server clock is the only clock.
 */
async function postPick(req: Request, env: Env, now: number): Promise<Response> {
  const user = await requireUser(req, env, now)
  const body = await readJson(req)
  const matchId = body.matchId
  if (typeof matchId !== 'string') throw new HttpError(400, 'matchId is required')
  const match = await env.DB.prepare('SELECT league, kickoff_at FROM matches WHERE id = ?1')
    .bind(matchId)
    .first<{ league: League; kickoff_at: number }>()
  if (!match) throw new HttpError(404, 'no such match')
  if (now >= match.kickoff_at) throw new HttpError(409, 'picks are locked for this match')

  let pick: Probs
  if (body.pick !== undefined) {
    const p = body.pick as Probs
    if (!p || typeof p !== 'object') throw new HttpError(400, 'pick must be {H, D, A}')
    pick = { H: p.H, D: p.D, A: p.A }
    try {
      validatePick(pick)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
  } else {
    const { outcome, confidence } = body
    if (!OUTCOMES.includes(outcome as Outcome)) throw new HttpError(400, 'outcome must be H, D or A')
    if (typeof confidence !== 'string' || !Object.hasOwn(CONFIDENCE, confidence)) {
      throw new HttpError(400, `confidence must be one of ${Object.keys(CONFIDENCE).join(', ')}`)
    }
    pick = quickPick(outcome as Outcome, confidence as Confidence, BASE_RATES[match.league])
  }

  // The kickoff check is repeated in the write so a pick can't slip in between
  // the read above and kickoff.
  const { meta } = await env.DB.prepare(
    `INSERT INTO picks (user_id, match_id, h, d, a, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 FROM matches WHERE id = ?2 AND kickoff_at > ?6
     ON CONFLICT (user_id, match_id) DO UPDATE SET
       h = excluded.h, d = excluded.d, a = excluded.a, updated_at = excluded.updated_at`,
  )
    .bind(user, matchId, pick.H, pick.D, pick.A, now)
    .run()
  if (meta.changes === 0) throw new HttpError(409, 'picks are locked for this match')
  return json({ matchId, pick })
}

/**
 * The Tuesday-to-Tuesday week (UTC) containing t, so a Monday night match
 * counts with its weekend and midweek rounds start a new week.
 */
export function weekOf(t: number): { start: number; end: number } {
  const midnight = Math.floor(t / DAY) * DAY
  const sinceTuesday = (new Date(midnight).getUTCDay() + 5) % 7
  const start = midnight - sinceTuesday * DAY
  return { start, end: start + 7 * DAY }
}

/**
 * GET /api/leaderboard?league=en.1|all&period=week|season&date=YYYY-MM-DD
 * Global scope only in M2; country and private leagues come later.
 */
async function getLeaderboard(req: Request, env: Env, url: URL, now: number): Promise<Response> {
  const league = url.searchParams.get('league') ?? 'all'
  if (league !== 'all' && !isLeague(league)) throw new HttpError(400, `unknown league ${league}`)
  const period = url.searchParams.get('period') ?? 'season'
  if (period !== 'week' && period !== 'season') throw new HttpError(400, 'period must be week or season')
  // Season: every settled match (the database only holds one season for now).
  let start = 0
  let end = Number.MAX_SAFE_INTEGER
  if (period === 'week') {
    const date = dateParam(url, 'date', isoDate(now))
    ;({ start, end } = weekOf(Date.parse(`${date}T12:00:00Z`)))
  }
  const { results } = await env.DB.prepare(
    `SELECT p.user_id AS userId, p.match_id AS matchId, p.points, u.username
     FROM picks p JOIN matches m ON m.id = p.match_id JOIN users u ON u.id = p.user_id
     WHERE m.status = 'settled' AND p.points IS NOT NULL
       AND (?1 = 'all' OR m.league = ?1) AND m.kickoff_at >= ?2 AND m.kickoff_at < ?3`,
  )
    .bind(league, start, end)
    .all<ScoredPick & { username: string }>()
  const names = new Map(results.map((r) => [r.userId, r.username]))
  const minPicks = MIN_PICKS[period]
  const standings = leaderboard(results, minPicks).map((s) => ({ ...s, username: names.get(s.userId) }))
  // The caller's own line, even before they have enough picks to be ranked.
  const user = await currentUser(req, env, now)
  let me = null
  if (user !== null) {
    const mine = results.filter((r) => r.userId === user)
    me = standings.find((s) => s.userId === user) ?? {
      rank: null,
      userId: user,
      picks: mine.length,
      avgPoints: mine.length ? mine.reduce((t, r) => t + r.points, 0) / mine.length : null,
    }
  }
  return json({
    league,
    period,
    ...(period === 'week' && { from: new Date(start).toISOString(), to: new Date(end).toISOString() }),
    minPicks,
    standings,
    me,
  })
}

/** POST /api/admin/score {matchId, home, away}: enter a result by hand, then settle. */
async function adminScore(req: Request, env: Env, now: number): Promise<Response> {
  const { matchId, home, away } = await readJson(req)
  if (typeof matchId !== 'string') throw new HttpError(400, 'matchId is required')
  for (const g of [home, away]) {
    if (!Number.isInteger(g) || (g as number) < 0) throw new HttpError(400, 'home and away must be goals (0+)')
  }
  const match = await env.DB.prepare('SELECT kickoff_at FROM matches WHERE id = ?1')
    .bind(matchId)
    .first<{ kickoff_at: number }>()
  if (!match) throw new HttpError(404, 'no such match')
  // An admin score outranks the feed for good, so don't allow one before kickoff.
  if (now < match.kickoff_at) throw new HttpError(409, 'match has not kicked off')
  await env.DB.prepare(
    `UPDATE matches SET home_goals = ?2, away_goals = ?3, score_source = 'admin', updated_at = ?4
     WHERE id = ?1`,
  )
    .bind(matchId, home, away, now)
    .run()
  return json(await settle(env.DB, now))
}

export async function handle(req: Request, env: Env, now: number, fetcher: Fetcher): Promise<Response> {
  const url = new URL(req.url)
  const route = `${req.method} ${url.pathname}`
  try {
    switch (route) {
      case 'GET /api/health':
        return json({ ok: true, now: new Date(now).toISOString() })
      case 'GET /api/config':
        return json({ piSandbox: env.PI_SANDBOX === '1', fakeUsers: env.FAKE_USERS === '1' })
      case 'POST /api/auth':
        return await postAuth(req, env, now, fetcher)
      case 'GET /api/me':
        return await getMe(req, env, now)
      case 'GET /api/matches':
        return await getMatches(req, env, url, now)
      case 'GET /api/picks':
        return await getPicks(req, env, now)
      case 'POST /api/picks':
        return await postPick(req, env, now)
      case 'GET /api/leaderboard':
        return await getLeaderboard(req, env, url, now)
      case 'POST /api/admin/sync':
        requireAdmin(req, env)
        return json(await sync(env.DB, now, fetcher, LEAGUE_IDS))
      case 'POST /api/admin/score':
        requireAdmin(req, env)
        return await adminScore(req, env, now)
    }
    return json({ error: 'not found' }, 404)
  } catch (e) {
    if (e instanceof HttpError || e instanceof AuthError) return json({ error: e.message }, e.status)
    console.error(route, e)
    return json({ error: 'internal error' }, 500)
  }
}
