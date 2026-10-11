import type { User } from '@mandalika/api'
import { OUTBOX_KEY, type KV } from '@mandalika/sync'
import { readCachedUser } from './authBoot'

// A04: a tablet is one fixed terminal at one outlet. The outlet it sells for is a
// durable property of the TERMINAL, not of whichever account happens to be signed in
// or of a switcher chosen at flush time:
//  - an account with a stored outlet (cashier/manager) always uses it;
//  - an outlet-less account (admin) picks the outlet ONCE; it is remembered here and
//    changes only through "Lepas terminal" (guarded by an empty queue);
//  - while transactions are queued or in review, a different account is refused.

/** Durable terminal binding (JSON TerminalBinding). */
export const TERMINAL_KEY = 'mandalika.pos.terminal'

export interface TerminalBinding {
  outletId: string
  outletName: string | null
  /** The account that last signed in here; the owner of whatever is in the queue. */
  ownerUserId: string
  ownerName: string
  boundAt: string
}

export function readBinding(kv: KV): TerminalBinding | null {
  const raw = kv.get(TERMINAL_KEY)
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as Partial<TerminalBinding> | null
    if (b && typeof b.outletId === 'string' && b.outletId && typeof b.ownerUserId === 'string' && typeof b.ownerName === 'string') {
      return {
        outletId: b.outletId,
        outletName: typeof b.outletName === 'string' ? b.outletName : null,
        ownerUserId: b.ownerUserId,
        ownerName: b.ownerName,
        boundAt: typeof b.boundAt === 'string' ? b.boundAt : '',
      }
    }
  } catch {
    /* unreadable binding: treated as absent; an outlet-less account is asked to pick again */
  }
  return null
}

export function writeBinding(kv: KV, b: TerminalBinding): Promise<void> {
  return kv.setDurable(TERMINAL_KEY, JSON.stringify(b))
}

export function clearBinding(kv: KV): Promise<void> {
  return kv.removeDurable(TERMINAL_KEY)
}

export function sameBinding(a: TerminalBinding | null, b: TerminalBinding | null): boolean {
  if (!a || !b) return a === b
  return a.outletId === b.outletId && a.outletName === b.outletName
    && a.ownerUserId === b.ownerUserId && a.ownerName === b.ownerName
}

/** The binding after `user` is signed in (pure). The outlet is the account's stored one,
 *  else the one just picked, else the terminal's remembered one; null = an outlet-less
 *  account on an unbound terminal, which must pick. */
export function bindingFor(
  user: Pick<User, 'id' | 'displayName' | 'outletId'>,
  current: TerminalBinding | null,
  picked?: { id: string; name: string },
  now: () => string = () => new Date().toISOString(),
): TerminalBinding | null {
  const outletId = user.outletId || picked?.id || current?.outletId || null
  if (!outletId) return null
  const kept = current && current.outletId === outletId ? current : null
  return {
    outletId,
    outletName: picked && picked.id === outletId ? picked.name : (kept?.outletName ?? null),
    ownerUserId: user.id,
    ownerName: user.displayName,
    boundAt: kept?.boundAt || now(),
  }
}

export interface QueueState {
  /** Items not yet acknowledged (queued, retrying or in review). */
  count: number
  /** false when the stored queue could not be parsed: it must then count as NOT empty. */
  readable: boolean
}

/** Reads the durable outbox without an engine (login happens before one exists). */
export function readQueueState(kv: KV): QueueState {
  const raw = kv.get(OUTBOX_KEY)
  if (raw === null || raw === '') return { count: 0, readable: true }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { count: 0, readable: false }
    const open = parsed.filter((i) => !(i && typeof i === 'object' && (i as { status?: unknown }).status === 'acked'))
    return { count: open.length, readable: true }
  } catch {
    return { count: 0, readable: false }
  }
}

export const isQueueEmpty = (q: QueueState): boolean => q.readable && q.count === 0

export type LoginVerdict = { ok: true } | { ok: false; message: string }

/** Who owns the transactions on this terminal: the binding's owner, else (a tablet
 *  upgraded from before bindings existed) the last cached profile. */
function ownerOf(kv: KV): { id: string; name: string } | null {
  const b = readBinding(kv)
  if (b) return { id: b.ownerUserId, name: b.ownerName }
  const u = readCachedUser(kv)
  return u ? { id: u.id, name: u.displayName } : null
}

/** A different account may not sign in while transactions are queued or in review:
 *  they belong to the account that captured them (A04). An unreadable queue counts as
 *  not empty. If no owner can be determined nothing can be compared, so the account is
 *  let in rather than locking the terminal out of its own queue. */
export function checkLoginAllowed(kv: KV, user: Pick<User, 'id'>): LoginVerdict {
  const q = readQueueState(kv)
  if (isQueueEmpty(q)) return { ok: true }
  const owner = ownerOf(kv)
  if (!owner || owner.id === user.id) return { ok: true }
  const what = q.readable ? `${q.count} transaksi` : 'transaksi (antrean tidak terbaca)'
  return {
    ok: false,
    message: `Terminal ini masih menyimpan ${what} milik akun ${owner.name} yang belum terkirim. Masuk dengan akun ${owner.name} sampai antrean kosong, lalu gunakan "Lepas terminal" di Pengaturan.`,
  }
}

/** Why "Lepas terminal" is not allowed right now, or null when it is. */
export function releaseBlockedReason(input: { unsettled: number; corrupted: boolean; online: boolean }): string | null {
  if (input.corrupted) return 'Antrean sinkronisasi rusak. Hubungi admin sebelum melepas terminal.'
  if (input.unsettled > 0) {
    return `Masih ada ${input.unsettled} transaksi yang belum terkirim atau perlu ditinjau. Kirim/selesaikan dulu sebelum melepas terminal.`
  }
  if (!input.online) return 'Hubungkan internet untuk melepas terminal.'
  return null
}
