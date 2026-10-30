import { describe, expect, it } from 'vitest'
import {
  addTenderLine, cashPredicate, isCovered, planSaleTender, remainingDue, salePaymentFields, snapshotTenders, splitBlockReason,
  MAX_TENDER_LINES, type SalePlanInput, type TenderLine,
} from './tenderSplit'
import { cashTender } from './tender'

const isCash = cashPredicate([])
const label = (m: string) => ({ tunai: 'Tunai', qris: 'QRIS', card: 'Kartu' })[m] ?? m
const base: SalePlanInput = { splitMode: false, tenders: [], method: 'tunai', amountInput: '', reference: '', due: 100_000, isCash, labelOf: label }

describe('addTenderLine', () => {
  it('caps a non-cash amount at Sisa', () => {
    const r = addTenderLine([], { method: 'qris', amount: 900_000 }, 500_000, isCash)
    expect(r).toEqual({ ok: true, lines: [{ method: 'qris', amount: 500_000 }] })
  })
  it('adds a second cash entry INTO the existing cash line', () => {
    const one = addTenderLine([], { method: 'tunai', amount: 100_000 }, 500_000, isCash)
    if (!one.ok) throw new Error('expected ok')
    const two = addTenderLine(one.lines, { method: 'tunai', amount: 50_000 }, 500_000, isCash)
    expect(two).toEqual({ ok: true, lines: [{ method: 'tunai', amount: 150_000 }] })
  })
  it('a cash amount above Sisa is kept as handed over (change comes from the allocation)', () => {
    const r = addTenderLine([{ method: 'qris', amount: 751_000, reference: '8812345' }], { method: 'tunai', amount: 600_000 }, 1_251_000, isCash)
    expect(r).toEqual({ ok: true, lines: [{ method: 'qris', amount: 751_000, reference: '8812345' }, { method: 'tunai', amount: 600_000 }] })
  })
  it('refuses once Sisa is 0, at N lines, and under Rp1', () => {
    const covered: TenderLine[] = [{ method: 'qris', amount: 100_000 }]
    expect(addTenderLine(covered, { method: 'card', amount: 1000 }, 100_000, isCash)).toEqual({ ok: false, reason: 'covered' })
    const four: TenderLine[] = ['a', 'b', 'c', 'd'].slice(0, MAX_TENDER_LINES).map((m) => ({ method: m, amount: 1000 }))
    expect(addTenderLine(four, { method: 'e', amount: 1000 }, 100_000, isCash)).toEqual({ ok: false, reason: 'full' })
    expect(addTenderLine([], { method: 'qris', amount: 0.5 }, 100_000, isCash)).toEqual({ ok: false, reason: 'amount' })
  })
  it('still tops up the cash line at N lines', () => {
    const four: TenderLine[] = [{ method: 'qris', amount: 1000 }, { method: 'card', amount: 1000 }, { method: 'transfer', amount: 1000 }, { method: 'tunai', amount: 1000 }]
    const r = addTenderLine(four, { method: 'tunai', amount: 5000 }, 100_000, isCash)
    expect(r.ok && r.lines).toHaveLength(4)
  })
  it('drops a blank reference', () => {
    const r = addTenderLine([], { method: 'qris', amount: 1000, reference: '  ' }, 5000, isCash)
    expect(r).toEqual({ ok: true, lines: [{ method: 'qris', amount: 1000 }] })
  })
})

describe('remainingDue / isCovered', () => {
  it('Sisa floors at 0 and tolerates Rp1', () => {
    expect(remainingDue(1000, [{ method: 'tunai', amount: 5000 }])).toBe(0)
    expect(remainingDue(1000, [{ method: 'qris', amount: 400 }])).toBe(600)
    expect(isCovered(1000, [{ method: 'qris', amount: 999.5 }])).toBe(true)
    expect(isCovered(1000, [{ method: 'qris', amount: 998 }])).toBe(false)
  })
})

