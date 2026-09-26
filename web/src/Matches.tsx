import { useCallback, useEffect, useState } from 'react'
import type { League } from '../../src/scoring/scoring'
import type { Api, Match, PickBody } from './api'
import { PickSheet } from './PickSheet'
import { kickoffLabel, localDay, lockLabel, shortName } from './pick'

const DAY = 24 * 3600_000
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

export const LEAGUE_NAME: Record<League, string> = { 'en.1': 'Premier League', 'es.1': 'La Liga' }

function dayHeading(key: string): string {
  const d = new Date(`${key}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(d)
}

export function PickChip({ m }: { m: Match }) {
  if (!m.pick) return null
  return (
    <span className="pick-chip" aria-label={`Your pick: home ${m.pick.H}%, draw ${m.pick.D}%, away ${m.pick.A}%`}>
      H {m.pick.H} · D {m.pick.D} · A {m.pick.A}
    </span>
  )
}

export function MatchCard({ m, now, onOpen }: { m: Match; now: number; onOpen?: () => void }) {
  const lock = lockLabel(m.kickoffAt, now)
  const body = (
    <>
      <div className="teams">
        <span title={m.home}>{shortName(m.home)}</span>
        {m.score ? (
          <b className="score">
            {m.score[0]}–{m.score[1]}
          </b>
        ) : (
          <span className="vs">v</span>
        )}
        <span title={m.away}>{shortName(m.away)}</span>
      </div>
      <div className="meta">
        <span className="muted">
          {LEAGUE_NAME[m.league]} · {kickoffLabel(m.kickoffAt, m.time !== null)}
        </span>
        {m.status === 'scheduled' && lock && <span className={m.locked ? 'tag' : 'tag warn'}>{lock}</span>}
        {m.status === 'void' && <span className="tag">Void</span>}
      </div>
      <div className="meta">
        {m.pick ? <PickChip m={m} /> : !m.locked && <span className="cta">Make your pick</span>}
        {m.points !== null && <span className="points">{m.points} pts</span>}
      </div>
    </>
  )
  return onOpen ? (
    <button className="card match" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="card match">{body}</div>
  )
}

export function Matches({ api, onUnauthorized }: { api: Api; onUnauthorized: (e: unknown) => boolean }) {
  const [league, setLeague] = useState<League | 'all'>('all')
  const [matches, setMatches] = useState<Match[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Match | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    setError(null)
    const t = Date.now()
    try {
      const { matches } = await api.matches(iso(t - 3 * DAY), iso(t + 21 * DAY), league === 'all' ? undefined : league)
      setMatches(matches)
      setNow(Date.now())
    } catch (e) {
      if (!onUnauthorized(e)) setError(e instanceof Error ? e.message : String(e))
    }
  }, [api, league, onUnauthorized])

  useEffect(() => {
    void load()
  }, [load])

  // Keep lock countdowns honest while the screen is open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  async function save(m: Match, body: PickBody) {
    let pick
    try {
      ;({ pick } = await api.savePick(m.id, body))
    } catch (e) {
      onUnauthorized(e)
      throw e
    }
    setMatches((ms) => ms?.map((x) => (x.id === m.id ? { ...x, pick } : x)) ?? null)
    setOpen(null)
  }

  const openForPicks = matches?.filter((m) => m.status === 'scheduled' && Date.parse(m.kickoffAt) > now) ?? []
  const inPlay = matches?.filter((m) => m.status === 'scheduled' && Date.parse(m.kickoffAt) <= now) ?? []
  const results = matches?.filter((m) => m.status !== 'scheduled').reverse() ?? []
  const byDay = new Map<string, Match[]>()
  for (const m of openForPicks) {
    const k = localDay(m.kickoffAt)
    byDay.set(k, [...(byDay.get(k) ?? []), m])
  }

  return (
    <section>
      <div className="chips" role="group" aria-label="League">
        {(['all', 'en.1', 'es.1'] as const).map((l) => (
          <button key={l} className="chip" aria-pressed={league === l} onClick={() => setLeague(l)}>
            {l === 'all' ? 'All' : LEAGUE_NAME[l]}
          </button>
        ))}
      </div>

      {error && (
        <p className="error" role="alert">
          {error} <button className="link" onClick={load}>Retry</button>
        </p>
      )}
      {matches === null && !error && <p className="muted center">Loading fixtures…</p>}

      {matches !== null && openForPicks.length === 0 && (
        <p className="empty">No matches open for picks in the next three weeks.</p>
      )}
      {[...byDay].map(([day, ms]) => (
        <div key={day} className="day">
          <h3>{dayHeading(day)}</h3>
          {ms.map((m) => (
            <MatchCard key={m.id} m={m} now={now} onOpen={() => setOpen(m)} />
          ))}
        </div>
      ))}

      {inPlay.length > 0 && (
        <div className="day">
          <h3>Locked, waiting for results</h3>
          {inPlay.map((m) => (
            <MatchCard key={m.id} m={m} now={now} />
          ))}
        </div>
      )}

      {results.length > 0 && (
        <div className="day">
          <h3>Recent results</h3>
          {results.map((m) => (
            <MatchCard key={m.id} m={m} now={now} />
          ))}
        </div>
      )}

      {open && <PickSheet match={open} onSave={(body) => save(open, body)} onClose={() => setOpen(null)} />}
    </section>
  )
}
