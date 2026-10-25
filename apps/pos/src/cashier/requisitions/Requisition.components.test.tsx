import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Product, StockRequisition } from '@mandalika/api'
import { RequisitionList } from './RequisitionList'
import { RequisitionDetail } from './RequisitionDetail'
import { RequisitionForm } from './RequisitionForm'
import { EMPTY_FORM } from './requisitionFlow'
import { variantOptions } from './variantOptions'

const pb = (over: Partial<StockRequisition> = {}): StockRequisition => ({
  id: 'r1', number: 'PB-2026-00001', status: 'draft', outletId: 'o1', requestedBy: 'u1', requestedByName: 'Kasir 1',
  createdAt: '2026-10-26T01:00:00Z', updatedAt: '2026-10-26T01:00:00Z',
  items: [{ id: 'i1', productId: 'p1', productName: 'Aroma', variantSize: 'M', sku: 'AR-M', requestedQty: 3 }],
  events: [{ id: 1, action: 'created', actorName: 'Kasir 1', at: '2026-10-26T01:00:00Z' }],
  ...over,
})
const product = (over: Partial<Product> = {}): Product => ({
  id: 'p1', name: 'Aroma', brand: 'b', categoryId: 'c', isFeatured: false, isFavourite: false, isActive: true, createdAt: '',
  variants: [{ size: 'M', price: 1, stock: 4, sku: 'AR-M' }, { size: 'L', price: 1, stock: 0, sku: 'AR-L', isActive: false } as never],
  ...over,
})
const noop = vi.fn()
const listProps = { rows: [] as StockRequisition[], loading: false, error: null, filter: '' as const, onFilter: noop, onOpen: noop, onNew: noop, onReload: noop }
const detailProps = { busy: false, message: null, onEdit: noop, onSubmit: noop, onCancel: noop, onOpenReceive: noop }
const formProps = { form: EMPTY_FORM, onChange: noop, products: [product()], busy: false, message: null, onMessage: noop, isEdit: false, onSave: noop, onDiscard: noop }

describe('RequisitionList', () => {
  it('shows the empty state, the filter chips and Buat Permintaan', () => {
    const html = renderToStaticMarkup(createElement(RequisitionList, listProps))
    expect(html).toContain('Belum ada permintaan barang dari outlet ini.')
    for (const t of ['Semua', 'Draf', 'Diajukan', 'Disetujui', 'Transfer Dibuat', 'Ditolak', 'Dibatalkan', 'Buat Permintaan', 'Muat ulang']) expect(html).toContain(t)
  })

  it('lists number, status badge, creator and the linked transfer', () => {
    const html = renderToStaticMarkup(createElement(RequisitionList, {
      ...listProps, rows: [pb({ status: 'fulfilled', transfer: { id: 't1', transferNo: 'TR-9', status: 'in_transit' } })],
    }))
    expect(html).toContain('PB-2026-00001')
    expect(html).toContain('Transfer Dibuat')
    expect(html).toContain('Kasir 1')
    expect(html).toContain('TR-9')
  })

  it('shows a notice above the list (a requisition that may already be saved)', () => {
    const html = renderToStaticMarkup(createElement(RequisitionList, { ...listProps, notice: 'Permintaan mungkin sudah tersimpan — cek daftar permintaan.' }))
    expect(html).toContain('mungkin sudah tersimpan')
    expect(renderToStaticMarkup(createElement(RequisitionList, listProps))).not.toContain('role="status"')
  })

  it('shows an error with Coba Lagi instead of the list', () => {
    const html = renderToStaticMarkup(createElement(RequisitionList, { ...listProps, error: 'Permintaan Barang butuh koneksi internet.' }))
    expect(html).toContain('butuh koneksi internet')
    expect(html).toContain('Coba Lagi')
  })
})

describe('RequisitionDetail', () => {
  const render = (p: StockRequisition) => renderToStaticMarkup(createElement(RequisitionDetail, { ...detailProps, pb: p }))

  it('draft: Ajukan, Ubah and Batalkan, the chain, the lines and the history', () => {
    const html = render(pb())
    for (const t of ['>Ajukan<', '>Ubah<', 'Batalkan Permintaan', 'Diterima', 'Riwayat', 'Aroma · M (AR-M)']) expect(html).toContain(t)
  })

  it('submitted: only Batalkan; nothing to approve or fulfil is ever rendered', () => {
    const html = render(pb({ status: 'submitted' }))
    expect(html).toContain('Batalkan Permintaan')
    expect(html).not.toContain('>Ajukan<')
    expect(html).not.toContain('>Ubah<')
    expect(html).not.toMatch(/Setujui|Tolak|Buat Transfer/)
  })

  it('in-transit transfer offers Buka Terima Transfer', () => {
    const html = render(pb({ status: 'fulfilled', transfer: { id: 't1', transferNo: 'TR-9', status: 'in_transit' } }))
    expect(html).toContain('Buka Terima Transfer')
    expect(html).toContain('Dikirim')
  })

  it('rejected shows the warehouse decision note as a dead end and no actions', () => {
    const html = render(pb({ status: 'rejected', decisionNote: 'stok kosong' }))
    expect(html).toContain('stok kosong')
    expect(html).not.toContain('Batalkan Permintaan')
  })

  it('shows a failure message', () => {
    expect(renderToStaticMarkup(createElement(RequisitionDetail, { ...detailProps, pb: pb(), message: 'Server belum menjawab.' }))).toContain('Server belum menjawab.')
  })
})

