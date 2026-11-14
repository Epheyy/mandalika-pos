import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildReceiptQuote, receiptAddsUp, receiptFromQuote } from '../receiptQuote'
import { quoteTotalRows } from '../receiptRows'
import type { SalePlan } from '../tenderSplit'
import {
  applyLockedTenders, commitVoidDraftSale, voidDraftRefusal, voidDroppedMessage, voidPayable, voidSlipData, type VoidEngine,
} from './voidCheckout'
import type { VoidDraft } from './voidReplacement'

const screen = readFileSync(new URL('../CashierScreen.tsx', import.meta.url), 'utf8')

const sale = { id: 'ord1', orderNumber: 'BSD-1', total: 100000, shiftId: 's1', items: [{ productId: 'a', variantSize: 'S', quantity: 2 }], tenders: [], paymentMethod: 'qris' } as never
const draft = (over: Partial<VoidDraft> = {}): VoidDraft => ({
  orderId: 'ord1', orderNumber: 'BSD-1', originalTotal: 100000, originalTenders: [{ method: 'qris', amount: 100000 }],
  reason: 'salah_barang', note: 'x', stockChoices: {}, shiftId: 's1', amountsLocked: false, kind: 'void_and_replace',
  replacementUuid: 'new', startedShiftId: 's1', sale, ...over,
})
const open = { id: 's1', status: 'open' as const }
const engine = () => ({
  enqueue: vi.fn<VoidEngine['enqueue']>(async (_t, _p, orderUuid) => ({ idempotencyKey: `dev:${orderUuid}`, orderUuid })),
})
const input = (over: Record<string, unknown> = {}) => ({
  engine: engine(), draft: draft(), currentShift: open, saleUuid: 'new', choice: 'adjust' as const, cartTotal: 90000,
  orderPayload: { orderNumber: 'BSD-2', tenders: [{ method: 'qris', amount: 100000 }], quotedTotal: 100000 }, ...over,
})

describe('commitVoidDraftSale', () => {
  it("confirm with a void draft enqueues exactly one 'void' item and no 'order' item", async () => {
    const i = input()
    const r = await commitVoidDraftSale(i as never)
    expect(r).toEqual({ status: 'queued', type: 'void', orderUuid: 'new' })
    expect(i.engine.enqueue).toHaveBeenCalledTimes(1)
    const [type, payload, uuid] = i.engine.enqueue.mock.calls[0]!
    expect(type).toBe('void')
    expect(uuid).toBe('new')
    expect(payload.mode).toBe('replace')
    expect(payload.reasonCode).toBe('salah_barang')
    expect(payload.replacement).toMatchObject({ orderNumber: 'BSD-2', orderUuid: 'new', correctionTarget: 'original_total' })
  })

  it('confirm refuses a void draft whose shift is no longer open', async () => {
    for (const shift of [null, { id: 's1', status: 'closed' as const }, { id: 's2', status: 'open' as const }, { id: '', status: 'open' as const }]) {
      const i = input({ currentShift: shift })
      const r = await commitVoidDraftSale(i as never)
      expect(r).toEqual({ status: 'refused', message: 'Pembatalan tidak jadi: transaksi #BSD-1 tetap tercatat.', dropDraft: true })
      expect(i.engine.enqueue).not.toHaveBeenCalled()
    }
  })

  it('an own-shift draft of an unattributed sale (O5) still needs the shift it started in', () => {
    const d = draft({ shiftId: null, startedShiftId: 's1' })
    expect(voidDraftRefusal(d, open)).toBeNull()
    expect(voidDraftRefusal(d, { id: 's9', status: 'open' })).toBe(voidDroppedMessage('BSD-1'))
  })

  it('settle sends no correctionTarget; locked always sends one', async () => {
    const a = input({ choice: 'settle' })
    await commitVoidDraftSale(a as never)
    expect(a.engine.enqueue.mock.calls[0]![1].replacement).not.toHaveProperty('correctionTarget')
    const b = input({ choice: 'settle', draft: draft({ amountsLocked: true }) })
    await commitVoidDraftSale(b as never)
    expect(b.engine.enqueue.mock.calls[0]![1].replacement).toMatchObject({ correctionTarget: 'original_total' })
  })

  it('blocks a locked draft whose lines are not what the store received, with the server text', async () => {
    const i = input({ draft: draft({ amountsLocked: true }), orderPayload: { tenders: [{ method: 'cash', amount: 150000 }] } })
    const r = await commitVoidDraftSale(i as never)
    expect(r).toMatchObject({ status: 'refused', dropDraft: false, message: 'Jumlah pembayaran pengganti harus sama dengan yang diterima (Rp 100.000).' })
    expect(i.engine.enqueue).not.toHaveBeenCalled()
  })

  it('Buat pengganti queues ONE order with replacesOrderId, never a void', async () => {
    const i = input({ draft: draft({ kind: 'create_replacement', amountsLocked: true, shiftId: 's0' }), currentShift: null })
    const r = await commitVoidDraftSale(i as never)
    expect(r).toEqual({ status: 'queued', type: 'order', orderUuid: 'new' })
    expect(i.engine.enqueue).toHaveBeenCalledTimes(1)
    expect(i.engine.enqueue.mock.calls[0]![0]).toBe('order')
    expect(i.engine.enqueue.mock.calls[0]![1]).toMatchObject({ replacesOrderId: 'ord1', correctionTarget: 'original_total', shiftId: 's0' })
  })
})

