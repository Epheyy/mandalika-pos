import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError, type ReceiptTemplate } from '@mandalika/api'
import { layoutFromApi, validateTemplate, type ReceiptBlock } from '@mandalika/printer/render'
import { designerReducer, toBody, type DesignerState } from './designerReducer'
import { printableHint } from './BlockEditor'
import {
  STALE_SAVE_COPY, UNUSABLE_TEMPLATE_COPY, ADJUSTED_NOTICE, saveDesign, standarOutletIds, unusableTemplateIds, needsVirtualStandar,
  type TemplateApi,
} from './receiptTemplates'
import { StrukView, type StrukViewProps } from './StrukView'
import { VIRTUAL_KEY } from './TemplateBar'

const settings = { copies: 1, headerText: 'Toko Kita', footerText: 'Terima kasih' } as never
const virtual = (s: unknown = settings): DesignerState =>
  designerReducer({} as DesignerState, { type: 'loadVirtualStandar', settings: s as never })
const blocksOf = (s: DesignerState): ReceiptBlock[] => s.layout.blocks

const view = (state: DesignerState, over: Partial<StrukViewProps> = {}): string =>
  renderToStaticMarkup(
    <StrukView
      state={state} dispatch={() => {}} templates={[]} showVirtualStandar unusable={new Set()} selectedKey={VIRTUAL_KEY}
      usedBy={2} notice={null} saving={false} addOpen={false} onToggleAdd={() => {}} onSelect={() => {}} onNew={() => {}}
      onDuplicate={() => {}} onRename={() => {}} onDelete={() => {}} onAssign={() => {}} onSave={() => {}} onReload={() => {}}
      {...over}
    />,
  )

const template = (over: Partial<ReceiptTemplate> = {}): ReceiptTemplate => ({
  id: '11111111-1111-1111-1111-111111111111', name: 'Baru', paperWidth: 58, isDefault: false, version: 1, outletIds: [], updatedAt: '',
  blocks: blocksOf(designerReducer(virtual(), { type: 'newTemplate', name: 'x', paperWidth: 58 })) as never, ...over,
})

describe('StrukView', () => {
  it('locked rows show the lock badge and no switch', () => {
    const html = view(designerReducer(virtual(), { type: 'newTemplate', name: 'Baru', paperWidth: 58 }))
    expect(html.match(/data-testid="lock-badge"/g)).toHaveLength(3)
    for (const name of ['Daftar barang', 'Diskon &amp; total', 'Pembayaran &amp; kembalian']) {
      expect(html).not.toContain(`aria-label="Tampilkan ${name}"`)
    }
    expect(html).toContain('aria-label="Tampilkan Poin member"')
    expect(html).toContain('total wajib')
  })

  it('switching Kertas to 80mm widens the preview to 48 columns', () => {
    const s58 = designerReducer(virtual(), { type: 'newTemplate', name: 'Baru', paperWidth: 58 })
    expect(view(s58)).toContain('data-cols="32"')
    const s80 = designerReducer(s58, { type: 'setWidth', paperWidth: 80 })
    expect(view(s80)).toContain('data-cols="48"')
  })

  it('Hapus on Standar is disabled', () => {
    const html = view(virtual())
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Hapus<\/button>/)
    const saved = designerReducer(virtual(), { type: 'load', template: template({ isDefault: true }) })
    expect(view(saved)).toMatch(/<button[^>]*disabled=""[^>]*>Hapus<\/button>/)
    const other = designerReducer(virtual(), { type: 'load', template: template() })
    expect(view(other)).not.toMatch(/<button[^>]*disabled=""[^>]*>Hapus<\/button>/)
  })

  it('the payment row has no Kembalian switch', () => {
    const s = designerReducer(designerReducer(virtual(), { type: 'newTemplate', name: 'Baru', paperWidth: 58 }), { type: 'select', id: 'payment' })
    const html = view(s)
    expect(html).toContain('data-testid="editor-payment"')
    expect(html).not.toMatch(/aria-label="[^"]*Kembalian"/)
  })

  it('typed text with é shows the replaced character hint', () => {
    expect(printableHint('Café')).toContain('é')
    expect(printableHint('Cafe')).toBeNull()
  })

  it('an unedited Standar saved from settings with headerText Café and a 700-char footer lists what changed', () => {
    const footer = Array.from({ length: 20 }, () => 'a'.repeat(34)).join('\n')
    const s = virtual({ copies: 1, headerText: 'Café', footerText: footer })
    const html = view(s)
    expect(html).toContain(ADJUSTED_NOTICE)
    expect(html).toContain('Karakter tak bisa dicetak diganti')
    expect(html).toContain('Teks dipotong')
    const body = toBody(s)
    expect(validateTemplate({ name: body.name, paperWidth: body.paperWidth, blocks: body.blocks as unknown as ReceiptBlock[] })).toEqual([])
  })

  it('a template the tablet would refuse shows the warning', () => {
    const bad = template({ blocks: blocksOf(designerReducer(virtual(), { type: 'newTemplate', name: 'x', paperWidth: 58 })).filter((b) => b.type !== 'payment') as never })
    expect(layoutFromApi(bad)).toBeNull()
    expect(unusableTemplateIds([bad, template({ id: '22222222-2222-2222-2222-222222222222' })])).toEqual(new Set([bad.id]))
    const s = designerReducer(virtual(), { type: 'load', template: bad })
    expect(view(s, { unusable: new Set([bad.id]), templates: [bad], selectedKey: bad.id })).toContain(UNUSABLE_TEMPLATE_COPY)
    const good = designerReducer(virtual(), { type: 'load', template: template() })
    expect(view(good, { templates: [template()], selectedKey: template().id })).not.toContain(UNUSABLE_TEMPLATE_COPY)
  })
})

