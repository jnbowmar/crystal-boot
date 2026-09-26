// The Pi SDK (loaded by a <script> tag in index.html). Only exists for real
// inside the Pi Browser, or the sandbox at sandbox.minepi.com.

interface PiAuthResult {
  accessToken: string
  user: { uid: string; username?: string }
}

interface PiSdk {
  init(config: { version: string; sandbox?: boolean }): void
  authenticate(scopes: string[], onIncompletePaymentFound: (payment: unknown) => void): Promise<PiAuthResult>
}

declare global {
  interface Window {
    Pi?: PiSdk
  }
}

/** True when the page is running inside the Pi Browser. */
export function inPiBrowser(): boolean {
  return /PiBrowser/i.test(navigator.userAgent)
}

let initialised = false

/**
 * Pi.authenticate, with a timeout: outside the Pi Browser (and the sandbox)
 * the SDK's promise never settles, so we give up and say so.
 */
export async function piSignIn(sandbox: boolean, timeoutMs = 20_000): Promise<string> {
  const Pi = window.Pi
  if (!Pi) throw new Error('The Pi SDK did not load. Open Crystal Boot in the Pi Browser.')
  if (!initialised) {
    Pi.init({ version: '2.0', sandbox })
    initialised = true
  }
  const auth = Pi.authenticate(['username'], () => {
    // No payments until M4, so there's nothing to complete yet.
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Pi sign-in timed out. Open Crystal Boot in the Pi Browser.')),
      timeoutMs,
    )
  })
  try {
    return (await Promise.race([auth, timeout])).accessToken
  } finally {
    clearTimeout(timer)
  }
}
