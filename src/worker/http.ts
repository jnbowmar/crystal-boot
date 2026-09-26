// Shared request plumbing: errors, JSON responses and who is calling.

import { sessionUser } from './auth'
import type { Env } from './db'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
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
export async function currentUser(req: Request, env: Env, now: number): Promise<string | null> {
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

export async function requireUser(req: Request, env: Env, now: number): Promise<string> {
  const user = await currentUser(req, env, now)
  if (user === null) throw new HttpError(401, 'sign in required')
  return user
}
