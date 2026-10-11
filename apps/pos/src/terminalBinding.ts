import type { User } from '@mandalika/api'
import { OUTBOX_KEY, isOutboxStore, summarizeQueue, type KV, type OutboxStore, type QueueSummary } from '@mandalika/sync'
import { readCachedUser } from './authBoot'

// A04: a tablet is one fixed terminal at one outlet. The outlet it sells for is a
// durable property of the TERMINAL, not of whichever account happens to be signed in
// or of a switcher chosen at flush time:
//  - an admin (no stored outlet) picks the outlet ONCE; it is remembered here and changes
//    only through "Lepas terminal";
//  - a cashier/manager must have the stored outlet the terminal is bound to, otherwise the
//    terminal is blocked ("mismatch") until it is released;
//  - while transactions are waiting to be sent (or are parked without an owner stamp), a
//    different account is refused; parked items that carry an envelope do not lock it.

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

/** Outlet-specific reference data cached on the device (snapshot incl. outletCode, prices,
 *  stock, promos; inbound transfers; optimistic credits). Cleared when the terminal is bound
 *  to a (new) outlet or released, so an outlet can never sell from another outlet's data if
 *  its first pull fails. */
export const OUTLET_CACHE_KEYS: readonly string[] = [
  'mandalika.pos.snapshot',
  'mandalika.pos.contentVersion',
  'mandalika.pos.inboundTransfers',
  'mandalika.pos.pendingCredits',
]

/** Per-outlet last-known shift (see hooks/shiftView.ts). */
export const shiftCacheKeyFor = (outletId: string): string => `mandalika.pos.shift.${outletId}`

export function clearOutletCaches(kv: KV, outletId?: string | null): void {
  for (const k of OUTLET_CACHE_KEYS) kv.remove(k)
  if (outletId) kv.remove(shiftCacheKeyFor(outletId))
}

export function sameBinding(a: TerminalBinding | null, b: TerminalBinding | null): boolean {
  if (!a || !b) return a === b
  return a.outletId === b.outletId && a.outletName === b.outletName
    && a.ownerUserId === b.ownerUserId && a.ownerName === b.ownerName
}

export type TerminalState =
  /** The terminal acts as `binding.outletId`. */
  | 'ok'
  /** An outlet-less ADMIN on an unbound terminal: must pick once. */
  | 'pick'
  /** A non-admin account with no stored outlet: cannot operate a terminal. */
  | 'unassigned'
  /** A non-admin account whose outlet differs from the terminal outlet: blocked until released. */
  | 'mismatch'

export interface TerminalResolution {
  state: TerminalState
  /** The binding to act on / persist; null for pick and unassigned. For a mismatch it is the
   *  EXISTING binding, untouched: nothing but "Lepas terminal" ever rebinds a bound terminal. */
  binding: TerminalBinding | null
  /** true = a new binding is being created (the terminal was unbound). */
  created: boolean
}

/** Decide how `user` relates to this terminal (pure). Never changes an existing binding's
 *  outlet: an admin always uses the binding (it wins over their home outlet); a non-admin
 *  whose stored outlet differs from it is a mismatch. A new binding is only ever created on
 *  an unbound terminal (first sign-in, a pick, or an upgraded tablet), never over a bound one. */
export function resolveTerminal(
  user: Pick<User, 'id' | 'displayName' | 'outletId' | 'role'>,
  current: TerminalBinding | null,
  picked?: { id: string; name: string },
  now: () => string = () => new Date().toISOString(),
): TerminalResolution {
  const owned = (b: TerminalBinding): TerminalBinding => ({ ...b, ownerUserId: user.id, ownerName: user.displayName })
  const fresh = (outletId: string, outletName: string | null): TerminalBinding =>
    owned({ outletId, outletName, ownerUserId: '', ownerName: '', boundAt: now() })
  if (user.role === 'admin') {
    if (current) return { state: 'ok', binding: owned(current), created: false }
    if (!picked) return { state: 'pick', binding: null, created: false }
    return { state: 'ok', binding: fresh(picked.id, picked.name), created: true }
  }
  if (!user.outletId) return { state: 'unassigned', binding: null, created: false }
  if (!current) return { state: 'ok', binding: fresh(user.outletId, null), created: true }
  if (current.outletId !== user.outletId) return { state: 'mismatch', binding: current, created: false }
  return { state: 'ok', binding: owned(current), created: false }
}

