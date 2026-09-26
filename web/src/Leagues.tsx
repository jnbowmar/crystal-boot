import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ApiError, type Api, type Config, type LeagueView, type User } from './api'
import { PaymentCancelled, payWithPi, piSignIn, takeIncompletePayment } from './pi'
import { Table } from './Table'

type Unauthorized = (e: unknown) => boolean

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function formatCode(code: string) {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

interface Props {
  api: Api
  config: Config
  user: User
  joinCode?: string | null
  onUnauthorized: Unauthorized
  signIn?: typeof piSignIn
}

export function Leagues({ api, config, user, joinCode, onUnauthorized, signIn = piSignIn }: Props) {
  const [leagues, setLeagues] = useState<LeagueView[] | null>(null)
  const [open, setOpen] = useState<LeagueView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { leagues } = await api.leagues()
      setLeagues(leagues)
      return leagues
    } catch (e) {
      if (!onUnauthorized(e)) setError(message(e))
      return null
    }
  }, [api, onUnauthorized])

  useEffect(() => {
    void load()
  }, [load])

  function added(league: LeagueView) {
    setLeagues((ls) => [...(ls ?? []).filter((l) => l.id !== league.id), league])
    setOpen(league)
  }

  if (open) {
    return (
      <LeagueDetail
        api={api}
        league={open}
        onBack={() => setOpen(null)}
        onLeft={() => {
          setOpen(null)
          void load()
        }}
        onUnauthorized={onUnauthorized}
      />
    )
  }

  return (
    <section>
      {error && <p className="error" role="alert">{error}</p>}
      {leagues === null && !error && <p className="muted center">Loading your leagues…</p>}
      {leagues !== null && leagues.length === 0 && (
        <p className="empty">Play against your friends, office or group chat. Join with a code, or start your own.</p>
      )}
      {leagues?.map((l) => (
        <button key={l.id} className="card league" onClick={() => setOpen(l)}>
          <span className="league-name">{l.name}</span>
          <span className="meta">
            <span className="muted">
              {l.members} {l.members === 1 ? 'player' : 'players'}
            </span>
            {l.isOwner && <span className="tag">Yours</span>}
          </span>
        </button>
      ))}

      <JoinForm api={api} initialCode={joinCode ?? ''} onJoined={added} onUnauthorized={onUnauthorized} />
      <CreateForm api={api} config={config} user={user} signIn={signIn} onCreated={added} onUnauthorized={onUnauthorized} />
    </section>
  )
}

