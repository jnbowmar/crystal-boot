import { useEffect, useState } from 'react'
import { beatCrowd } from '../../src/scoring/scoring'
import type { Api, Match } from './api'
import { MatchCard } from './Matches'

export function MyPicks({ api, onUnauthorized }: { api: Api; onUnauthorized: (e: unknown) => boolean }) {
  const [picks, setPicks] = useState<Match[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.picks().then(
      ({ picks }) => setPicks(picks),
      (e) => {
        if (!onUnauthorized(e)) setError(e instanceof Error ? e.message : String(e))
      },
    )
  }, [api, onUnauthorized])

  if (error) return <p className="error" role="alert">{error}</p>
  if (picks === null) return <p className="muted center">Loading your picks…</p>
  if (picks.length === 0) return <p className="empty">No picks yet. Head to Matches and make your first one.</p>

  const now = Date.now()
  const pending = picks.filter((m) => m.status === 'scheduled').reverse()
  const scored = picks.filter((m) => m.status === 'settled' && m.points !== null)
  const avg = scored.length ? scored.reduce((t, m) => t + m.points!, 0) / scored.length : null
  const vsCrowd = beatCrowd(
    scored.filter((m) => m.crowd && m.crowd.n > 1).map((m) => ({ pick: m.pick!, crowd: m.crowd!, actual: m.result! })),
  )

  return (
    <section>
      <div className="stats">
        <div>
          <b>{scored.length}</b>
          <span>scored</span>
        </div>
        <div>
          <b>{avg === null ? '–' : avg.toFixed(1)}</b>
          <span>avg points</span>
        </div>
        <div>
          <b>{vsCrowd.of ? `${vsCrowd.beat}/${vsCrowd.of}` : '–'}</b>
          <span>beat the crowd</span>
        </div>
      </div>
      {pending.length > 0 && (
        <div className="day">
          <h3>Waiting</h3>
          {pending.map((m) => (
            <MatchCard key={m.id} m={m} now={now} />
          ))}
        </div>
      )}
      {picks.some((m) => m.status !== 'scheduled') && (
        <div className="day">
          <h3>Scored</h3>
          {picks
            .filter((m) => m.status !== 'scheduled')
            .map((m) => (
              <MatchCard key={m.id} m={m} now={now} />
            ))}
        </div>
      )}
    </section>
  )
}
