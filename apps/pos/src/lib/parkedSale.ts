/**
 * C2: what the cashier sees when a sale is parked, and the local "already handled" list.
 *
 * Alerts: the engine's `onDeadLetter` announces each parked idempotency key once. The announcement lives here
 * (module scope), not in a component, so one that fires before the cashier screen mounts is not lost. Each key
 * yields at most one banner; dismissing it is remembered for the session.
 *
 * Acknowledged: "Tandai sudah ditangani" only HIDES a row. The outbox item is never touched, so the sale stays
 * on the tablet. The set is app-local storage (not packages/sync storage), keyed by idempotency key.
 */
import { useSyncExternalStore } from 'react'

export const ACK_STORAGE_KEY = 'mandalika.pos.reviewAcknowledged'
const ACK_MAX = 200

export const parkedSaleMessage = (ref: string): string =>
  `Transaksi #${ref} belum bisa terkirim. Hubungi admin. Transaksi aman di tablet ini.`

// ---- acknowledged set (persisted) ----

export function readAcknowledged(): Set<string> {
  try {
    const raw = localStorage.getItem(ACK_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Add a key and persist; the newest ACK_MAX keys are kept so the list cannot grow without bound. */
export function acknowledge(key: string, base: ReadonlySet<string> = readAcknowledged()): Set<string> {
  const next = new Set(base).add(key)
  const kept = new Set([...next].slice(-ACK_MAX))
  try {
    localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify([...kept]))
  } catch {
    // Storage denied: the row stays hidden for this session through the caller's state.
  }
  return kept
}

/** Rows still to show: parked items the cashier has not marked as handled. */
export function visibleReview<T extends { idempotencyKey: string }>(review: readonly T[], acked: ReadonlySet<string>): T[] {
  return review.filter((r) => !acked.has(r.idempotencyKey))
}

/** Drop keys from the acknowledged set (they were re-queued, so a new park must show again). */
export function unacknowledge(keys: readonly string[], base: ReadonlySet<string> = readAcknowledged()): Set<string> {
  const next = new Set([...base].filter((k) => !keys.includes(k)))
  try {
    localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // Storage denied: the caller's state still shows the rows again this session.
  }
  return next
}

// ---- parked-sale alerts (session) ----

let announced: readonly string[] = []
const dismissed = new Set<string>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Called from onDeadLetter. Keys already announced are ignored (one banner per parked key). */
export function announceParked(keys: readonly string[]): void {
  const fresh = keys.filter((k) => !announced.includes(k))
  if (!fresh.length) return
  announced = [...announced, ...fresh]
  emit()
}

export function dismissParkedAlert(key: string): void {
  if (dismissed.has(key)) return
  dismissed.add(key)
  emit()
}

/** Forget these keys' alert state (they were re-queued): a later park of the same key may announce again. */
export function releaseParked(keys: readonly string[]): void {
  announced = announced.filter((k) => !keys.includes(k))
  keys.forEach((k) => dismissed.delete(k))
  emit()
}

/** Test helper: forget every alert. */
export function resetParkedAlerts(): void {
  announced = []
  dismissed.clear()
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const getAnnounced = () => announced
/** Test helper: the announced keys, oldest first. */
export const announcedParkedKeys = (): readonly string[] => announced
const getDismissedSnapshot = () => dismissed.size

/** The one banner to show now: the oldest announced key that is still parked, not dismissed and not
 *  acknowledged, and only while the cart is empty (nothing covers a sale in progress). */
export function nextParkedAlert(o: {
  announced: readonly string[]
  dismissed: ReadonlySet<string>
  acknowledged: ReadonlySet<string>
  parkedKeys: ReadonlySet<string>
  cartEmpty: boolean
}): string | null {
  if (!o.cartEmpty) return null
  return o.announced.find((k) => o.parkedKeys.has(k) && !o.dismissed.has(k) && !o.acknowledged.has(k)) ?? null
}

export function useParkedAlertState(): { announced: readonly string[]; dismissed: ReadonlySet<string> } {
  const a = useSyncExternalStore(subscribe, getAnnounced)
  useSyncExternalStore(subscribe, getDismissedSnapshot) // re-render on dismiss
  return { announced: a, dismissed }
}
