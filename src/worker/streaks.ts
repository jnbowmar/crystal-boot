// Banker picks and streaks: the weekly hooks.

import { streak, streakTarget, weekKey, type WeekTally } from '../scoring/scoring'
import type { Db } from './db'
import { HttpError } from './http'

/** SQL twin of weekKey() for a kickoff_at column (see scoring.ts). */
export const WEEK_SQL = (col: string) => `(${col} / 86400000 - (${col} / 86400000 + 2) % 7)`

/**
 * Each player's current streak. With userId, just that player's (the map may
 * then have no entry, meaning 0).
 */
export async function streaks(db: Db, now: number, userId: string | null = null): Promise<Map<string, number>> {
  const [perWeek, picks] = await Promise.all([
    db
      .prepare(`SELECT ${WEEK_SQL('kickoff_at')} AS week, count(*) AS n FROM matches WHERE status != 'void' GROUP BY week`)
      .all<{ week: number; n: number }>(),
    db
      .prepare(
        `SELECT p.user_id AS userId, ${WEEK_SQL('m.kickoff_at')} AS week, count(*) AS n
         FROM picks p JOIN matches m ON m.id = p.match_id
         WHERE m.status != 'void' AND (?1 IS NULL OR p.user_id = ?1)
         GROUP BY p.user_id, week`,
      )
      .bind(userId)
      .all<{ userId: string; week: number; n: number }>(),
  ])
  const matches = new Map(perWeek.results.map((r) => [r.week, r.n]))
  const byUser = new Map<string, WeekTally[]>()
  for (const r of picks.results) {
    const tallies = byUser.get(r.userId) ?? []
    tallies.push({ week: r.week, matches: matches.get(r.week) ?? 0, picks: r.n })
    byUser.set(r.userId, tallies)
  }
  const current = weekKey(now)
  return new Map([...byUser].map(([u, tallies]) => [u, streak(tallies, current)]))
}

/** GET /api/streak: the caller's streak and this week's progress toward it. */
export async function streakStatus(db: Db, userId: string, now: number) {
  const week = weekKey(now)
  const row = await db
    .prepare(
      `SELECT count(*) AS matches,
         count(p.match_id) AS picks
       FROM matches m LEFT JOIN picks p ON p.match_id = m.id AND p.user_id = ?1
       WHERE m.status != 'void' AND ${WEEK_SQL('m.kickoff_at')} = ?2`,
    )
    .bind(userId, week)
    .first<{ matches: number; picks: number }>()
  const matches = row?.matches ?? 0
  return {
    streak: (await streaks(db, now, userId)).get(userId) ?? 0,
    week: { matches, picks: row?.picks ?? 0, target: streakTarget(matches) },
  }
}

/**
 * POST /api/banker {matchId, on}: make a pick the player's banker for its
 * week, moving it off any other match that hasn't kicked off, or (on: false)
 * take it off. Everything is locked once the banked match kicks off.
 */
export async function setBanker(db: Db, userId: string, matchId: string, on: boolean, now: number): Promise<void> {
  const target = await db
    .prepare(
      `SELECT m.kickoff_at, p.banker_week FROM picks p JOIN matches m ON m.id = p.match_id
       WHERE p.user_id = ?1 AND p.match_id = ?2`,
    )
    .bind(userId, matchId)
    .first<{ kickoff_at: number; banker_week: number | null }>()
  if (!target) throw new HttpError(404, 'make a pick on this match first')
  if (now >= target.kickoff_at) throw new HttpError(409, 'this match has kicked off')
  const week = weekKey(target.kickoff_at)

  if (!on) {
    await db
      .prepare('UPDATE picks SET banker_week = NULL WHERE user_id = ?1 AND match_id = ?2')
      .bind(userId, matchId)
      .run()
    return
  }
  if (target.banker_week !== null) return // already the banker

  const current = await db
    .prepare(
      `SELECT m.kickoff_at FROM picks p JOIN matches m ON m.id = p.match_id
       WHERE p.user_id = ?1 AND p.banker_week = ?2`,
    )
    .bind(userId, week)
    .first<{ kickoff_at: number }>()
  if (current && now >= current.kickoff_at) throw new HttpError(409, "this week's banker has already kicked off")

  // Both writes check kickoff again, so nothing moves if either match kicks off
  // in between; the unique index stops a second banker in the same week.
  try {
    const [, set] = (await db.batch([
      db
        .prepare(
          `UPDATE picks SET banker_week = NULL
           WHERE user_id = ?1 AND banker_week = ?2
             AND (SELECT kickoff_at FROM matches WHERE id = picks.match_id) > ?4
             AND (SELECT kickoff_at FROM matches WHERE id = ?3) > ?4`,
        )
        .bind(userId, week, matchId, now),
      db
        .prepare(
          `UPDATE picks SET banker_week = ?2
           WHERE user_id = ?1 AND match_id = ?3 AND (SELECT kickoff_at FROM matches WHERE id = ?3) > ?4`,
        )
        .bind(userId, week, matchId, now),
    ])) as { meta: { changes: number } }[]
    if (set.meta.changes === 0) throw new HttpError(409, 'this match has kicked off')
  } catch (e) {
    if (e instanceof HttpError) throw e
    if (String(e).includes('UNIQUE')) throw new HttpError(409, "this week's banker has already kicked off")
    throw e
  }
}
