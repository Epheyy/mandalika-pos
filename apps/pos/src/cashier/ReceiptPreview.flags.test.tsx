import { readFileSync } from 'node:fs'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReceiptPreview } from './ReceiptPreview'

type Props = ComponentProps<typeof ReceiptPreview>
const noop = () => {}
const T0 = new Date(2026, 10, 9, 23, 59, 30)

const base: Props = {
  isOpen: true, orderId: 'abcdef12-0000', orderNumber: 'BSD-0001', items: [], totalRows: [],
  paymentMethod: 'cash', amountPaid: 150000, change: 50000, customerName: 'Sari', customerPhone: '0812000', cashierName: 'Dewi',
  settings: { receipt: { headerText: '', footerText: '' } } as never, capturedAt: T0,
  orderState: 'queued', isPendingSync: false, canReprint: true, printError: null, onReprint: noop, onClose: noop, onNewSale: noop,
}
const html = (receipt: Record<string, unknown>, extra: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(ReceiptPreview, { ...base, settings: { receipt: { headerText: '', footerText: '', ...receipt } } as never, ...extra }))
// The paper mock = everything but the change call-out above it.
const paper = (h: string) => h.slice(h.indexOf('<img'))

// key -> [marker the paper mock shows, what an absent/null key means] (same table as the printer test)
const ROWS = {
  showOrderNumber: ['No BSD-0001', true],
  showCashier: ['Kasir: Dewi', false],
  showCustomerName: ['Pelanggan: Sari', true],
  showCustomerPhone: ['Telp: 0812000', false],
  showChange: ['receipt-change', true],
} as const
const STATES = ['absent', 'null', 'false', 'true'] as const
const val = (st: (typeof STATES)[number]) => (st === 'null' ? null : st === 'true')

describe('F35 on-screen receipt follows the flags like the printer', () => {
  for (const [k, [marker, dflt]] of Object.entries(ROWS)) {
    for (const st of STATES) {
      const want = st === 'true' ? true : st === 'false' ? false : dflt
      it(`${k} ${st}: ${want ? 'shown' : 'hidden'}`, () => {
        const h = html(st === 'absent' ? {} : { [k]: val(st) })
        expect(paper(h).includes(marker)).toBe(want)
      })
    }
  }

  it('change OFF: Kembalian leaves the paper but stays on the success screen', () => {
    const h = html({ showChange: false })
    expect(paper(h)).not.toContain('receipt-change')
    expect(h).toContain('data-testid="change-callout"')
    expect(h).toMatch(/Kembalian Rp\s?50\.000/)
    expect(html({ showChange: true })).not.toContain('change-callout')
  })

  it('a Rp0 change shows no call-out either way', () => {
    expect(html({ showChange: false }, { change: 0 })).not.toContain('change-callout')
  })

  it('hiding one flag changes only that field', () => {
    const on = paper(html({ showCustomerName: true }))
    const off = paper(html({ showCustomerName: false }))
    expect(on.replace('<p>Pelanggan: Sari</p>', '')).toBe(off)
  })
})

describe('F36 on-screen receipt time is the stored sale time', () => {
  afterEach(() => vi.useRealTimers())
  const shown = (h: string) => /data-testid="receipt-time">([^<]*)</.exec(h)![1]

  it('stays at T0 after a minute and midnight pass, across sync-state and print-error rerenders', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const first = shown(html({}))
    expect(first).toBe(T0.toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
    vi.setSystemTime(new Date(2026, 10, 10, 0, 1, 5))
    expect(shown(html({}, { orderState: 'synced' }))).toBe(first)
    expect(shown(html({}, { orderState: 'parked', printError: 'Printer terputus' }))).toBe(first)
    expect(shown(html({}, { isPendingSync: true, orderState: 'unknown' }))).toBe(first)
  })

  it('shows no time rather than the render time when none was captured', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 10, 0, 1, 5))
    expect(shown(html({}, { capturedAt: null }))).toBe('')
  })

  it('CashierScreen feeds one captured time to the paper and the preview, never the render clock', () => {
    const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/dateTime: saleAt,/)
    expect(src).toMatch(/setSaleTime\(saleAt\)/)
    expect(src).toMatch(/capturedAt=\{saleTime\}/)
    expect(src).toMatch(/engine\.localReceipts\(\)\.find\(\(r\) => r\.orderUuid === orderUuid\)\?\.capturedAt/)
    expect(readFileSync(new URL('./ReceiptPreview.tsx', import.meta.url), 'utf8')).not.toMatch(/new Date\(\)/)
  })
})
