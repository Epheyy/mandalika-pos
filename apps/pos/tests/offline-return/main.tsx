// Local-only UI fixture (A41): the real SyncEngine over the page's localStorage, a synthetic sync API and a
// counting printer. No token, real customer data or device storage. The panel, dialog, refund rules and the
// reprint mapping are the production modules; only the CashierScreen glue is mirrored here (and guarded by
// localReceipts.wiring.test.ts).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SyncEngine, defaultKV, type ApiLike, type LocalReceipt } from '@mandalika/sync'
import { LocalReceiptsPanel } from '../../src/cashier/LocalReceiptsPanel'
import { RefundDialog } from '../../src/cashier/RefundDialog'
import { localReceiptOrder, localSaleRef, reprintReceiptData } from '../../src/cashier/localReceipts'
import { planRefundSubmit, refundGateProps, type LocalSaleRef } from '../../src/cashier/refundView'
import { buildReceiptQuote } from '../../src/cashier/receiptQuote'
import type { components } from '@mandalika/api'

type Order = components['schemas']['Order']
const NET_KEY = 'a41.harness.net'
const SHIFT_ID = 'shift-1' // a shift with a server id
const user = { role: 'admin' as const }

// Synthetic server: orders by client uuid, refunds resolved by saleOrderUuid or orderId, one refund per order.
const server = { orders: new Map<string, { id: string; status: string }>(), refunds: [] as object[], seq: 0 }
const batches: string[][] = []
const prints: { orderRef: string; reprint: boolean; customer: string | null }[] = []
type Item = { type: string; idempotencyKey: string; payload: Record<string, unknown> }

const api: ApiLike = {
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (method !== 'POST' || path !== '/api/v1/sync/batch') throw new Error('Unexpected synthetic request')
    if (localStorage.getItem(NET_KEY) !== 'on') throw new TypeError('Failed to fetch')
    const { items } = body as { items: Item[] }
    batches.push(items.map((i) => i.type))
    const results = items.map((i) => {
      if (i.type === 'order') {
        const uuid = String(i.payload.orderUuid)
        const known = server.orders.get(uuid)
        const rec = known ?? { id: `srv-${++server.seq}`, status: 'completed' }
        server.orders.set(uuid, rec)
        return { idempotencyKey: i.idempotencyKey, status: known ? 'duplicate' : 'ok', orderId: rec.id }
      }
      if (i.type === 'refund') {
        const uuid = typeof i.payload.saleOrderUuid === 'string' ? i.payload.saleOrderUuid : ''
        const rec = uuid ? server.orders.get(uuid) : [...server.orders.values()].find((o) => o.id === i.payload.orderId)
        if (!rec) return { idempotencyKey: i.idempotencyKey, status: 'error', error: 'not found', code: 'conflict', retryable: false }
        if (rec.status === 'refunded') return { idempotencyKey: i.idempotencyKey, status: 'error', error: 'already refunded', code: 'conflict', retryable: false }
        rec.status = 'refunded'
        server.refunds.push({ resolvedId: rec.id, viaUuid: !!uuid, sentOrderId: i.payload.orderId })
        return { idempotencyKey: i.idempotencyKey, status: 'ok', orderId: rec.id }
      }
      return { idempotencyKey: i.idempotencyKey, status: 'ok' }
    })
    return { data: { results, processed: results.length, version: 0 } } as T
  },
}

const engine = new SyncEngine(api, {}, defaultKV, { actor: null })