describe('total changes under entered lines', () => {
  it('blocks Konfirmasi when non-cash now exceeds the total, naming the method', () => {
    const lines: TenderLine[] = [{ method: 'qris', amount: 751_000 }]
    expect(splitBlockReason(700_000, lines, isCash, label)).toBe('Total berubah, hapus pembayaran QRIS lalu masukkan lagi')
  })
  it('a total that grows leaves Sisa to cover, not a stale confirm', () => {
    const lines: TenderLine[] = [{ method: 'qris', amount: 751_000 }]
    expect(splitBlockReason(900_000, lines, isCash, label)).toBe('Pembayaran belum menutup tagihan')
    expect(splitBlockReason(751_000, lines, isCash, label)).toBeNull()
  })
  it('planSaleTender refuses a stale plan and never trims it', () => {
    const plan = planSaleTender({ ...base, splitMode: true, due: 700_000, tenders: [{ method: 'qris', amount: 751_000 }, { method: 'tunai', amount: 10_000 }] })
    expect(plan.ok).toBe(false)
  })
  it('planSaleTender refuses a short split', () => {
    const plan = planSaleTender({ ...base, splitMode: true, due: 1_000_000, tenders: [{ method: 'qris', amount: 400_000 }] })
    expect(plan).toEqual({ ok: false, reason: 'Pembayaran belum menutup tagihan' })
  })
})

describe('payload snapshot', () => {
  it("a one-method sale keeps today's scalars and carries tenders of length 1", () => {
    for (const [method, input, due] of [['tunai', '', 100_000], ['tunai', '150000', 100_000], ['qris', '', 100_000]] as const) {
      const plan = planSaleTender({ ...base, method, amountInput: input, due })
      if (!plan.ok) throw new Error('expected ok')
      const legacy = cashTender(isCash(method), input, due)
      const f = salePaymentFields(plan)
      expect(f.paymentMethod).toBe(method)
      expect(f.amountPaid).toBe(legacy.amountPaid)
      expect(plan.change).toBe(legacy.change)
      expect(f.tenders).toEqual([{ method, amount: legacy.amountPaid }])
      expect(plan.split).toBe(false)
      expect(snapshotTenders(plan, label)).toBeUndefined()
    }
  })
  it('a short single cash entry is refused as before', () => {
    expect(planSaleTender({ ...base, amountInput: '50000' }).ok).toBe(false)
  })
  it('a non-cash reference rides the single line and prints', () => {
    const plan = planSaleTender({ ...base, method: 'qris', reference: ' 8812345 ' })
    if (!plan.ok) throw new Error('expected ok')
    expect(salePaymentFields(plan).tenders).toEqual([{ method: 'qris', amount: 100_000, reference: '8812345' }])
    expect(snapshotTenders(plan, label)).toEqual([{ method: 'qris', label: 'QRIS', amount: 100_000, reference: '8812345' }])
  })
  it('a cash single sale never sends a reference', () => {
    const plan = planSaleTender({ ...base, reference: 'abc' })
    if (!plan.ok) throw new Error('expected ok')
    expect(salePaymentFields(plan).tenders).toEqual([{ method: 'tunai', amount: 100_000 }])
  })
  it('the split payload: summary scalars + lines, change from the same allocation', () => {
    const plan = planSaleTender({
      ...base, splitMode: true, due: 1_251_000,
      tenders: [{ method: 'qris', amount: 751_000, reference: '8812345' }, { method: 'tunai', amount: 600_000 }],
    })
    if (!plan.ok) throw new Error('expected ok')
    expect(salePaymentFields(plan)).toEqual({
      paymentMethod: 'split', amountPaid: 1_351_000,
      tenders: [{ method: 'qris', amount: 751_000, reference: '8812345' }, { method: 'tunai', amount: 600_000 }],
    })
    expect(plan.change).toBe(100_000)
    expect(snapshotTenders(plan, label)).toEqual([
      { method: 'qris', label: 'QRIS', amount: 751_000, reference: '8812345' },
      { method: 'tunai', label: 'Tunai', amount: 600_000 },
    ])
  })
  it('two lines with one shared method keep that method as the summary', () => {
    const plan = planSaleTender({ ...base, splitMode: true, due: 100_000, tenders: [{ method: 'card', amount: 60_000 }, { method: 'card', amount: 40_000 }] })
    if (!plan.ok) throw new Error('expected ok')
    expect(plan.paymentMethod).toBe('card')
    expect(plan.split).toBe(true)
  })
})