describe('Buat pengganti is always locked', () => {
  const lockedByKind = (): VoidDraft => draft({ kind: 'create_replacement', amountsLocked: false })
  it('trims change, checks the sum and forces original_total even with the flag off', async () => {
    const plan: Extract<SalePlan, { ok: true }> = { ok: true, lines: [{ method: 'cash', amount: 150000 }], paymentMethod: 'cash', amountPaid: 150000, change: 50000, split: false }
    const cash = [{ id: 'cash', label: 'Tunai', isCash: true }]
    expect(applyLockedTenders(plan, lockedByKind(), cash)).toMatchObject({ lines: [{ method: 'cash', amount: 100000 }], change: 0 })
    expect(voidPayable(lockedByKind(), 'settle', 90000)).toMatchObject({ correctionTarget: 'original_total', correction: 10000 })
    const i = input({ draft: lockedByKind(), currentShift: null, orderPayload: { tenders: [{ method: 'cash', amount: 150000 }] } })
    expect(await commitVoidDraftSale(i as never)).toMatchObject({ status: 'refused', dropDraft: false })
    expect(i.engine.enqueue).not.toHaveBeenCalled()
  })
})

describe('draft without its original', () => {
  it('is refused up front so no number is burned', () => {
    expect(voidDraftRefusal(draft({ sale: undefined }), open)).toBe(voidDroppedMessage('BSD-1'))
  })
})

describe('locked tenders are applied amounts', () => {
  const plan: Extract<SalePlan, { ok: true }> = { ok: true, lines: [{ method: 'cash', amount: 150000 }], paymentMethod: 'cash', amountPaid: 150000, change: 50000, split: false }
  it('trims the change off a locked draft and leaves an unlocked one alone', () => {
    const cash = [{ id: 'cash', label: 'Tunai', isCash: true }]
    const locked = applyLockedTenders(plan, draft({ amountsLocked: true }), cash)
    expect(locked).toMatchObject({ lines: [{ method: 'cash', amount: 100000 }], amountPaid: 100000, change: 0 })
    expect(applyLockedTenders(plan, draft(), cash)).toBe(plan)
  })
})

