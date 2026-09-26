// Pi sign-in. The app gets an access token from Pi.authenticate and sends it
// once to POST /api/auth. We check it against the Platform API's /v2/me (the
// only source of truth for who the user is) and hand back our own session
// token, so later requests don't need a round trip to Pi.

import type { Db } from './db'
import type { Fetcher } from './settle'

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000
export const PI_API = 'https://api.minepi.com'

export class AuthError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface PiUser {
  uid: string
  username: string
}

/** GET /v2/me with the user's access token. 401 from Pi means a bad token. */
export async function verifyPiToken(accessToken: string, fetcher: Fetcher, base = PI_API): Promise<PiUser> {
  const res = await fetcher(`${base}/v2/me`, { headers: { authorization: `Bearer ${accessToken}` } })
  if (res.status === 401) throw new AuthError(401, 'Pi rejected the access token')
  if (!res.ok) throw new AuthError(502, `Pi /v2/me returned ${res.status}`)
  const me = (await res.json()) as Partial<PiUser>
  if (typeof me?.uid !== 'string' || !me.uid) throw new AuthError(502, 'Pi /v2/me returned no uid')
  // The username scope can be declined; fall back to a stable placeholder.
  const username = typeof me.username === 'string' && me.username ? me.username : `pioneer-${me.uid.slice(0, 6)}`
  return { uid: me.uid, username }
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Upserts the user and issues a session. Returns the raw token (only its hash is stored). */
export async function startSession(
  db: Db,
  user: { id: string; username: string },
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const expiresAt = now + SESSION_MS
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, username, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username`,
      )
      .bind(user.id, user.username, now),
    db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(await sha256(token), user.id, now, expiresAt),
    // Housekeeping: drop this user's expired sessions.
    db.prepare('DELETE FROM sessions WHERE user_id = ?1 AND expires_at <= ?2').bind(user.id, now),
  ])
  return { token, expiresAt }
}

/** The user behind a session token, or null if it's unknown or expired. */
export async function sessionUser(db: Db, token: string, now: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2')
    .bind(await sha256(token), now)
    .first<{ user_id: string }>()
  return row?.user_id ?? null
}