function JoinForm({
  api,
  initialCode,
  onJoined,
  onUnauthorized,
}: {
  api: Api
  initialCode: string
  onJoined: (l: LeagueView) => void
  onUnauthorized: Unauthorized
}) {
  const [code, setCode] = useState(initialCode)
  const [preview, setPreview] = useState<{ name: string; members: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Look the code up as soon as it's complete, so people see what they're joining.
  useEffect(() => {
    setPreview(null)
    setError(null)
    const clean = code.toUpperCase().replace(/[\s-]/g, '')
    if (clean.length !== 8) return
    let live = true
    api.leaguePreview(clean).then(
      (p) => live && setPreview(p),
      (e) => live && setError(message(e)),
    )
    return () => {
      live = false
    }
  }, [api, code])

  async function join(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const { league } = await api.joinLeague(code)
      setCode('')
      onJoined(league)
    } catch (err) {
      if (!onUnauthorized(err)) setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel" onSubmit={join}>
      <h2>Join a league</h2>
      <label className="field">
        Invite code
        <input
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD-EFGH"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={11}
        />
      </label>
      {preview && (
        <p className="note">
          <b>{preview.name}</b> · {preview.members} {preview.members === 1 ? 'player' : 'players'}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="secondary" disabled={!preview || busy}>
        {busy ? 'Joining…' : 'Join for free'}
      </button>
    </form>
  )
}

type PayState =
  | { step: 'idle' }
  | { step: 'paying'; note: string | null }
  | { step: 'failed'; error: string }

function CreateForm({
  api,
  config,
  user,
  signIn,
  onCreated,
  onUnauthorized,
}: {
  api: Api
  config: Config
  user: User
  signIn: typeof piSignIn
  onCreated: (l: LeagueView) => void
  onUnauthorized: Unauthorized
}) {
  const [name, setName] = useState('')
  const [state, setState] = useState<PayState>({ step: 'idle' })
  const price = `${config.leaguePrice} Pi${config.piSandbox ? ' (testnet)' : ''}`
  const canPay = config.payments && user.id.startsWith('pi:')

  async function create(e: FormEvent) {
    e.preventDefault()
    setState({ step: 'paying', note: null })
    try {
      // Pi needs authenticate (with the payments scope) in this page load
      // before createPayment. It also reports any payment left unfinished.
      await signIn(config.piSandbox)
      const leftover = takeIncompletePayment()
      if (leftover) {
        const r = await api.resumePayment(leftover)
        if (r.status === 'completed') onCreated(r.league)
      }
      const order = await api.orderLeague(name)
      const result = await payWithPi(
        order,
        {
          approve: api.approvePayment,
          complete: api.completePayment,
          cancel: api.cancelPayment,
        },
        (note) => setState({ step: 'paying', note: `${note}. Retrying…` }),
      )
      if (result.status !== 'completed') throw new Error('Payment did not complete')
      setName('')
      setState({ step: 'idle' })
      onCreated(result.league)
    } catch (err) {
      if (err instanceof ApiError && onUnauthorized(err)) return
      setState({ step: 'failed', error: err instanceof PaymentCancelled ? err.message : message(err) })
    }
  }

  return (
    <form className="panel" onSubmit={create}>
      <h2>Start a league</h2>
      <p className="muted small">
        Creating a league costs {price}, paid once. Joining is always free. It's for bragging rights only: no Pi is
        ever paid out on results.
      </p>
      <label className="field">
        League name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Lagos Office Five"
          maxLength={40}
          disabled={!canPay}
        />
      </label>
      {state.step === 'paying' && (
        <p className="note" role="status">
          Confirm the payment in Pi… {state.note}
        </p>
      )}
      {state.step === 'failed' && <p className="error" role="alert">{state.error}</p>}
      <button className="primary" disabled={!canPay || name.trim().length < 3 || state.step === 'paying'}>
        {state.step === 'paying' ? 'Waiting for Pi…' : `Pay ${price}`}
      </button>
      {!config.payments && <p className="fine">Payments aren't switched on for this server yet.</p>}
      {config.payments && !user.id.startsWith('pi:') && <p className="fine">Sign in with Pi to start a league.</p>}
    </form>
  )
}

function LeagueDetail({
  api,
  league,
  onBack,
  onLeft,
  onUnauthorized,
}: {
  api: Api
  league: LeagueView
  onBack: () => void
  onLeft: () => void
  onUnauthorized: Unauthorized
}) {
  const [shared, setShared] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const code = formatCode(league.inviteCode)

  async function share() {
    const text = `Join my Crystal Boot league "${league.name}" with invite code ${code}. Free to play.`
    try {
      if (window.Pi?.openShareDialog) {
        window.Pi.openShareDialog('Join my Crystal Boot league', text)
        return
      }
      await navigator.clipboard.writeText(text)
      setShared('Invite copied')
    } catch {
      setShared(`Share this code: ${code}`)
    }
  }

  async function leave() {
    if (!window.confirm(`Leave ${league.name}?`)) return
    try {
      await api.leaveLeague(league.id)
      onLeft()
    } catch (e) {
      if (!onUnauthorized(e)) setError(message(e))
    }
  }

  return (
    <section>
      <button className="link muted back" onClick={onBack}>
        ← Leagues
      </button>
      <h2 className="league-title">{league.name}</h2>
      <div className="invite">
        <div>
          <span className="muted small">Invite code</span>
          <b className="code">{code}</b>
        </div>
        <button className="secondary slim" onClick={share}>
          Share
        </button>
      </div>
      {shared && <p className="fine" role="status">{shared}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <Table api={api} scope={`league:${league.id}`} onUnauthorized={onUnauthorized} />
      {!league.isOwner && (
        <button className="link muted leave" onClick={leave}>
          Leave this league
        </button>
      )}
    </section>
  )
}
