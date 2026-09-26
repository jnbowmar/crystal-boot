import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeedMatch } from '../../data/openfootball'
import type { League } from '../../scoring/scoring'

/** Snapshots of the live 2026-27 feeds, pulled 2026-09-26 (CC0). */
export function feed(league: League): { name: string; matches: FeedMatch[] } {
  const path = join(import.meta.dirname, '..', '..', 'data', '__fixtures__', `2026-27-${league}.json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}
