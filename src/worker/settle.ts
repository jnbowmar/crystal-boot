// The cron job: pull openfootball → upsert matches → settle finished ones →
// score picks. Everything is set-based SQL so a run costs a handful of D1
// queries however many matches and picks there are (D1 caps queries per
// invocation).

import { SEASON, feedUrl, parseFeed, type Fixture } from '../data/openfootball'
import type { League } from '../scoring/scoring'
import type { Db } from './db'

/** A match with no result this long after kickoff is voided (its picks don't count). */
export const VOID_AFTER_MS = 14 * 24 * 60 * 60 * 1000

/**
 * points() from scoring.ts, in SQL, for pick (h, d, a) and a match's result:
 * floor((20000 - Σ(p - 100·hit)² + 100) / 200). Every term is a non-negative
 * integer, so SQLite's integer division is the floor. A test checks it
 * against points() for every possible pick and result.
 */
export const POINTS_SQL = `(20100
  - (h - CASE r.result WHEN 'H' THEN 100 ELSE 0 END) * (h - CASE r.result WHEN 'H' THEN 100 ELSE 0 END)
  - (d - CASE r.result WHEN 'D' THEN 100 ELSE 0 END) * (d - CASE r.result WHEN 'D' THEN 100 ELSE 0 END)
  - (a - CASE r.result WHEN 'A' THEN 100 ELSE 0 END) * (a - CASE r.result WHEN 'A' THEN 100 ELSE 0 END)
) / 200`

const RESULT_SQL = `CASE WHEN home_goals > away_goals THEN 'H'
  WHEN home_goals = away_goals THEN 'D' ELSE 'A' END`

/**
 * Insert new fixtures and refresh existing ones, in one statement. Dates and
 * kickoff times follow the feed (reschedules, La Liga times arriving). Scores
 * follow the feed unless an admin entered one, and a score that disappears
 * from the feed is kept.
 */
export async function upsertFixtures(db: Db, fixtures: readonly Fixture[], now: number): Promise<void> {
  if (fixtures.length === 0) return
  const rows = fixtures.map((f) => ({
    id: f.id, league: f.league, season: f.season, round: f.round, home: f.home, away: f.away,
    date: f.date, time: f.time, kickoff_at: f.kickoffAt,
    hg: f.score?.[0] ?? null, ag: f.score?.[1] ?? null,
  }))
  await db
    .prepare(
      `INSERT INTO matches (id, league, season, round, home, away, date, time, kickoff_at,
         home_goals, away_goals, score_source, updated_at)
       SELECT j.value ->> 'id', j.value ->> 'league', j.value ->> 'season', j.value ->> 'round',
         j.value ->> 'home', j.value ->> 'away', j.value ->> 'date', j.value ->> 'time',
         j.value ->> 'kickoff_at', j.value ->> 'hg', j.value ->> 'ag',
         CASE WHEN j.value ->> 'hg' IS NULL THEN NULL ELSE 'feed' END, ?2
       FROM json_each(?1) AS j WHERE true
       ON CONFLICT (id) DO UPDATE SET
         round = excluded.round, date = excluded.date, time = excluded.time,
         kickoff_at = excluded.kickoff_at,
         home_goals = CASE WHEN matches.score_source = 'admin' OR excluded.home_goals IS NULL
           THEN matches.home_goals ELSE excluded.home_goals END,
         away_goals = CASE WHEN matches.score_source = 'admin' OR excluded.home_goals IS NULL
           THEN matches.away_goals ELSE excluded.away_goals END,
         score_source = CASE WHEN matches.score_source = 'admin' OR excluded.home_goals IS NULL
           THEN matches.score_source ELSE 'feed' END,
         updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(rows), now)
    .run()
}

/**
 * Settle every match that has a score and has kicked off, then score its
 * picks, in one transaction. Also re-settles a match whose score was
 * corrected to a different result, and brings back a voided match whose
 * score finally arrived. Returns how many matches settled and voided.
 */
export async function settle(db: Db, now: number): Promise<{ settled: number; voided: number }> {
  const [marked, , voided] = (await db.batch([
    // settled_at = now marks this run's matches for the picks update below.
    db
      .prepare(
        `UPDATE matches SET
           status = 'settled',
           result = ${RESULT_SQL},
           crowd_h = (SELECT avg(h) FROM picks WHERE match_id = matches.id),
           crowd_d = (SELECT avg(d) FROM picks WHERE match_id = matches.id),
           crowd_a = (SELECT avg(a) FROM picks WHERE match_id = matches.id),
           crowd_n = (SELECT count(*) FROM picks WHERE match_id = matches.id),
           settled_at = ?1
         WHERE home_goals IS NOT NULL AND away_goals IS NOT NULL AND kickoff_at <= ?1
           AND (status != 'settled' OR result IS NOT ${RESULT_SQL})`,
      )
      .bind(now),
    db
      .prepare(
        `UPDATE picks SET points = ${POINTS_SQL}
         FROM matches AS r
         WHERE r.id = picks.match_id AND r.status = 'settled' AND r.settled_at = ?1`,
      )
      .bind(now),
    db
      .prepare(
        `UPDATE matches SET status = 'void', settled_at = ?1
         WHERE status = 'scheduled' AND home_goals IS NULL AND kickoff_at < ?2`,
      )
      .bind(now, now - VOID_AFTER_MS),
  ])) as { meta: { changes: number } }[]
  return { settled: marked.meta.changes, voided: voided.meta.changes }
}

export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface SyncReport {
  leagues: Record<string, { fixtures: number; skipped: number } | { error: string }>
  settled: number
  voided: number
}

/**
 * One cron run. A league whose feed fails is reported and skipped; settlement
 * still runs for everything already in the database.
 */
export async function sync(
  db: Db,
  now: number,
  fetcher: Fetcher,
  leagues: readonly League[],
  season = SEASON,
): Promise<SyncReport> {
  const report: SyncReport = { leagues: {}, settled: 0, voided: 0 }
  for (const league of leagues) {
    try {
      const res = await fetcher(feedUrl(season, league))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { fixtures, skipped } = parseFeed(league, season, await res.json())
      await upsertFixtures(db, fixtures, now)
      report.leagues[league] = { fixtures: fixtures.length, skipped: skipped.length }
    } catch (e) {
      report.leagues[league] = { error: e instanceof Error ? e.message : String(e) }
    }
  }
  Object.assign(report, await settle(db, now))
  return report
}
