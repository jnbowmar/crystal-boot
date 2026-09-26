// HTTP API. M2 has no real auth: with FAKE_USERS=1 the X-Fake-User header
// names the player. M3 swaps that for a Pi access token checked against /v2/me.

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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-fake-user',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
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

/** The calling player, created on first sight. Null when the request has no identity. */
async function currentUser(req: Request, env: Env, now: number): Promise<string | null> {
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

/** GET /matches?league=en.1&from=YYYY-MM-DD&to=YYYY-MM-DD (league-local dates). */
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

/** GET /picks: the caller's picks, newest kickoff first. */
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
 * POST /picks with {matchId, pick: {H, D, A}} (whole percentages) or the
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
 * GET /leaderboard?league=en.1|all&period=week|season&date=YYYY-MM-DD
 * Global scope only in M2; country and private leagues come later.
 */
async function getLeaderboard(env: Env, url: URL, now: number): Promise<Response> {
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
  return json({
    league,
    period,
    ...(period === 'week' && { from: new Date(start).toISOString(), to: new Date(end).toISOString() }),
    minPicks,
    standings,
  })
}

/** POST /admin/score {matchId, home, away}: enter a result by hand, then settle. */
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
      case 'GET /health':
        return json({ ok: true, now: new Date(now).toISOString() })
      case 'GET /matches':
        return await getMatches(req, env, url, now)
      case 'GET /picks':
        return await getPicks(req, env, now)
      case 'POST /picks':
        return await postPick(req, env, now)
      case 'GET /leaderboard':
        return await getLeaderboard(env, url, now)
      case 'POST /admin/sync':
        requireAdmin(req, env)
        return json(await sync(env.DB, now, fetcher, LEAGUE_IDS))
      case 'POST /admin/score':
        requireAdmin(req, env)
        return await adminScore(req, env, now)
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    return json({ error: 'not found' }, 404)
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status)
    console.error(route, e)
    return json({ error: 'internal error' }, 500)
  }
}

