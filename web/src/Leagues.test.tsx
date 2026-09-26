// @vitest-environment jsdom
//
// M4 proof, app side: create a league by paying through the Pi SDK's
// approve → sign → complete loop, cancel handled, join by invite link, and an
// unfinished payment picked up at the next sign-in. The Worker, SQL and
// payment checks are real; Pi (SDK and Platform API) is FakePi.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handle } from '../../src/worker/api'
import type { Env } from '../../src/worker/db'
import { API_KEY, FakePi } from '../../src/worker/testing/fakePi'
import { testDb } from '../../src/worker/testing/sqlite'
import { App } from './App'
import type { PiSdk } from './pi'

let pi: FakePi
let env: Env & { DB: ReturnType<typeof testDb> }

/**
 * The Pi SDK's payment flow, driven by FakePi: ask for approval, wait until
 * our server approved it with Pi, then the user signs (or cancels).
 */
function fakeSdk(uid: string, user: 'signs' | 'cancels' = 'signs', token = 'tok-james'): PiSdk {
  return {
    init: () => {},
    authenticate: async () => ({ accessToken: token, user: { uid } }),
    createPayment: (data, cb) => {
      const id = pi.create(uid, data)
      cb.onReadyForServerApproval(id)
      const wait = setInterval(() => {
        if (!pi.payments.get(id)!.status.developer_approved) return
        clearInterval(wait)
        if (user === 'cancels') {
          pi.userCancel(id)
          cb.onCancel(id)
        } else {
          cb.onReadyForServerCompletion(id, pi.sign(id))
        }
      }, 5)
    },
  }
}

const rows = (sql: string) => env.DB.sqlite.prepare(sql).all()

beforeEach(() => {
  pi = new FakePi()
  pi.addUser('tok-james', 'u-james', 'james')
  pi.addUser('tok-ada', 'u-ada', 'ada')
  env = { DB: testDb(), PI_SANDBOX: '1', PI_API_KEY: API_KEY }
  localStorage.clear()
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
    handle(new Request(`https://app.test${input}`, init), env, Date.now(), pi.fetcher),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.Pi
  window.history.replaceState(null, '', '/')
})

async function openLeagues(token = 'tok-james') {
  render(<App signIn={async () => token} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Leagues' }))
  await screen.findByText(/Join with a code, or start your own/)
}

describe('starting a league', () => {
  it('pays 0.5 testnet Pi through approve → sign → complete, then opens the league', async () => {
    window.Pi = fakeSdk('u-james')
    await openLeagues()
    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Lagos Office Five' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pay 0.5 Pi (testnet)' }))

    expect(await screen.findByRole('heading', { name: 'Lagos Office Five' })).toBeTruthy()
    const [{ invite_code }] = rows('SELECT invite_code FROM leagues') as { invite_code: string }[]
    expect(screen.getByText(`${invite_code.slice(0, 4)}-${invite_code.slice(4)}`)).toBeTruthy()
    expect(rows('SELECT status, amount FROM orders')).toEqual([{ status: 'completed', amount: 0.5 }])
    const [payment] = pi.payments.values()
    expect(payment.status).toMatchObject({ developer_approved: true, developer_completed: true })
    expect(payment.memo).toBe('Crystal Boot league: Lagos Office Five')

    fireEvent.click(screen.getByRole('button', { name: '← Leagues' }))
    expect(await screen.findByText('Lagos Office Five')).toBeTruthy()
    expect(screen.getByText('Yours')).toBeTruthy()
  })

  it('handles the user cancelling in the Pi wallet', async () => {
    window.Pi = fakeSdk('u-james', 'cancels')
    await openLeagues()
    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Never Paid' } })
    fireEvent.click(screen.getByRole('button', { name: /^Pay / }))
    expect((await screen.findByRole('alert')).textContent).toBe("Payment cancelled. You weren't charged.")
    await waitFor(() => expect(rows('SELECT status FROM orders')).toEqual([{ status: 'cancelled' }]))
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 0 }])
    // The form is usable again.
    expect(screen.getByRole('button', { name: /^Pay / }).hasAttribute('disabled')).toBe(false)
  })

  it("won't let a test player pay", async () => {
    env.FAKE_USERS = '1'
    render(<App />)
    fireEvent.change(await screen.findByLabelText(/Test player/), { target: { value: 'tester' } })
    fireEvent.submit(screen.getByLabelText(/Test player/).closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Leagues' }))
    expect(await screen.findByText('Sign in with Pi to start a league.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Pay / }).hasAttribute('disabled')).toBe(true)
  })
})

describe('joining', () => {
  it('opens an invite link, previews the league and joins for free', async () => {
    // James's league exists already.
    window.Pi = fakeSdk('u-james')
    await openLeagues()
    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Sunday Five' } })
    fireEvent.click(screen.getByRole('button', { name: /^Pay / }))
    await screen.findByRole('heading', { name: 'Sunday Five' })
    const [{ invite_code }] = rows('SELECT invite_code FROM leagues') as { invite_code: string }[]
    cleanup()
    localStorage.clear()

    // Ada follows the link.
    window.history.replaceState(null, '', `/?join=${invite_code.toLowerCase()}`)
    const before = pi.payments.size
    render(<App signIn={async () => 'tok-ada'} />)
    expect(await screen.findByText('Sunday Five')).toBeTruthy()
    expect(screen.getByText(/1 player/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Join for free' }))
    expect(await screen.findByRole('heading', { name: 'Sunday Five' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave this league' })).toBeTruthy()
    expect(rows('SELECT user_id FROM league_members ORDER BY joined_at')).toHaveLength(2)
    expect(pi.payments.size).toBe(before)
  })
})

describe('an unfinished payment', () => {
  it('is completed and delivered at the next sign-in', async () => {
    // Last time: ordered, approved and signed, then the app closed.
    const session = await (
      await handle(
        new Request('https://app.test/api/auth', { method: 'POST', body: '{"accessToken":"tok-james"}' }),
        env,
        Date.now(),
        pi.fetcher,
      )
    ).json()
    const post = (path: string, body: unknown) =>
      handle(
        new Request(`https://app.test/api${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${session.token}` },
          body: JSON.stringify(body),
        }),
        env,
        Date.now(),
        pi.fetcher,
      ).then((r) => r.json())
    const order = await post('/leagues/order', { name: 'Came Back Later' })
    const paymentId = pi.create('u-james', order)
    await post('/payments/approve', { paymentId })
    pi.sign(paymentId)
    expect(rows('SELECT count(*) AS n FROM leagues')).toEqual([{ n: 0 }])

    // This time: Pi reports it during authenticate.
    window.Pi = {
      ...fakeSdk('u-james'),
      authenticate: async (_scopes, onIncomplete) => {
        onIncomplete({ identifier: paymentId, transaction: { txid: `tx_${paymentId}` } })
        return { accessToken: 'tok-james', user: { uid: 'u-james' } }
      },
    }
    render(<App />)
    expect((await screen.findByRole('status')).textContent).toBe('Your league "Came Back Later" is ready.')
    expect(rows('SELECT name FROM leagues')).toEqual([{ name: 'Came Back Later' }])
  })
})
