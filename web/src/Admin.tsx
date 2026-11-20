// /admin: type in results the feed never sent. Not linked from the app; it
// needs the ADMIN_TOKEN, kept in this tab's sessionStorage only.

import { useCallback, useEffect, useState, type FormEvent } from 'react'

const TOKEN_KEY = 'crystal-boot.admin-token'

export interface PendingMatch {
  id: string
  league: string
  round: string | null
  home: string
  away: string
  date: string
  time: string | null
  kickoffAt: string
  status: 'scheduled' | 'void'
  picks: number
}

const LEAGUE_NAMES: Record<string, string> = { 'en.1': 'Premier League', 'es.1': 'La Liga' }

function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}
function saveToken(t: string | null) {
  try {
    if (t === null) sessionStorage.removeItem(TOKEN_KEY)
    else sessionStorage.setItem(TOKEN_KEY, t)
  } catch {
    // ignore
  }
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data as T
}

const GOALS = /^\d{1,2}$/

type Entry = { home: string; away: string }

export function Admin() {
  const [token, setToken] = useState(loadToken)
  const [draft, setDraft] = useState('')
  const [matches, setMatches] = useState<PendingMatch[] | null>(null)
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async (t: string) => {
    try {
      const { matches } = await call<{ matches: PendingMatch[] }>(t, 'GET', '/pending')
      setMatches(matches)
    } catch (e) {
      setMatches(null)
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
      if (e instanceof Error && /admin token/.test(e.message)) {
        saveToken(null)
        setToken('')
      }
    }
  }, [])

  useEffect(() => {
    if (token) void load(token)
  }, [token, load])

  const ready = Object.entries(entries).filter(([, e]) => GOALS.test(e.home) && GOALS.test(e.away))
  const half = Object.values(entries).some((e) => (e.home !== '' || e.away !== '') && !(GOALS.test(e.home) && GOALS.test(e.away)))

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const scores = ready.map(([matchId, e]) => ({ matchId, home: Number(e.home), away: Number(e.away) }))
      const r = await call<{ stored: number; settled: number }>(token, 'POST', '/scores', { scores })
      setMessage({ kind: 'ok', text: `Saved ${r.stored} result${r.stored === 1 ? '' : 's'}, ${r.settled} settled.` })
      setEntries({})
      await load(token)
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  function signIn(e: FormEvent) {
    e.preventDefault()
    const t = draft.trim()
    if (!t) return
    saveToken(t)
    setMessage(null)
    setToken(t)
    setDraft('')
  }

  if (!token) {
    return (
      <main className="app admin">
        <h1>Results admin</h1>
        <form onSubmit={signIn} className="card">
          <label className="field">
            Admin token
            <input type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <button className="primary" type="submit">Open</button>
        </form>
        {message && <p className="error">{message.text}</p>}
      </main>
    )
  }

  const byDay = new Map<string, PendingMatch[]>()
  for (const m of matches ?? []) {
    const key = `${m.date} · ${LEAGUE_NAMES[m.league] ?? m.league}`
    byDay.set(key, [...(byDay.get(key) ?? []), m])
  }

  return (
    <main className="app admin">
      <header className="admin-head">
        <h1>Results admin</h1>
        <button
          className="link"
          onClick={() => {
            saveToken(null)
            setToken('')
            setMatches(null)
          }}
        >
          Lock
        </button>
      </header>
      {message && <p className={message.kind === 'ok' ? 'note' : 'error'}>{message.text}</p>}
      {matches === null ? (
        <p className="muted">Loading…</p>
      ) : matches.length === 0 ? (
        <p className="empty">Every kicked-off match has a result.</p>
      ) : (
        <>
          <p className="muted">
            {matches.length} kicked-off match{matches.length === 1 ? '' : 'es'} without a result. Full-time scores only.
          </p>
          {[...byDay].map(([day, ms]) => (
            <section key={day} className="card">
              <h2 className="day">{day}</h2>
              {ms.map((m) => {
                const e = entries[m.id] ?? { home: '', away: '' }
                const set = (side: keyof Entry) => (ev: { target: { value: string } }) =>
                  setEntries((all) => ({ ...all, [m.id]: { ...e, [side]: ev.target.value.trim() } }))
                return (
                  <div key={m.id} className="admin-row">
                    <span className="admin-team">{m.home}</span>
                    <input aria-label={`${m.home} goals`} inputMode="numeric" value={e.home} onChange={set('home')} />
                    <span className="muted">–</span>
                    <input aria-label={`${m.away} goals`} inputMode="numeric" value={e.away} onChange={set('away')} />
                    <span className="admin-team">{m.away}</span>
                    <span className="small muted">
                      {m.time ?? 'time tbc'}
                      {m.status === 'void' && ' · void'}
                      {m.picks > 0 && ` · ${m.picks} pick${m.picks === 1 ? '' : 's'}`}
                    </span>
                  </div>
                )
              })}
            </section>
          ))}
          <div className="admin-save">
            <button className="primary" disabled={busy || ready.length === 0 || half} onClick={() => void save()}>
              {busy ? 'Saving…' : `Save ${ready.length} result${ready.length === 1 ? '' : 's'}`}
            </button>
            {half && <span className="small muted">Finish or clear the half-entered scores first.</span>}
          </div>
        </>
      )}
    </main>
  )
}
