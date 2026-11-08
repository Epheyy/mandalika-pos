// F22 / W01: one live POS tab per browser profile. Two tabs share one localStorage: the open-cart draft is one key
// per outlet and the KV outbox store rewrites its whole array from a single writer, so a second tab can overwrite
// the draft and drop an acknowledged pending sale. The store is not changed; instead a Web Lock is taken before
// anything reads or writes storage (main.tsx boot), and a second tab never starts the app until the first one is
// gone. Android tablets run one WebView: the guard is a no-op there.
import { Capacitor } from '@capacitor/core'

export const ACTIVE_TAB_LOCK = 'mandalika-pos-active-tab'

/** The slice of `navigator.locks` the guard needs (and tests fake). */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>
  request(name: string, callback: (lock: unknown) => unknown): Promise<unknown>
}

export type TabClaim =
  | { owner: true }
  /** Another tab owns the app. `granted` resolves when this tab became the owner (the other tab went away). */
  | { owner: false; granted: Promise<void> }

export interface ClaimOptions {
  /** Defaults to `navigator.locks`; null = unsupported. */
  locks?: LockManagerLike | null
  /** Defaults to `Capacitor.isNativePlatform()`. */
  native?: boolean
}

const HOLD_FOREVER = (): Promise<never> => new Promise<never>(() => {})

function browserLocks(): LockManagerLike | null {
  return typeof navigator !== 'undefined' && navigator.locks ? (navigator.locks as unknown as LockManagerLike) : null
}

/** Take the active-tab lock. The lock is held for the life of the page (the callback never settles), so the
 *  browser releases it on close, reload or crash. Never throws: an environment without Web Locks (insecure
 *  context, old browser) or a refused request falls back to `owner`, i.e. no protection but no outage. */
export function claimActiveTab(opts: ClaimOptions = {}): Promise<TabClaim> {
  const native = opts.native ?? Capacitor.isNativePlatform()
  const locks = opts.locks === undefined ? browserLocks() : opts.locks
  if (native || !locks) return Promise.resolve({ owner: true })
  return new Promise<TabClaim>((resolve) => {
    const owner = (): Promise<never> => {
      resolve({ owner: true })
      return HOLD_FOREVER()
    }
    const failOpen = (err: unknown) => {
      console.warn('[tab-guard] Web Locks unavailable, running unguarded', err)
      resolve({ owner: true })
    }
    try {
      void locks
        .request(ACTIVE_TAB_LOCK, { ifAvailable: true }, (lock) => {
          if (lock) return owner()
          // Another tab holds it. Queue for it right away: the queue is served in order, so this tab boots the
          // moment the owner closes, and the grant itself holds the lock forever like an immediate claim.
          const granted = new Promise<void>((done) => {
            void locks.request(ACTIVE_TAB_LOCK, () => {
              done()
              return HOLD_FOREVER()
            }).catch((err: unknown) => {
              // Fails closed: a rejection does not prove the other tab let go, so this tab keeps waiting.
              console.warn('[tab-guard] queued lock request failed; this tab stays on the other-tab notice', err)
            })
          })
          resolve({ owner: false, granted })
          return undefined
        })
        .catch(failOpen)
    } catch (err) {
      failOpen(err)
    }
  })
}
