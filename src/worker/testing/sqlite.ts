// A D1-shaped Db over node:sqlite, so tests run the Worker's real SQL against
// the real migrations without wrangler.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Db, Stmt } from '../db'

// Loaded this way because Vite's client environment (used by the jsdom app
// tests) doesn't know node:sqlite is a Node built-in and tries to bundle it.
const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'migrations')

class SqliteStmt implements Stmt {
  private readonly sqlite: DatabaseSync
  private readonly sql: string
  private readonly values: SQLInputValue[]

  constructor(sqlite: DatabaseSync, sql: string, values: SQLInputValue[] = []) {
    this.sqlite = sqlite
    this.sql = sql
    this.values = values
  }

  bind(...values: unknown[]): Stmt {
    return new SqliteStmt(this.sqlite, this.sql, values as SQLInputValue[])
  }

  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.sql).get(...this.values) as T | undefined) ?? null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.runSync().changes) } }
  }

  runSync() {
    return this.sqlite.prepare(this.sql).run(...this.values)
  }
}

export function testDb(): Db & { sqlite: DatabaseSync } {
  const sqlite = new Sqlite(':memory:')
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
  }
  return {
    sqlite,
    prepare: (sql) => new SqliteStmt(sqlite, sql),
    async batch(stmts) {
      sqlite.exec('BEGIN')
      try {
        const out = stmts.map((s) => ({ meta: { changes: Number((s as SqliteStmt).runSync().changes) } }))
        sqlite.exec('COMMIT')
        return out
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
  }
}
