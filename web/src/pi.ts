// The Pi SDK (loaded by a <script> tag in index.html). Only exists for real
// inside the Pi Browser, or the sandbox at sandbox.minepi.com.

interface PiAuthResult {
  accessToken: string
  user: { uid: string; username?: string }
}

export interface PiPaymentDTO {
  identifier: string
  transaction: null | { txid: string }
}

export interface PiPaymentCallbacks {
  onReadyForServerApproval: (paymentId: string) => void
  onReadyForServerCompletion: (paymentId: string, txid: string) => void
  onCancel: (paymentId: string) => void
  onError: (error: Error, payment?: PiPaymentDTO) => void
}

export interface PiSdk {
  init(config: { version: string; sandbox?: boolean }): void
  authenticate(
    scopes: string[],
    onIncompletePaymentFound: (payment: PiPaymentDTO) => void,
  ): Promise<PiAuthResult>
  createPayment(
    data: { amount: number; memo: string; metadata: Record<string, unknown> },
    callbacks: PiPaymentCallbacks,
  ): void
  openShareDialog?(title: string, message: string): void
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

// A payment the user signed but that was never completed (say the app was
// closed mid-flow). Pi reports it during sign-in, before we have a session,
// so it waits here until the app can send it to the server.
let incomplete: string | null = null

export function takeIncompletePayment(): string | null {
  const id = incomplete
  incomplete = null
  return id
}

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
  const auth = Pi.authenticate(['username', 'payments'], (payment) => {
    incomplete = payment.identifier
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

export class PaymentCancelled extends Error {
  constructor() {
    super("Payment cancelled. You weren't charged.")
  }
}

export interface PaymentServer<T> {
  approve(paymentId: string): Promise<unknown>
  complete(paymentId: string, txid: string): Promise<T>
  cancel(paymentId: string): Promise<unknown>
}

/**
 * Runs Pi.createPayment and hands each step to our server. Resolves with the
 * server's completion result, which is the only proof the purchase went
 * through. The SDK retries approval and completion itself (about every 10s),
 * so a failed server call is reported through onRetry and not fatal. Rejects
 * with PaymentCancelled if the user backs out.
 */
export function payWithPi<T>(
  order: { amount: number; memo: string; metadata: Record<string, unknown> },
  server: PaymentServer<T>,
  onRetry: (message: string) => void = () => {},
): Promise<T> {
  const Pi = window.Pi
  if (!Pi) return Promise.reject(new Error('Payments work in the Pi Browser.'))
  return new Promise<T>((resolve, reject) => {
    const note = (e: unknown) => onRetry(e instanceof Error ? e.message : String(e))
    Pi.createPayment(
      { amount: order.amount, memo: order.memo, metadata: order.metadata },
      {
        onReadyForServerApproval: (id) => {
          server.approve(id).catch(note)
        },
        onReadyForServerCompletion: (id, txid) => {
          server.complete(id, txid).then(resolve, note)
        },
        onCancel: (id) => {
          server.cancel(id).catch(() => {})
          reject(new PaymentCancelled())
        },
        onError: (error) => reject(error),
      },
    )
  })
}
