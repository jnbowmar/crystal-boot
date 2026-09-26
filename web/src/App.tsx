import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError, createApi, type Auth, type Config, type User } from './api'
import { Leagues } from './Leagues'
import { Matches } from './Matches'
import { MyPicks } from './MyPicks'
import { inPiBrowser, piSignIn, takeIncompletePayment } from './pi'
import { Table } from './Table'

const SESSION_KEY = 'crystal-boot.session'
const FAKE_KEY = 'crystal-boot.fake-user'

// Storage can be missing or throw (private mode, blocked site data); the app
// still works, you just sign in again next time.
function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

type Tab = 'matches' | 'picks' | 'table' | 'leagues'

// An invite link opens the app at /?join=CODE.
function joinCodeFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('join')
  } catch {
    return null
  }
}
type State =
  | { phase: 'starting' }
  | { phase: 'signing-in' }
  | { phase: 'signed-out'; error: string | null }
  | { phase: 'signed-in'; user: User }

export function App({ signIn = piSignIn }: { signIn?: typeof piSignIn }) {
  const auth = useRef<Auth>(null)
  const api = useMemo(() => createApi(() => auth.current), [])
  const [config, setConfig] = useState<Config | null>(null)
  const [state, setState] = useState<State>({ phase: 'starting' })
  const [joinCode] = useState(joinCodeFromUrl)
  const [tab, setTab] = useState<Tab>(joinCode ? 'leagues' : 'matches')
  const [notice, setNotice] = useState<string | null>(null)

  const signInWithPi = useCallback(
    async (sandbox: boolean) => {
      setState({ phase: 'signing-in' })
      try {
        const accessToken = await signIn(sandbox)
        const { token, user } = await api.auth(accessToken)
        auth.current = { kind: 'session', token }
        store(SESSION_KEY, token)
        setState({ phase: 'signed-in', user })
        // Finish a payment the user signed last time but that never completed.
        const leftover = takeIncompletePayment()
        if (leftover) {
          api.resumePayment(leftover).then(
            (r) => r.status === 'completed' && setNotice(`Your league "${r.league.name}" is ready.`),
            () => {},
          )
        }
      } catch (e) {
        auth.current = null
        setState({ phase: 'signed-out', error: e instanceof Error ? e.message : String(e) })
      }
    },
    [api, signIn],
  )

  // Start-up: reuse a saved session if it's still good, otherwise sign in with Pi.
  useEffect(() => {
    let live = true
    ;(async () => {
      let cfg: Config = { piSandbox: false, fakeUsers: false, leaguePrice: 0, payments: false }
      try {
        cfg = await api.config()
      } catch {
        // Keep going with defaults; the next request will surface the error.
      }
      if (!live) return
      setConfig(cfg)
      const saved = load(SESSION_KEY)
      const fake = cfg.fakeUsers ? load(FAKE_KEY) : null
      if (saved || fake) {
        auth.current = saved ? { kind: 'session', token: saved } : { kind: 'fake', name: fake! }
        try {
          const { user } = await api.me()
          if (live) setState({ phase: 'signed-in', user })
          return
        } catch {
          auth.current = null
          store(SESSION_KEY, null)
        }
      }
      if (!live) return
      if (window.Pi && (inPiBrowser() || cfg.piSandbox)) await signInWithPi(cfg.piSandbox)
      else setState({ phase: 'signed-out', error: null })
    })()
    return () => {
      live = false
    }
  }, [api, signInWithPi])

  // Any 401 from a screen means the session is gone: back to sign-in.
  const onUnauthorized = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      auth.current = null
      store(SESSION_KEY, null)
      setState({ phase: 'signed-out', error: 'Your session ended. Sign in again.' })
      return true
    }
    return false
  }, [])

  function signOut() {
    if (!window.confirm(`Sign out @${state.phase === 'signed-in' ? state.user.username : ''}?`)) return
    auth.current = null
    store(SESSION_KEY, null)
    store(FAKE_KEY, null)
    setState({ phase: 'signed-out', error: null })
  }

  async function testSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim()
    auth.current = { kind: 'fake', name }
    try {
      const { user } = await api.me()
      store(FAKE_KEY, name)
      setState({ phase: 'signed-in', user })
    } catch (err) {
      auth.current = null
      setState({ phase: 'signed-out', error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (state.phase === 'starting' || state.phase === 'signing-in') {
    return (
      <main className="splash">
        <Logo />
        <p className="muted">{state.phase === 'signing-in' ? 'Signing in with Pi…' : 'Loading…'}</p>
      </main>
    )
  }

  if (state.phase === 'signed-out') {
    return (
      <main className="splash">
        <Logo />
        <p className="lede">Give your odds on every match. Get scored on how close you were. Climb the table.</p>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <button className="primary" onClick={() => signInWithPi(config?.piSandbox ?? false)}>
          Sign in with Pi
        </button>
        {!inPiBrowser() && !config?.piSandbox && (
          <p className="fine">Crystal Boot runs in the Pi Browser.</p>
        )}
        {config?.fakeUsers && (
          <form className="test-login" onSubmit={testSignIn}>
            <label>
              Test player (dev only)
              <input name="name" placeholder="e.g. james" pattern="[A-Za-z0-9_]{3,20}" required />
            </label>
            <button className="secondary">Play as test player</button>
          </form>
        )}
        <Disclaimer />
      </main>
    )
  }

  return (
    <div className="app">
      <header className="top">
        <Logo small />
        <button className="link muted" onClick={signOut} title="Sign out">
          @{state.user.username}
        </button>
      </header>
      <main className="content">
        {notice && (
          <p className="note" role="status">
            {notice}
          </p>
        )}
        {tab === 'matches' && <Matches api={api} onUnauthorized={onUnauthorized} />}
        {tab === 'picks' && <MyPicks api={api} onUnauthorized={onUnauthorized} />}
        {tab === 'table' && <Table api={api} onUnauthorized={onUnauthorized} />}
        {tab === 'leagues' && config && (
          <Leagues
            api={api}
            config={config}
            user={state.user}
            joinCode={joinCode}
            onUnauthorized={onUnauthorized}
            signIn={signIn}
          />
        )}
        <Disclaimer />
      </main>
      <nav className="tabs" aria-label="Sections">
        {(
          [
            ['matches', 'Matches'],
            ['picks', 'My picks'],
            ['table', 'Table'],
            ['leagues', 'Leagues'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}

function Logo({ small = false }: { small?: boolean }) {
  return (
    <h1 className={small ? 'logo small' : 'logo'}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M9 20l3-11h6l-1 6h5l1 5z" fill="currentColor" />
        <path d="M9 20h14v3H9z" fill="var(--ink)" />
      </svg>
      Crystal Boot
    </h1>
  )
}

function Disclaimer() {
  return <p className="disclaimer">Free to play. No wagering. Scores are for bragging rights.</p>
}
