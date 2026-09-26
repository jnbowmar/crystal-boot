// Private leagues. Creating one costs Pi (payments.ts); joining with the
// invite code is free. Everyone's picks are global, so a league table is just
// the main table filtered to its members.

import type { Db } from './db'
import { HttpError } from './http'
import type { OrderRow } from './payments'

export const MAX_MEMBERS = 500
export const DEFAULT_LEAGUE_PRICE_PI = 0.5

export interface LeagueView {
  id: string
  name: string
  inviteCode: string
  ownerId: string
  members: number
  isOwner?: boolean
}

// No 0/O or 1/I, so codes survive being read out or retyped. 32 symbols, so
// a byte masked to 5 bits picks one without bias.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE = /^[A-HJ-NP-Z2-9]{8}$/

export function inviteCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => CODE_ALPHABET[b & 31]).join('')
}

/** Trimmed, single-spaced, 3-40 characters. */
export function leagueName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  if (name.length < 3 || name.length > 40) throw new HttpError(400, 'league name must be 3-40 characters')
  return name
}

/** Normalises what people type: lower case, spaces and dashes are fine. */
export function normaliseCode(raw: unknown): string {
  const code = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : ''
  if (!CODE.test(code)) throw new HttpError(400, 'invite codes are 8 letters and digits')
  return code
}

const VIEW = `SELECT l.id, l.name, l.invite_code AS inviteCode, l.owner_id AS ownerId,
  (SELECT count(*) FROM league_members WHERE league_id = l.id) AS members FROM leagues l`

/**
 * Deliver a paid order: mark it completed and create its league with the
 * buyer as owner and first member, in one transaction. Idempotent: a second
 * call (SDK retry, incomplete-payment resume) returns the same league.
 */
export async function createLeagueForOrder(db: Db, order: OrderRow, txid: string, now: number): Promise<LeagueView> {
  const { name } = JSON.parse(order.payload) as { name: string }
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.prepare(`${VIEW} WHERE l.order_id = ?1`).bind(order.id).first<LeagueView>()
    if (existing) return { ...existing, isOwner: true } // the buyer owns it
    const id = crypto.randomUUID()
    // OR IGNORE: a concurrent delivery of the same order, or (astronomically
    // rarely) a taken invite code, skips the insert; the loop then finds the
    // league or tries a new code.
    await db.batch([
      db
        .prepare(`UPDATE orders SET status = 'completed', txid = ?2, updated_at = ?3 WHERE id = ?1`)
        .bind(order.id, txid, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO leagues (id, name, invite_code, owner_id, order_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(id, name, inviteCode(), order.user_id, order.id, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO league_members (league_id, user_id, joined_at)
           SELECT id, owner_id, ?2 FROM leagues WHERE order_id = ?1`,
        )
        .bind(order.id, now),
    ])
  }
  throw new Error(`could not create a league for order ${order.id}`)
}

export async function myLeagues(db: Db, userId: string): Promise<LeagueView[]> {
  const { results } = await db
    .prepare(`${VIEW} JOIN league_members m ON m.league_id = l.id AND m.user_id = ?1 ORDER BY m.joined_at`)
    .bind(userId)
    .all<LeagueView>()
  return results.map((l) => ({ ...l, isOwner: l.ownerId === userId }))
}

export async function leagueByCode(db: Db, rawCode: unknown): Promise<LeagueView> {
  const league = await db.prepare(`${VIEW} WHERE l.invite_code = ?1`).bind(normaliseCode(rawCode)).first<LeagueView>()
  if (!league) throw new HttpError(404, 'no league has that invite code')
  return league
}

export async function joinLeague(db: Db, userId: string, rawCode: unknown, now: number): Promise<LeagueView> {
  const league = await leagueByCode(db, rawCode)
  // The member cap is checked inside the insert so two joins can't both take the last place.
  await db
    .prepare(
      `INSERT OR IGNORE INTO league_members (league_id, user_id, joined_at)
       SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM league_members WHERE league_id = ?1) < ?4`,
    )
    .bind(league.id, userId, now, MAX_MEMBERS)
    .run()
  const joined = await db
    .prepare('SELECT 1 AS ok FROM league_members WHERE league_id = ?1 AND user_id = ?2')
    .bind(league.id, userId)
    .first()
  if (!joined) throw new HttpError(409, `this league is full (${MAX_MEMBERS} players)`)
  return (await myLeagues(db, userId)).find((l) => l.id === league.id)!
}

export async function leaveLeague(db: Db, userId: string, leagueId: unknown): Promise<void> {
  if (typeof leagueId !== 'string') throw new HttpError(400, 'leagueId is required')
  const league = await db.prepare('SELECT owner_id FROM leagues WHERE id = ?1').bind(leagueId).first<{ owner_id: string }>()
  if (!league) throw new HttpError(404, 'no such league')
  if (league.owner_id === userId) throw new HttpError(400, "the league's creator can't leave it")
  await db.prepare('DELETE FROM league_members WHERE league_id = ?1 AND user_id = ?2').bind(leagueId, userId).run()
}

/** Throws unless the user is in the league. */
export async function requireMember(db: Db, userId: string | null, leagueId: string): Promise<void> {
  if (userId === null) throw new HttpError(401, 'sign in required')
  const row = await db
    .prepare('SELECT 1 AS ok FROM league_members WHERE league_id = ?1 AND user_id = ?2')
    .bind(leagueId, userId)
    .first()
  if (!row) throw new HttpError(403, "you're not in this league")
}