describe('replacement money', () => {
  const derived = { subtotal: 90000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: 90000 }
  it('quote total equals originalTotal when choice is adjust', () => {
    const { correction, payable } = voidPayable(draft(), 'adjust', 90000)
    expect(correction).toBe(10000)
    expect(payable).toBe(100000)
    const quote = buildReceiptQuote({ cart: [], derived, tender: { amountPaid: 100000, change: 0 }, refVersion: 1, correction })
    expect(quote.quotedTotal).toBe(100000)
    expect(quote.receiptSnapshot.total).toBe(100000)
    expect(quote.receiptSnapshot.correctionAmount).toBe(10000)
    const data = receiptFromQuote(quote, { orderRef: 'BSD-2', dateTime: new Date(0), paymentLabel: 'QRIS', customerName: null, customerPhone: null, cashierName: 'K' })
    expect(data.correctionAmount).toBe(10000)
    expect(receiptAddsUp({ ...data, lines: [{ name: 'x', qty: 1, unitPrice: 90000, amount: 90000 }] })).toBe(true)
    expect(quoteTotalRows([], derived, { showSubtotal: true, showDiscount: true, showTax: true }, correction).map((r) => r.kind)).toContain('correction')
  })
  it('settle leaves the cart total and no correction', () => {
    expect(voidPayable(draft(), 'settle', 90000)).toEqual({ correction: 0, payable: 90000 })
    expect(voidPayable(null, 'adjust', 90000)).toEqual({ correction: 0, payable: 90000 })
    const q = buildReceiptQuote({ cart: [], derived, tender: { amountPaid: 0, change: 0 }, refVersion: 1 })
    expect(q.receiptSnapshot).not.toHaveProperty('correctionAmount')
  })
})

describe('DIBATALKAN slip data', () => {
  it('carries the reason label, the original total and the replacement number', () => {
    const d = voidSlipData({ draft: draft({ note: ' salah ' }), voidedBy: 'Sari', replacementRef: 'BSD-2', at: new Date(2026, 10, 14, 9, 5) })
    expect(d).toMatchObject({ orderRef: 'BSD-1', total: 100000, reasonLabel: 'Salah barang', note: 'salah', voidedBy: 'Sari', replacementRef: 'BSD-2', dateTime: '14/11/2026 09:05' })
  })
})

describe('CashierScreen wiring', () => {
  const confirm = screen.slice(screen.indexOf('const handleConfirmPayment'), screen.indexOf('const handleReprint'))
  it('shift close cancels the void draft (and its cart)', () => {
    expect(screen).toMatch(/closed\) \{ await openCart\.clearForSale\(\); dispatch\(\{ type: 'VOID_DRAFT_CANCEL' \}\) \}/)
  })
  it('the sale payload comes from the shared builder; a draft goes through commitVoidDraftSale inside the gate', () => {
    expect(confirm).toContain('buildSaleOrderPayload(')
    expect(confirm).toMatch(/voidDraft\s*\? await commitVoidDraftSale\(/)
    expect(confirm.match(/engine\.enqueue\(/g)).toHaveLength(1)
  })
  it('refuses before reserving a number; due and quote use the one payable total and the correction', () => {
    expect(confirm.indexOf('voidDraftRefusal(')).toBeLessThan(confirm.indexOf('reserveOrderNo('))
    expect(confirm).toContain('due: payDerived.total')
    expect(confirm).toContain('correction: voidPay.correction')
  })
  it('prints the slip only after the save, then the replacement receipt', () => {
    expect(confirm.indexOf('printVoidSlip(')).toBeGreaterThan(confirm.indexOf("outcome.status === 'failed'"))
    expect(confirm).toContain('replacesOrderRef = voidDraft.orderNumber')
  })
  it('the sale uuid prefers the void draft replacementUuid over split and minted uuids', () => {
    const hook = readFileSync(new URL('../useOpenCartDraft.ts', import.meta.url), 'utf8')
    expect(hook).toMatch(/s.voidDraft?.replacementUuid ?? (s.splitMode/)
  })
  it('a void replacement cart cannot be parked', () => {
    expect(screen).toContain('canSave={heldOrders.canSave}')
  })
})
