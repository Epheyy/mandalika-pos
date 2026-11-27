import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_WA_TEMPLATE } from '@mandalika/types'
import { WaTemplateCardView } from './WaTemplateCard'

const html = (over: Partial<Parameters<typeof WaTemplateCardView>[0]> = {}) =>
  renderToStaticMarkup(
    <WaTemplateCardView
      draft={DEFAULT_WA_TEMPLATE} saved={DEFAULT_WA_TEMPLATE} loading={false} saving={false} loadError={null} saveError={null}
      onChange={() => {}} onInsert={() => {}} onReset={() => {}} onSave={() => {}} {...over}
    />,
  )

describe('WaTemplateCardView', () => {
  it('shows title, chips, counter and a rendered preview with sample values', () => {
    const out = html()
    expect(out).toContain('Template WhatsApp Struk')
    for (const t of ['{pelanggan}', '{sales}', '{outlet}', '{no_order}', '{total}', '{tautan}']) expect(out).toContain(t)
    expect(out).toContain(`/1000`)
    expect(out).toContain('Halo Budi')
    expect(out).toContain('Rp 150.000')
    expect(out).toContain('Kembalikan default')
  })
  it('disables Simpan while unchanged', () => {
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*>Simpan/)
  })
  it('shows the inline error and keeps Simpan disabled for an invalid draft', () => {
    const out = html({ draft: 'halo' })
    expect(out).toContain('Template wajib memuat {tautan}')
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Simpan/)
  })
  it('enables Simpan for a valid changed draft', () => {
    const out = html({ draft: 'Halo {tautan}' })
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Simpan/)
  })
})
