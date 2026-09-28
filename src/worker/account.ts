// Deleting a player's account (the privacy page promises this).
//
// Picks, sessions and league memberships go. Payment records stay for the
// accounts, so a player who has paid keeps an anonymised users row (username
// replaced) for those orders and any league they started that others still
// play in. Everyone else's row is deleted outright. Signing in with Pi again
// later starts a fresh, empty account.

import type { Db } from './db'
import { HttpError } from './http'

export const DELETED_USERNAME = 'deleted'

export async function deleteAccount(db: Db, userId: string, now: number): Promise<void> {
  // A payment Pi has approved can still complete, which would create a league
  // for an account that no longer exists. Make the player finish it first.
  const paying = await db
    .prepare("SELECT 1 AS x FROM orders WHERE user_id = ?1 AND status = 'paying'")
    .bind(userId)
    .first()
  if (paying) throw new HttpError(409, 'finish or cancel your payment in progress first')

  await db.batch([
    db.prepare('DELETE FROM picks WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM league_members WHERE user_id = ?1').bind(userId),
    db
      .prepare("UPDATE orders SET status = 'cancelled', updated_at = ?2 WHERE user_id = ?1 AND status = 'pending'")
      .bind(userId, now),
    // Their leagues with nobody left in them go; ones friends still play in stay.
    db
      .prepare(
        `DELETE FROM leagues WHERE owner_id = ?1
         AND NOT EXISTS (SELECT 1 FROM league_members WHERE league_id = leagues.id)`,
      )
      .bind(userId),
    db.prepare('UPDATE users SET username = ?2, country = NULL WHERE id = ?1').bind(userId, DELETED_USERNAME),
    db
      .prepare(
        `DELETE FROM users WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM orders WHERE user_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM leagues WHERE owner_id = ?1)`,
      )
      .bind(userId),
  ])
}
