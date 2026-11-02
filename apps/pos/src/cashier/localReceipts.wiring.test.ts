import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A41 source-level guard on the money path (CashierScreen has no DOM harness): a refund from a local receipt
// goes through the same gate and enqueue as the history refund, a local reprint never queues anything or
// touches the sale gate, and the receipt book is reachable from the menu.
const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
const menu = readFileSync(new URL('./MenuDrawer.tsx', import.meta.url), 'utf8')

const fn = (name: string): string => {
  const start = src.indexOf(`const ${name} =`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const next = src.indexOf('\n  const ', start + 10)
  return src.slice(start, next === -1 ? undefined : next)
}

describe('CashierScreen local receipts wiring (A41)', () => {
  it('refunds from a local receipt through planRefundSubmit and the single refundGate enqueue', () => {
    const confirm = fn('handleRefundConfirm')
    expect(confirm).toContain('planRefundSubmit(')
    expect(confirm).toContain('sale: refundSale')
    expect(confirm).toContain("engine.enqueue('refund'")
    expect(confirm).toContain('offlineLock()')
    expect((src.match(/enqueue\('refund'/g) ?? []).length).toBe(1)
  })

  it('opens the refund dialog for a local receipt with its sale identity and clears it on close', () => {
    expect(src).toContain('setRefundSale(localSaleRef(r))')
    expect(src).toContain('setRefundOrder(localReceiptOrder(r, settings.paymentMethods))')
    expect(src).toContain('setRefundSale(null)')
  })

  it('reprints a local receipt with the REPRINT marker, never through the sale gate or the outbox', () => {
    const reprint = fn('reprintLocal')
    expect(reprint).toContain('reprintReceiptData(')
    expect(reprint).toMatch(/\.print\([^)]*true\)/)
    expect(reprint).not.toMatch(/enqueue|saleGate|submitGate|refundGate/)
  })

  it('falls back to the newest local receipt when there is no last receipt after a restart', () => {
    const reprint = fn('handleReprint')
    expect(reprint).toContain('newestReprintable(')
    expect(reprint).toContain('reprintLocal(')
  })

  it('passes the queued sale uuids and the id map to both refund surfaces', () => {
    expect((src.match(/queuedSaleUuids: engine\.queuedRefundSaleUuids\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((src.match(/serverIdToSaleUuid/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('is reachable from the menu and closes with the Android Back button', () => {
    expect(src).toContain('<LocalReceiptsPanel')
    expect(src).toContain('onLocalReceipts={() => setShowLocalReceipts(true)}')
    expect(src).toContain('if (showLocalReceipts) { setShowLocalReceipts(false); return true }')
    expect(menu).toContain('Struk di Tablet Ini')
  })
})
