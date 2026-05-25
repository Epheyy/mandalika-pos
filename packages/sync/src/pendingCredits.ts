import type { components } from '@mandalika/api'
import type { KV } from './storage'
import { readJSON, writeJSON } from './storage'

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
  list(): PendingCredit[] { return readJSON<PendingCredit[]>(this.kv, KEY, []) }
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