function Harness() {
  const [, refresh] = useState(0)
  const [open, setOpen] = useState(false)
  const [refundOrder, setRefundOrder] = useState<Order | null>(null)
  const [refundSale, setRefundSale] = useState<LocalSaleRef | null>(null)
  const [refundError, setRefundError] = useState<string | null>(null)
  const update = () => refresh((n) => n + 1)

  const sell = async () => {
    const quote = buildReceiptQuote({
      cart: [{ productId: 'p1', productName: 'Mandalika Oud', variantSize: '110ml', price: 125000, quantity: 2, subtotal: 250000 }],
      derived: { subtotal: 250000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: 250000 },
      tender: { amountPaid: 300000, change: 50000 }, refVersion: 1,
    })
    await engine.enqueue('order', {
      orderNumber: 'HAR-0001', paymentMethod: 'cash', amountPaid: 300000, customerName: 'Budi Rahasia', customerId: 'cust-secret',
      items: [{ productId: 'p1', productName: 'Mandalika Oud', variantSize: '110ml', price: 125000, quantity: 2, subtotal: 250000 }],
      shiftId: SHIFT_ID, quotedTotal: quote.quotedTotal, receiptSnapshot: quote.receiptSnapshot,
    })
    update()
  }
  const connect = () => { localStorage.setItem(NET_KEY, 'on'); update() }
  const flush = async () => { await engine.flushNow(); await engine.idle(); update() }
  const reprint = (r: LocalReceipt) => {
    const data = reprintReceiptData(r)
    if (data) prints.push({ orderRef: data.orderRef, reprint: true, customer: data.customerName })
    update()
  }
  const confirm = async (orderId: string, reason: string) => {
    const plan = planRefundSubmit({ refundOrder, orderId, reason, canRefund: true, shiftId: SHIFT_ID, sale: refundSale ?? undefined })
    if (plan.kind === 'error') { setRefundError(plan.message); return }
    await engine.enqueue('refund', { ...plan.payload })
    setRefundOrder(null); setRefundSale(null); setRefundError(null)
    update()
  }
  const queuedRefunds = engine.queuedRefunds()
  const evidence = {
    net: localStorage.getItem(NET_KEY) === 'on',
    pending: engine.pendingCount(),
    outboxOrders: engine.outbox.all().filter((i) => i.type === 'order').length,
    outboxRefunds: queuedRefunds.map((q) => ({ orderId: q.orderId, saleOrderUuid: q.payload.saleOrderUuid, reason: q.payload.reason })),
    prints, batches, serverRefunds: server.refunds,
    serverStatuses: [...server.orders.values()].map((o) => o.status),
    receipts: engine.localReceipts().map((r) => ({ number: r.orderNumber, state: r.state, refundQueued: r.refundQueued, refunded: r.refunded })),
  }
  const receipts = open ? engine.localReceipts() : []
  const idMap = new Map(receipts.flatMap((r): [string, string][] => (r.serverOrderId ? [[r.serverOrderId, r.orderUuid]] : [])))
  return <main>
    <h1>A41 synthetic offline return</h1>
    <p>Synthetic API and memory-only printer. No live database or native durability claim.</p>
    <button onClick={() => { void sell() }}>Jual offline (simulasi)</button>
    <button onClick={() => setOpen(true)}>Buka Struk di tablet ini</button>
    <button onClick={connect}>Sambungkan jaringan</button>
    <button onClick={() => { void flush() }}>Kirim sekarang</button>
    <pre aria-label="Offline return evidence">{JSON.stringify(evidence, null, 2)}</pre>
    <LocalReceiptsPanel isOpen={open} onClose={() => setOpen(false)} receipts={receipts} canReprint onReprint={reprint}
      onRefund={(r) => { setOpen(false); setRefundSale(localSaleRef(r)); setRefundOrder(localReceiptOrder(r)) }}
      {...refundGateProps({ user, currentShift: { id: SHIFT_ID }, queuedOrderIds: engine.queuedRefundOrderIds(), syncedRefundOrderIds: engine.syncedRefundOrderIds(),
        queuedSaleUuids: engine.queuedRefundSaleUuids(), serverIdToSaleUuid: idMap })} />
    <RefundDialog order={refundOrder} isProcessing={false} error={refundError} onConfirm={(id, reason) => { void confirm(id, reason) }}
      onClose={() => { setRefundOrder(null); setRefundSale(null); setRefundError(null) }} />
  </main>
}

createRoot(document.getElementById('root')!).render(<Harness />)
