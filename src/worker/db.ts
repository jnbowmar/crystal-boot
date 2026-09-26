// The slice of Cloudflare D1 the Worker uses. D1Database satisfies it as is;
// tests run the same code on node:sqlite through testing/sqlite.ts.

export interface Stmt {
  bind(...values: unknown[]): Stmt
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}

export interface Db {
  prepare(sql: string): Stmt
  /** Runs the statements in one transaction. */
  batch(stmts: Stmt[]): Promise<unknown[]>
}

export interface Env {
  DB: Db
  /** "1" lets the X-Fake-User header stand in for Pi auth (M2 only). */
  FAKE_USERS?: string
  /** Bearer token for /admin routes. Unset means /admin is off. */
  ADMIN_TOKEN?: string
}