/** Fill in the human outlet name (never a UUID) once it is known; null = nothing to change. */
export function withOutletName(b: TerminalBinding, name: string | null | undefined): TerminalBinding | null {
  return name && b.outletName !== name ? { ...b, outletName: name } : null
}

export interface QueueState extends QueueSummary {
  /** false when the stored queue could not be parsed: it must then count as NOT empty. */
  readable: boolean
}

/** The Preferences-backed KV behind a queue source (the journal's own `kv` is a meta facade). */
const prefsOf = (source: KV | OutboxStore): KV => (isOutboxStore(source) ? source.noticeKV ?? source.kv : source)

/** Reads the durable outbox without an engine (login happens before one exists). Pass the outbox
 *  store the app runs on (journal or KV); a bare KV is read as the legacy whole-array key. */
export function readQueueState(source: KV | OutboxStore): QueueState {
  const none = { pending: 0, parkedStamped: 0, parkedUnstamped: 0, owners: [] as string[] }
  if (isOutboxStore(source)) {
    const loaded = source.load()
    return loaded.kind === 'ok' ? { ...summarizeQueue(loaded.items), readable: true } : { ...none, readable: false }
  }
  const kv = source
  const raw = kv.get(OUTBOX_KEY)
  if (raw === null || raw === '') return { ...none, readable: true }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { ...none, readable: false }
    return { ...summarizeQueue(parsed), readable: true }
  } catch {
    return { ...none, readable: false }
  }
}

/** Everything still unacknowledged. */
export const queueCount = (q: QueueSummary): number => q.pending + q.parkedStamped + q.parkedUnstamped

/** The terminal may change hands / be released when nothing is waiting to be sent and every
 *  parked item carries its capture-time envelope (so it stays attributable to its owner, stays
 *  in the outbox and is never deleted). An unreadable queue is never releasable. */
export const isQueueReleasable = (q: QueueState): boolean => q.readable && q.pending === 0 && q.parkedUnstamped === 0

export type LoginVerdict = { ok: true } | { ok: false; message: string }

/** Who owns the transactions on this terminal: the binding owner, else the last cached profile,
 *  else the account named by the queued items own envelopes (name unknown, so its id). */
function ownerOf(kv: KV, q: QueueState): { id: string; name: string } | null {
  const b = readBinding(kv)
  if (b) return { id: b.ownerUserId, name: b.ownerName }
  const u = readCachedUser(kv)
  if (u) return { id: u.id, name: u.displayName }
  return q.owners.length ? { id: q.owners[0], name: q.owners[0] } : null
}

/** A different account may not sign in while transactions are waiting to be sent or are parked
 *  without an owner stamp: they belong to the account that captured them (A04). Parked items
 *  that carry an envelope do not lock the terminal (they stay, labelled with their owner). An
 *  unreadable queue counts as not empty. If no owner can be determined nothing can be compared,
 *  so the account is let in rather than locking the terminal out of its own queue. */
export function checkLoginAllowed(source: KV | OutboxStore, user: Pick<User, 'id'>): LoginVerdict {
  const kv = prefsOf(source)
  const q = readQueueState(source)
  if (isQueueReleasable(q)) return { ok: true }
  const owner = ownerOf(kv, q)
  if (!owner || owner.id === user.id) return { ok: true }
  const what = q.readable ? `${queueCount(q)} transaksi` : 'transaksi (antrean tidak terbaca)'
  return {
    ok: false,
    message: `Terminal ini masih menyimpan ${what} milik akun ${owner.name} yang belum terkirim. Masuk dengan akun ${owner.name} sampai antrean kosong, lalu gunakan "Lepas terminal" di Pengaturan.`,
  }
}

/** Display name for an account id: the staff list in the snapshot, else the id itself. */
export function ownerLabel(userId: string, users: readonly { id: string; displayName?: string }[] | null | undefined): string {
  return users?.find((u) => u.id === userId)?.displayName || userId
}

/** Why "Lepas terminal" is not allowed right now, or null when it is. Parked items that carry an
 *  envelope do not block it. */
export function releaseBlockedReason(input: { pending: number; parkedUnstamped: number; corrupted: boolean; online: boolean }): string | null {
  if (input.corrupted) return 'Antrean sinkronisasi rusak. Hubungi admin sebelum melepas terminal.'
  const open = input.pending + input.parkedUnstamped
  if (open > 0) {
    return `Masih ada ${open} transaksi yang belum terkirim atau perlu ditinjau tanpa pemilik. Kirim/selesaikan dulu sebelum melepas terminal.`
  }
  if (!input.online) return 'Hubungkan internet untuk melepas terminal.'
  return null
}
