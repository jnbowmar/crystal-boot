// @vitest-environment jsdom
//
// The whole pick flow: the React app talks to the real Worker code and SQL
// (on node:sqlite), with Pi's SDK and /v2/me stubbed.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_RATES, points, quickPick } from '../../src/scoring/scoring'
import { LEAGUE_IDS, handle } from '../../src/worker/api'
import type { Env } from '../../src/worker/db'
import { sync, type Fetcher } from '../../src/worker/settle'
import { feed } from '../../src/worker/testing/feeds'
import { testDb } from '../../src/worker/testing/sqlite'
import { App } from './App'
import { rebalance } from './pick'

const FRIDAY = Date.parse('2026-09-18T09:00:00Z')
const TUESDAY = Date.parse('2026-09-22T18:00:00Z')
const MATCH = 'en.1|2026-27|AFC Bournemouth|Liverpool FC'

function feedAsOf(asOf: string) {
  return (league: 'en.1' | 'es.1') => {
    const f = feed(league)
    return { ...f, matches: f.matches.map((m) => (m.date < asOf ? m : { ...m, score: undefined })) }
  }
}

function feedFetcher(get: (l: 'en.1' | 'es.1') => unknown): Fetcher {
  return async (url) => {
    const league = LEAGUE_IDS.find((l) => url.endsWith(`/${l}.json`))!
    return { ok: true, status: 200, json: async () => get(league) }
  }
}

const piMe: Fetcher = async (_url, init) =>
  init?.headers?.authorization === 'Bearer pi-token-james'
    ? { ok: true, status: 200, json: async () => ({ uid: 'u-james', username: 'james' }) }
    : { ok: false, status: 401, json: async () => ({}) }

let env: Env & { DB: ReturnType<typeof testDb> }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FRIDAY)
  localStorage.clear()
  env = { DB: testDb(), PI_SANDBOX: '1' }
  await sync(env.DB, FRIDAY, feedFetcher(feedAsOf('2026-09-18')), LEAGUE_IDS)
  // The app's fetch goes straight into the Worker's handler.
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
    handle(new Request(`https://app.test${input}`, init), env, Date.now(), piMe),
  )
  window.Pi = {
    init: () => {},
    authenticate: async () => ({ accessToken: 'unused', user: { uid: 'x' } }),
    createPayment: () => {},
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete window.Pi
})

async function signedIn() {
  render(<App signIn={async () => 'pi-token-james'} />)
  await screen.findByRole('button', { name: '@james' })
}

describe('the app', () => {
  it('signs in with Pi and lists the weekend fixtures', async () => {
    await signedIn()
    await screen.findByText(/September 18/)
    // The 20 matches of 18-20 September, plus La Liga's Friday 9 October
    // opener, the only other match inside the three-week window.
    expect(screen.getAllByRole('button', { name: /Make your pick/ })).toHaveLength(21)
    expect(screen.getByText(/October 9/)).toBeTruthy()
    expect(screen.getByText('Free to play. No wagering. Scores are for bragging rights.')).toBeTruthy()
    // The session is kept, so a reload doesn't need Pi again.
    expect(localStorage.getItem('crystal-boot.session')).toBeTruthy()
  })

  it('makes a two-tap pick, then scores it after the match', async () => {
    await signedIn()
    const card = (await screen.findByText('Bournemouth')).closest('button')!
    fireEvent.click(card)
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('button', { name: 'Save pick' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Liverpool win' }))
    fireEvent.click(within(sheet).getByRole('button', { name: /Confident/ }))
    const expected = quickPick('A', 'confident', BASE_RATES['en.1'])
    // "Points if it happens" preview matches scoring.ts.
    const row = within(sheet).getByRole('row', { name: /Liverpool win/ })
    expect(row.textContent).toBe(`Liverpool win${expected.A}%${points(expected, 'A')}`)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Save pick' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByLabelText(`Your pick: home ${expected.H}%, draw ${expected.D}%, away ${expected.A}%`)).toBeTruthy()
    expect(env.DB.sqlite.prepare('SELECT h, d, a FROM picks WHERE match_id = ?').get(MATCH)).toEqual({
      h: expected.H,
      d: expected.D,
      a: expected.A,
    })

    // Results come in (Bournemouth 0-1 Liverpool); My picks shows the points.
    vi.setSystemTime(TUESDAY)
    await sync(env.DB, TUESDAY, feedFetcher(feed), LEAGUE_IDS)
    fireEvent.click(screen.getByRole('button', { name: 'My picks' }))
    expect(await screen.findByText(`${points(expected, 'A')} pts`)).toBeTruthy()
    expect(screen.getByText('0–1')).toBeTruthy()
  })

  it('makes an exact pick with the sliders', async () => {
    await signedIn()
    fireEvent.click((await screen.findByText('Bournemouth')).closest('button')!)
    const sheet = screen.getByRole('dialog')
    fireEvent.click(within(sheet).getByRole('tab', { name: 'Exact %' }))
    fireEvent.change(within(sheet).getByLabelText('Liverpool win percent'), { target: { value: '60' } })
    fireEvent.change(within(sheet).getByLabelText('Draw percent'), { target: { value: '25' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save pick' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const p = rebalance(rebalance({ H: 34, D: 33, A: 33 }, 'A', 60), 'D', 25)
    expect(env.DB.sqlite.prepare('SELECT h, d, a FROM picks').get()).toEqual({ h: p.H, d: p.D, a: p.A })
  })

  it('shows the lock error if kickoff passes while the sheet is open', async () => {
    await signedIn()
    fireEvent.click((await screen.findByText('Bournemouth')).closest('button')!)
    const sheet = screen.getByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Draw' }))
    fireEvent.click(within(sheet).getByRole('button', { name: /Lean/ }))
    vi.setSystemTime(Date.parse('2026-09-20T13:00:00Z'))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save pick' }))
    expect((await within(sheet).findByRole('alert')).textContent).toBe('picks are locked for this match')
  })

  it('goes back to sign-in when the session is gone', async () => {
    await signedIn()
    await screen.findByText(/September 18/)
    env.DB.sqlite.exec('DELETE FROM sessions')
    fireEvent.click(screen.getByRole('button', { name: 'Table' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Your session ended. Sign in again.')
    expect(screen.getByRole('button', { name: 'Sign in with Pi' })).toBeTruthy()
    expect(localStorage.getItem('crystal-boot.session')).toBeNull()
  })

  it('shows why Pi sign-in failed', async () => {
    render(<App signIn={async () => 'forged-token'} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Pi rejected the access token')
  })

  it('offers test players when FAKE_USERS is on, and not otherwise', async () => {
    delete window.Pi
    env.FAKE_USERS = '1'
    const { unmount } = render(<App />)
    const input = await screen.findByLabelText(/Test player/)
    fireEvent.change(input, { target: { value: 'ada' } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    await screen.findByRole('button', { name: '@ada' })
    unmount()
    localStorage.clear()

    env.FAKE_USERS = undefined
    render(<App />)
    await screen.findByRole('button', { name: 'Sign in with Pi' })
    expect(screen.queryByLabelText(/Test player/)).toBeNull()
  })
})