describe('RequisitionForm and variant picker', () => {
  it('has the picker with stock hint, date, Diminta oleh, note and both save buttons', () => {
    const html = renderToStaticMarkup(createElement(RequisitionForm, formProps))
    for (const t of ['Cari nama atau SKU', 'Aroma · M (AR-M)', 'Stok outlet: 4', 'Dibutuhkan pada', 'Diminta oleh', 'Catatan', 'Simpan Draf', 'Simpan &amp; Ajukan']) expect(html).toContain(t)
  })

  it('lists added lines with their qty and marks the picker row as already added', () => {
    const form = { ...EMPTY_FORM, lines: [{ productId: 'p1', productName: 'Aroma', variantSize: 'M', sku: 'AR-M', qty: '5' }] }
    const html = renderToStaticMarkup(createElement(RequisitionForm, { ...formProps, form }))
    expect(html).toContain('sudah ditambahkan')
    expect(html).toContain('value="5"')
  })

  it("disables every input while a request is in flight (H1) and caps the free-text fields (L8)", () => {
    const busy = renderToStaticMarkup(createElement(RequisitionForm, { ...formProps, busy: true }))
    expect(busy).toMatch(/<fieldset disabled=""/)
    const idle = renderToStaticMarkup(createElement(RequisitionForm, formProps))
    expect(idle).not.toMatch(/<fieldset disabled/)
    expect(idle).toContain("maxLength=\"60\"")
    expect(idle).toContain("maxLength=\"500\"")
  })

  it("shows a real Coba Lagi button only when a retry action is set (L6)", () => {
    const msg = "Server belum menjawab."
    expect(renderToStaticMarkup(createElement(RequisitionForm, { ...formProps, message: msg }))).not.toContain("Coba Lagi")
    expect(renderToStaticMarkup(createElement(RequisitionForm, { ...formProps, message: msg, onRetry: noop }))).toContain("Coba Lagi")
    expect(renderToStaticMarkup(createElement(RequisitionDetail, { ...detailProps, pb: pb(), message: msg }))).not.toContain("Coba Lagi")
    expect(renderToStaticMarkup(createElement(RequisitionDetail, { ...detailProps, pb: pb(), message: msg, onRetry: noop }))).toContain("Coba Lagi")
  })

  it('shows a validation message', () => {
    expect(renderToStaticMarkup(createElement(RequisitionForm, { ...formProps, message: 'Tambahkan minimal satu barang.' }))).toContain('Tambahkan minimal satu barang.')
  })

  it('variantOptions skips inactive products and variants and matches name, SKU and size', () => {
    expect(variantOptions([product()], '').map((o) => o.variantSize)).toEqual(['M'])
    expect(variantOptions([product({ isActive: false })], '')).toEqual([])
    expect(variantOptions([product()], 'ar-m')).toHaveLength(1)
    expect(variantOptions([product()], 'zzz')).toEqual([])
    expect(variantOptions([product({ name: 'Mawar' })], 'mawar')).toHaveLength(1)
    expect(variantOptions([product({ variants: [{ size: 'M', price: 1, stock: 1, sku: 'a' }, { size: 'S', price: 1, stock: 1, sku: 'b' }] })], '', 1)).toHaveLength(1)
  })
})

describe('busy list and forced discard (re-review L2, L3)', () => {
  it('busy disables Buat Permintaan and the row taps (the open-time resolve)', () => {
    const busy = renderToStaticMarkup(createElement(RequisitionList, { ...listProps, rows: [pb()], busy: true }))
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Buat Permintaan/)
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*><div[^>]*><span[^>]*>PB-2026-00001/)
    const idle = renderToStaticMarkup(createElement(RequisitionList, { ...listProps, rows: [pb()] }))
    expect(idle).not.toMatch(/<button[^>]*disabled=""[^>]*>Buat Permintaan/)
  })

  it('offers "Buang tanpa cek" only when a stuck pending create asks for it', () => {
    expect(renderToStaticMarkup(createElement(RequisitionForm, formProps))).not.toContain('Buang tanpa cek')
    const html = renderToStaticMarkup(createElement(RequisitionForm, { ...formProps, onForceDiscard: noop }))
    expect(html).toContain('Buang tanpa cek — periksa daftar permintaan dulu')
  })
})
