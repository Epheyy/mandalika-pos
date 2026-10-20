// Fake server for the A15 phase B (outlet stock counter) engine tests. One outlet, one SKU `p1|10ml`.
// Every stock change (own sale, foreign sale, refund) bumps `seq` by exactly one, like the real counter.
// A commit happens when the request is RECEIVED; `pullGate` / `batchGate` only delay the response, so a test
// can put the server commit before or after any client step.
import { vi } from 'vitest'
import type { ApiLike } from '../engine'

type Body = { items: { type: string; idempotencyKey: string; payload: { items?: { quantity: number }[] } }[] }

export type BatchMode = 'ok' | 'duplicate' | 'lost' | 'park'

export function makeSeqServer(opts: { withSeq?: boolean } = {}) {
  const s = {
    /** false = an old server: no stockSeq anywhere. */
    withSeq: opts.withSeq ?? true,
    version: 1,
    stock: 5,
    seq: 10,
    pulls: 0,
    pullTimes: [] as number[],
    versionPolls: 0,
    pullGate: null as Promise<void> | null,
    batchGate: null as Promise<void> | null,
    batchMode: 'ok' as BatchMode,
    /** Omit the per-item seq (an order attributed to another outlet gets none from the real server). */
    omitItemSeq: false,
    /** The sale belongs to another outlet: acked ok, but this outlet's stock and counter do not move. */
    otherOutlet: false,
    resolved: [] as string[],
    /** Another tablet's sale (or a backoffice sale) at this outlet. */
    foreignSale(qty = 1) { s.stock -= qty; s.seq += 1 },
    /** A refund restocking this outlet. */
    refund(qty = 1) { s.stock += qty; s.seq += 1 },
  }
  const seqField = () => (s.withSeq ? { stockSeq: s.seq } : {})
  const request = vi.fn(async (method: string, path: string, body?: Body) => {
    if (method === 'GET' && path.includes('/sync/pull')) {
      s.pulls += 1
      s.pullTimes.push(Date.now())
      const bundle = {
        version: s.version,
        ...seqField(), // read FIRST, like the real Pull, then the products
        products: [{ id: 'p1', name: 'A', isActive: true, variants: [{ size: '10ml', price: 1, stock: s.stock, sku: '' }] }],
        categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [],
      }
      if (s.pullGate) await s.pullGate
      return { data: bundle }
    }
    if (method === 'GET' && path.includes('/sync/version')) {
      s.versionPolls += 1
      return { data: { version: s.version, ...seqField() } }
    }
    if (method === 'GET' && path.includes('/sync/inbound')) return { data: [] }
    if (method === 'POST' && path.includes('/sync/review-items')) {
      return { data: { resolved: s.resolved.map((k) => ({ idempotencyKey: k, note: 'ok', resolvedByName: 'HO' })) } }
    }
    if (method === 'POST' && path.includes('/sync/batch') && body) {
      const results = body.items.map((i) => {
        if (s.batchMode === 'park') return { idempotencyKey: i.idempotencyKey, status: 'error', error: 'x', code: 'conflict', retryable: false }
        if (s.batchMode === 'duplicate') return { idempotencyKey: i.idempotencyKey, status: 'duplicate' }
        if (s.otherOutlet) return { idempotencyKey: i.idempotencyKey, status: 'ok' }
        s.foreignSale(i.payload.items?.[0]?.quantity ?? 0) // commits now, whoever sent it
        const item = s.withSeq && !s.omitItemSeq ? { stockSeq: s.seq } : {}
        return { idempotencyKey: i.idempotencyKey, status: 'ok', ...item }
      })
      if (s.batchGate) await s.batchGate
      if (s.batchMode === 'lost') throw new TypeError('network') // committed, but the response never arrives
      return { data: { processed: results.length, version: s.version, ...seqField(), results } }
    }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return { s, api: { request: request as unknown as ApiLike['request'] } as ApiLike }
}
