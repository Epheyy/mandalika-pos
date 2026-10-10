import type { components } from '@mandalika/api'
import type { KV } from './storage'
import { writeJSON } from './storage'

type Bundle = components['schemas']['SyncPullBundle']

export interface CreditLine { productId: string; variantSize: string; qty: number }
export interface PendingCredit {
  idempotencyKey: string
  lines: CreditLine[]
  ackVersion: number | null // set when the receive acks; null while in flight
}

const KEY = 'mandalika.pos.pendingCredits'

/** Pure: fold credit deltas onto a bundle's per-variant stock. Returns the SAME
 *  reference when there are no credits; otherwise a shallow-cloned bundle (input
 *  is never mutated). */
export function applyCredits(bundle: Bundle, credits: PendingCredit[]): Bundle {
  if (!credits.length || !bundle.products) return bundle
  const delta = new Map<string, number>()
  for (const c of credits) {
    for (const l of c.lines) {
      const k = l.productId + '|' + l.variantSize
      delta.set(k, (delta.get(k) ?? 0) + l.qty)
    }
  }
  const products = bundle.products.map((p) => {
    let touched = false
    const variants = p.variants.map((v) => {
      const d = delta.get(p.id + '|' + v.size)
      if (!d) return v
      touched = true
      return { ...v, stock: v.stock + d }
    })
    return touched ? { ...p, variants } : p
  })
  return { ...bundle, products }
}

export function retireByVersion(credits: PendingCredit[], snapshotVersion: number): PendingCredit[] {
  return credits.filter((c) => c.ackVersion === null || c.ackVersion > snapshotVersion)
}

/** Persisted list of optimistic credits (survives restart + snapshot.replace). */
export class PendingCredits {
  constructor(private kv: KV) {}
  private quarantined = false
  list(): PendingCredit[] {
    const raw = this.kv.get(KEY)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as PendingCredit[]
    } catch {
      /* fall through to quarantine */
    }
    // Display-only optimistic stock (the receive itself lives in the outbox), so
    // an unreadable list is not fatal — but keep the bytes before a save() can
    // overwrite them. Best-effort: issued before any later write to KEY.
    if (!this.quarantined) {
      this.quarantined = true
      this.kv.setDurable(`mandalika.pendingCredits.corrupt.${new Date().toISOString()}`, raw).catch(() => {})
    }
    return []
  }
  private save(v: PendingCredit[]): void { writeJSON(this.kv, KEY, v) }
  add(c: PendingCredit): void { this.save([...this.list(), c]) }
  stampAck(idempotencyKey: string, version: number): void {
    this.save(this.list().map((c) => c.idempotencyKey === idempotencyKey ? { ...c, ackVersion: version } : c))
  }
  remove(idempotencyKey: string): void {
    this.save(this.list().filter((c) => c.idempotencyKey !== idempotencyKey))
  }
  retire(snapshotVersion: number): void { this.save(retireByVersion(this.list(), snapshotVersion)) }
  isEmpty(): boolean { return this.list().length === 0 }
}
