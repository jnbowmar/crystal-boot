import { useEffect, useState } from 'react'
import type { League } from '../../src/scoring/scoring'
import type { Api, Leaderboard } from './api'
import { LEAGUE_NAME } from './Matches'

export function Table({ api, onUnauthorized }: { api: Api; onUnauthorized: (e: unknown) => boolean }) {
  const [period, setPeriod] = useState<'week' | 'season'>('week')
  const [league, setLeague] = useState<League | 'all'>('all')
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setBoard(null)
    setError(null)
    api.leaderboard(period, league).then(
      (b) => live && setBoard(b),
      (e) => {
        if (live && !onUnauthorized(e)) setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      live = false
    }
  }, [api, period, league, onUnauthorized])

  const me = board?.me

  return (
    <section>
      <div className="segmented" role="group" aria-label="Period">
        <button aria-pressed={period === 'week'} onClick={() => setPeriod('week')}>
          This week
        </button>
        <button aria-pressed={period === 'season'} onClick={() => setPeriod('season')}>
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
