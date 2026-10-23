import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteConfirmModal } from './DeleteConfirmModal'

const noop = () => {}

// A refused delete (409) must show the server's reason in the open confirm modal.
describe('DeleteConfirmModal', () => {
  it('shows the refusal reason as an alert', () => {
    const reason = 'produk punya riwayat stok (penerimaan, penyesuaian atau transfer) sehingga tidak bisa dihapus; nonaktifkan produk saja (matikan Produk Aktif)'
    const html = renderToStaticMarkup(<DeleteConfirmModal open onClose={noop} onConfirm={noop} error={reason} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('nonaktifkan produk saja')
  })

  it('disables the confirm button while a delete is in flight', () => {
    const html = renderToStaticMarkup(<DeleteConfirmModal open onClose={noop} onConfirm={noop} busy />)
    const confirm = (html.match(/<button[^>]*>/g) ?? []).find((b) => b.includes('bg-red-600')) ?? ''
    expect(confirm).toMatch(/\sdisabled(=|\s|>)/)
  })

  it('shows no alert without an error', () => {
    const html = renderToStaticMarkup(<DeleteConfirmModal open onClose={noop} onConfirm={noop} error={null} />)
    expect(html).not.toContain('role="alert"')
  })
})
