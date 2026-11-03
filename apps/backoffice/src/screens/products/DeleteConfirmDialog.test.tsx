import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteConfirmDialog } from './DeleteConfirmDialog'

const noop = () => {}
const buttonTags = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/g) ?? []
const confirmButton = (html: string) => buttonTags(html).find((b) => b.includes('>Hapus<')) ?? ''

// A refused delete (409) must show the server's reason in the open confirm dialog.
describe('DeleteConfirmDialog', () => {
  it('asks about the named item as an alert dialog', () => {
    const html = renderToStaticMarkup(<DeleteConfirmDialog open subject='produk "Melati"' onConfirm={noop} onCancel={noop} />)
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('Hapus produk &quot;Melati&quot;?')
    expect(html).toContain('Data tidak dapat dikembalikan.')
  })

  it('shows the refusal reason as an alert', () => {
    const reason = 'produk punya riwayat stok (penerimaan, penyesuaian atau transfer) sehingga tidak bisa dihapus; nonaktifkan produk saja (matikan Produk Aktif)'
    const html = renderToStaticMarkup(<DeleteConfirmDialog open subject="produk" onConfirm={noop} onCancel={noop} error={reason} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('nonaktifkan produk saja')
  })

  it('disables both buttons while a delete is in flight', () => {
    const html = renderToStaticMarkup(<DeleteConfirmDialog open subject="produk" onConfirm={noop} onCancel={noop} busy />)
    expect(confirmButton(html)).toMatch(/\sdisabled(=|\s|>)/)
    expect(buttonTags(html).find((b) => b.includes('>Batal<')) ?? '').toMatch(/\sdisabled(=|\s|>)/)
  })

  it('shows no alert without an error and renders nothing while closed', () => {
    expect(renderToStaticMarkup(<DeleteConfirmDialog open subject="produk" onConfirm={noop} onCancel={noop} error={null} />)).not.toContain('role="alert"')
    expect(renderToStaticMarkup(<DeleteConfirmDialog open={false} subject="produk" onConfirm={noop} onCancel={noop} />)).toBe('')
  })
})