describe('saveDesign', () => {
  const fakeApi = (over: Partial<TemplateApi> = {}): TemplateApi => ({
    createReceiptTemplate: vi.fn().mockResolvedValue(template({ isDefault: true })),
    updateReceiptTemplate: vi.fn().mockResolvedValue(template({ version: 2 })),
    deleteReceiptTemplate: vi.fn(), assignReceiptTemplate: vi.fn(), ...over,
  })

  it('with no templates, Standar built from receipt settings is created, with no compat fields', async () => {
    const api = fakeApi()
    const result = await saveDesign(api, virtual())
    expect(result.kind).toBe('ok')
    const body = vi.mocked(api.createReceiptTemplate).mock.calls[0]![0]
    expect(body.isDefault).toBe(true)
    expect(body.name).toBe('Standar')
    for (const k of ['compat', 'spaceAfter', 'spaceBefore', 'showChange']) expect(JSON.stringify(body)).not.toContain(k)
    expect(api.updateReceiptTemplate).not.toHaveBeenCalled()
  })

  it('an existing template is updated with the loaded version', async () => {
    const api = fakeApi()
    const s = designerReducer(virtual(), { type: 'load', template: template({ version: 5 }) })
    await saveDesign(api, s)
    expect(api.updateReceiptTemplate).toHaveBeenCalledWith(s.templateId, expect.objectContaining({ version: 5 }))
  })

  it('a 409 on save is stale, and the draft is untouched', async () => {
    const api = fakeApi({ updateReceiptTemplate: vi.fn().mockRejectedValue(new ApiError(409, 'stale')) })
    const loaded = designerReducer(virtual(), { type: 'load', template: template() })
    const edited = designerReducer(loaded, { type: 'rename', name: 'Dirubah' })
    expect(await saveDesign(api, edited)).toEqual({ kind: 'stale' })
    expect(edited.name).toBe('Dirubah')
    expect(STALE_SAVE_COPY).toBe('Template ini sudah diubah di tempat lain. Muat ulang lalu ulangi.')
  })

  it('a refusal the shared validator knows is reported without calling the server', async () => {
    const api = fakeApi()
    const s = designerReducer(designerReducer(virtual(), { type: 'newTemplate', name: 'Baru', paperWidth: 58 }), { type: 'rename', name: '  ' })
    const result = await saveDesign(api, s)
    expect(result.kind).toBe('invalid')
    expect(api.createReceiptTemplate).not.toHaveBeenCalled()
  })

  it('other server errors surface their message', async () => {
    const api = fakeApi({ createReceiptTemplate: vi.fn().mockRejectedValue(new ApiError(422, 'Nama sudah dipakai')) })
    const s = designerReducer(virtual(), { type: 'newTemplate', name: 'Baru', paperWidth: 58 })
    expect(await saveDesign(api, s)).toEqual({ kind: 'error', message: 'Nama sudah dipakai' })
  })
})

describe('outlet helpers', () => {
  it('the virtual Standar covers the outlets no template claims', () => {
    const t = [template({ outletIds: ['a'] }), template({ id: '3', outletIds: ['b'] })]
    expect(standarOutletIds(t, ['a', 'b', 'c', 'd'])).toEqual(['c', 'd'])
    expect(needsVirtualStandar(t)).toBe(true)
    expect(needsVirtualStandar([...t, template({ id: '4', isDefault: true })])).toBe(false)
  })
})
