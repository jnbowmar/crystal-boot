// openfootball/football.json → match rows. Pure functions, no I/O.
//
// The feed has no IDs, no timezones and two score shapes, so this is where
// all of that gets pinned down (see SPEC.md "M0 results").

import type { League } from '../scoring/scoring'
import { zonedToUtc } from './time'

export interface LeagueConfig {
  name: string
  // Kickoff times in the feed are local to the league, with no zone field.
  tz: string
}

export const LEAGUES: Record<League, LeagueConfig> = {
  'en.1': { name: 'Premier League', tz: 'Europe/London' },
  'es.1': { name: 'La Liga', tz: 'Europe/Madrid' },
}

export const SEASON = '2026-27'

export function feedUrl(season: string, league: League): string {
  return `https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${league}.json`
}

/** One match as the feed has it. Only the fields we read. */
export interface FeedMatch {
  round?: string
  date: string
  time?: string | null
  team1: string
  team2: string
  score?: { ft?: [number, number] } | [number, number] | null
}

export interface Fixture {
  id: string
  league: League
  season: string
  round: string | null
  home: string
  away: string
  date: string // league-local YYYY-MM-DD
  time: string | null // league-local HH:MM, null until announced
  kickoffAt: number // pick lock, ms since epoch
  score: [number, number] | null // full time
}

/**
 * Match ID = league|season|home|away. Each ordered pair meets once per league
 * season, so this stays the same when a match is rescheduled. (A date in the
 * ID would orphan every pick on a postponed match.)
 */
export function matchId(league: League, season: string, home: string, away: string): string {
  return `${league}|${season}|${home}|${away}`
}

/**
 * Full-time score, or null for a match not yet played. Usually
 * {ft: [h, a], ht: [...]}, but some matches are a bare [h, a] (in 2026-27
 * those are all 0-0s with no half-time score).
 */
export function fullTime(m: Pick<FeedMatch, 'score'>): [number, number] | null {
  const s = m.score
  const ft = Array.isArray(s) ? s : s?.ft
  if (!Array.isArray(ft) || ft.length !== 2) return null
  const [h, a] = ft
  if (!isGoals(h) || !isGoals(a)) return null
  return [h, a]
}

function isGoals(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 0
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Parse a league feed. Rows that don't look like a match are skipped and
 * reported rather than failing the whole sync.
 */
export function parseFeed(
  league: League,
  season: string,
  json: unknown,
): { fixtures: Fixture[]; skipped: string[] } {
  const matches = (json as { matches?: unknown })?.matches
  if (!Array.isArray(matches)) throw new Error(`${league} ${season}: feed has no matches array`)
  const { tz } = LEAGUES[league]
  const fixtures: Fixture[] = []
  const skipped: string[] = []
  for (const raw of matches as FeedMatch[]) {
    const { date, team1, team2 } = raw ?? {}
    const time = raw?.time ?? null
    if (
      typeof date !== 'string' || !DATE.test(date) ||
      typeof team1 !== 'string' || !team1 ||
      typeof team2 !== 'string' || !team2 ||
      (time !== null && (typeof time !== 'string' || !TIME.test(time)))
    ) {
      skipped.push(JSON.stringify(raw))
      continue
    }
    fixtures.push({
      id: matchId(league, season, team1, team2),
      league,
      season,
      round: typeof raw.round === 'string' ? raw.round : null,
      home: team1,
      away: team2,
      date,
      time,
      // No time yet (most La Liga matches until a few weeks out): lock at the
      // start of the match day, league-local. A later sync with the real time
      // moves the lock to kickoff.
      kickoffAt: zonedToUtc(date, time ?? '00:00', tz),
      score: fullTime(raw),
    })
  }
  return { fixtures, skipped }
}
