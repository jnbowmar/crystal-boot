import { useEffect, useState } from 'react'
import type { League } from '../../src/scoring/scoring'
import type { Api, Leaderboard } from './api'
import { LEAGUE_NAME } from './Matches'

export function Table({
  api,
  onUnauthorized,
  scope = 'global',
}: {
  api: Api
  onUnauthorized: (e: unknown) => boolean
  scope?: string
}) {
  const [period, setPeriod] = useState<'week' | 'season'>('week')
  // Weeks with no matches (international breaks) have an empty table, so the
  // first load falls back to the season. Tapping a period switches this off.
  const [autoSeason, setAutoSeason] = useState(true)
  const [league, setLeague] = useState<League | 'all'>('all')
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setBoard(null)
    setError(null)
    api.leaderboard(period, league, scope).then(
      (b) => {
        if (!live) return
        if (autoSeason && period === 'week' && b.standings.length === 0 && !b.me?.picks) {
          setAutoSeason(false)
          setPeriod('season')
          return
        }
        setBoard(b)
      },
      (e) => {
        if (live && !onUnauthorized(e)) setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      live = false
    }
  }, [api, period, league, scope, onUnauthorized, autoSeason])

  const me = board?.me

  return (
    <section>
      <div className="segmented" role="group" aria-label="Period">
        <button
          aria-pressed={period === 'week'}
          onClick={() => {
            setAutoSeason(false)
            setPeriod('week')
          }}
        >
          This week
        </button>
        <button
          aria-pressed={period === 'season'}
          onClick={() => {
            setAutoSeason(false)
            setPeriod('season')
          }}
        >
          Season
        </button>
      </div>
      <div className="chips" role="group" aria-label="League">
        {(['all', 'en.1', 'es.1'] as const).map((l) => (
          <button key={l} className="chip" aria-pressed={league === l} onClick={() => setLeague(l)}>
            {l === 'all' ? 'All' : LEAGUE_NAME[l]}
          </button>
        ))}
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {!board && !error && <p className="muted center">Loading the table…</p>}

      {board && (
        <>
          {me && me.rank === null && (
            <p className="note">
              You have {me.picks} scored {me.picks === 1 ? 'pick' : 'picks'}
              {period === 'week' ? ' this week' : ''}. {board.minPicks} gets you on the table.
            </p>
          )}
          {board.standings.length === 0 ? (
            <p className="empty">
              Nobody has {board.minPicks} scored picks {period === 'week' ? 'this week' : 'this season'} yet.
            </p>
          ) : (
            <ol className="table">
              {board.standings.map((s) => (
                <li key={s.userId} className={s.userId === me?.userId ? 'me' : undefined}>
                  <span className="rank">{s.rank}</span>
                  <span className="name">{s.username}</span>
                  <span className="muted">{s.picks}</span>
                  <b>{s.avgPoints?.toFixed(1)}</b>
                </li>
              ))}
            </ol>
          )}
          <p className="fine">
            Ranked by average points per pick. You need at least {board.minPicks} scored picks to appear, so skipping
            the hard matches doesn't help.
          </p>
        </>
      )}
    </section>
  )
}
