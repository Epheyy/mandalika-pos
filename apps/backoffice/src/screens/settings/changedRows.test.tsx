import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SETTINGS, diffSettings, dirtyMarkers } from './settingsDiff'
import { TransaksiSection } from './TransaksiSection'

const draft = {
  ...DEFAULT_SETTINGS,
  taxEnabled: false,
  splitTenderEnabled: true,
  paymentMethods: DEFAULT_SETTINGS.paymentMethods.map((m) => (m.id === 'qris' ? { ...m, isEnabled: false } : m)),
}
const changes = diffSettings(DEFAULT_SETTINGS, draft)
const render = (s: typeof draft, ch: typeof changes) =>
  renderToStaticMarkup(<TransaksiSection s={s} setS={() => {}} newPay="" setNewPay={() => {}} changed={dirtyMarkers(ch).cards} changes={ch} />)

// BO3-03: a changed row is tinted and says what it was; the card title carries the "Belum disimpan" tag.
describe('unsaved-change marking', () => {
  const html = render(draft, changes)
  it('tints each changed row and names the saved value', () => {
    expect(html).toContain('Sebelumnya aktif')
    expect(html).toContain('Aktif sebelumnya aktif')
    // Rows: PPN, QRIS, Bayar terpisah (row) = 3 rows, plus the three cards (tax, payments, split) = 6 marks.
    expect(html.match(/data-changed="true"/g)).toHaveLength(6)
    expect(html).toMatch(/data-changed="true"[^>]*>(?:(?!<\/div>).)*Aktifkan pajak \(PPN\)/s)
    // Unchanged siblings stay plain: the rounding row and the other payment methods carry no mark.
    expect(html).not.toMatch(/data-changed="true"[^>]*>(?:(?!<\/div>).)*Pembulatan harga/s)
    expect(html).not.toMatch(/data-changed="true"[^>]*>(?:(?!<\/div>).)*>Tunai</s)
  })
  it('tags the changed cards after their title', () => {
    expect(html).toContain('>Pajak &amp; pembulatan</h3><span')
    expect(html).toContain('Belum disimpan')
  })
  it('marks nothing when nothing changed', () => {
    const clean = render(DEFAULT_SETTINGS as typeof draft, [])
    expect(clean).not.toContain('Belum disimpan')
    expect(clean).not.toContain('Sebelumnya')
    expect(clean).not.toContain('data-changed')
  })
})
