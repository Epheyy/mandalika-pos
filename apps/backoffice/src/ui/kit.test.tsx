import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmDialog, useConfirm } from './ConfirmDialog'
import { DataTable, groupRuns, type Column } from './DataTable'
import { ExportButton, exportButtonName } from './ExportButton'
import { presetRange, FilterBar } from './FilterBar'
import { OVERLAY_Z, isTopOverlay, overlayDepth, resetOverlayStack } from './overlayStack'
import { SlideOver } from './SlideOver'
import { StatusBadge } from './StatusBadge'
import { Switch } from './Switch'
import { EmptyState } from './EmptyState'
import { Input } from './Field'
import { PageHeader } from './PageHeader'
import type { LabelMap } from '../lib/labels/types'

const noop = () => {}

interface Row {
  id: string
  name: string
  qty: number
}
const COLS: Column<Row>[] = [
  { id: 'name', header: 'Nama', cell: (r) => r.name, sticky: true, width: 120, group: 'Barang', sortKey: 'name' },
  { id: 'qty', header: 'Jumlah', cell: (r) => r.qty, align: 'right', group: 'Barang' },
  { id: 'note', header: 'Catatan', cell: () => 'x', defaultHidden: true },
]
const ROWS: Row[] = [
  { id: '1', name: 'Melati', qty: 4 },
  { id: '2', name: 'Mawar', qty: 9 },
]

describe('DataTable markup', () => {
  const render = (props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) =>
    renderToStaticMarkup(<DataTable caption="Daftar" columns={COLS} rows={ROWS} rowKey={(r) => r.id} {...props} />)

  it('renders real table semantics with a hidden caption', () => {
    const html = render()
    expect(html).toContain('<table')
    expect(html).toContain('<caption class="sr-only">Daftar</caption>')
    expect(html).toContain('scope="col"')
    expect(html).toContain('scope="colgroup"')
    expect(html).toContain('Melati')
  })

  it('keeps the header text exact and puts no sort text in it', () => {
    const html = render({ sort: { key: 'name', dir: 'asc' }, onSortChange: noop })
    expect(html).toContain('aria-sort="ascending"')
    expect(html).toMatch(/>Nama<svg/)
    expect(html).not.toMatch(/Nama (naik|turun|asc|desc)/i)
  })

  it('hides defaultHidden columns', () => {
    expect(render()).not.toContain('Catatan')
  })

  it('right-aligns numbers with tabular figures', () => {
    expect(render()).toContain('text-right tabular-nums')
  })

  it('shows skeleton rows while loading and no data rows', () => {
    const html = render({ loading: true })
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('Melati')
    expect(html).toContain('Jumlah')
  })

  it('shows one alert for an error, with a retry button', () => {
    const html = render({ error: 'Gagal memuat', onRetry: noop })
    expect(html.match(/role="alert"/g)).toHaveLength(1)
    expect(html).toContain('Coba lagi')
  })

  it('shows the empty node only when nothing is loading or failing', () => {
    const empty = <p>Kosong</p>
    expect(render({ rows: [], empty })).toContain('Kosong')
    expect(render({ rows: [], empty, loading: true })).not.toContain('Kosong')
    expect(render({ rows: [], empty, error: 'x' })).not.toContain('Kosong')
  })

  it('puts a real button in the first cell of a clickable row and marks the selected row', () => {
    const html = render({ onRowClick: noop, selectedKey: '2' })
    expect(html).toContain('<button type="button" class="rounded text-left')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('inset 3px 0 0')
  })

  it('renders the footer', () => {
    expect(render({ footer: <span>Hal 1/3</span> })).toContain('Hal 1/3')
  })

  it('renders on the server with a column-prefs key and no localStorage', () => {
    expect(() => render({ columnPrefsKey: 'k' })).not.toThrow()
  })
})

describe('groupRuns', () => {
  it('merges adjacent columns of one group and keeps ungrouped ones apart', () => {
    expect(
      groupRuns([{ id: 'a', group: 'G' }, { id: 'b', group: 'G' }, { id: 'c' }, { id: 'd' }, { id: 'e', group: 'G' }]),
    ).toEqual([
      { label: 'G', span: 2 },
      { label: null, span: 1 },
      { label: null, span: 1 },
      { label: 'G', span: 1 },
    ])
  })
})

describe('ConfirmDialog markup', () => {
  const base = { title: 'Kirim transfer TR-0142?', consequence: 'Stok keluar sekarang.', confirmLabel: 'Kirim transfer', onConfirm: noop, onCancel: noop }

  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(<ConfirmDialog open={false} {...base} />)).toBe('')
  })

  it('is an alertdialog labelled by its question and described by the consequence', () => {
    const html = renderToStaticMarkup(<ConfirmDialog open {...base} />)
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toMatch(/aria-labelledby="([^"]+)-title"/)
    expect(html).toContain('Kirim transfer TR-0142?')
    expect(html).toContain('Batal')
  })

  it('shows a refusal inside the dialog as a single alert', () => {
    const html = renderToStaticMarkup(<ConfirmDialog open {...base} error="Stok tidak cukup" />)
    expect(html).toContain('Stok tidak cukup')
    expect(html.match(/role="alert"(?!dialog)/g)).toHaveLength(1)
  })

  it('disables every action while busy', () => {
    const html = renderToStaticMarkup(<ConfirmDialog open {...base} busy extra={{ label: 'Buang', tone: 'danger', onClick: noop }} />)
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBe(3)
    for (const b of buttons) expect(b).toMatch(/\sdisabled(=|\s|>)/)
  })

  it('disables confirm until a required answer is typed, and labels the field', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open {...base} input={{ label: 'Alasan pembatalan', required: true }} />,
    )
    expect(html).toContain('Alasan pembatalan')
    const confirm = (html.match(/<button[^>]*>/g) ?? []).find((b) => b.includes('bg-brand-strong')) ?? ''
    expect(confirm).toMatch(/\sdisabled(=|\s|>)/)
  })

  it('uses the danger surface for a danger tone', () => {
    expect(renderToStaticMarkup(<ConfirmDialog open {...base} tone="danger" />)).toContain('bg-danger-solid')
  })

  it('useConfirm without a provider declines instead of throwing', async () => {
    let ask: ReturnType<typeof useConfirm> | undefined
    function Probe() {
      ask = useConfirm()
      return null
    }
    renderToStaticMarkup(<Probe />)
    await expect(ask?.({ title: 't', consequence: 'c', confirmLabel: 'ok' })).resolves.toEqual({ confirmed: false })
  })
})

describe('SlideOver markup', () => {
  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(<SlideOver open={false} onClose={noop} title="Barang Masuk">x</SlideOver>)).toBe('')
  })

  it('is a labelled modal dialog with the title as an exact h2 and the subtitle outside it', () => {
    const html = renderToStaticMarkup(
      <SlideOver open onClose={noop} title="Barang Masuk" subtitle="Gudang Pusat">
        isi
      </SlideOver>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toMatch(/<h2 id="[^"]+" class="[^"]*">Barang Masuk<\/h2>/)
    expect(html).toContain('Gudang Pusat')
    expect(html).toContain('aria-label="Tutup"')
  })

  it('uses 560 px by default and 720 px for lg', () => {
    expect(renderToStaticMarkup(<SlideOver open onClose={noop} title="t">x</SlideOver>)).toContain('max-width:560px')
    expect(renderToStaticMarkup(<SlideOver open onClose={noop} title="t" width="lg">x</SlideOver>)).toContain('max-width:720px')
  })

  it('lists field errors in one alert', () => {
    const html = renderToStaticMarkup(
      <SlideOver open onClose={noop} title="t" errorSummary={[{ fieldId: 'a', label: 'Nama wajib diisi' }]}>
        x
      </SlideOver>,
    )
    expect(html.match(/role="alert"/g)).toHaveLength(1)
    expect(html).toContain('Nama wajib diisi')
  })

  it('footer shows the unsaved note only when dirty', () => {
    const on = renderToStaticMarkup(<SlideOver.Footer dirty>b</SlideOver.Footer>)
    const off = renderToStaticMarkup(<SlideOver.Footer>b</SlideOver.Footer>)
    expect(on).toContain('Perubahan belum disimpan')
    expect(off).not.toContain('Perubahan belum disimpan')
  })
})

describe('StatusBadge markup', () => {
  const MAP: LabelMap<'ok' | 'bad'> = {
    ok: { label: 'Terkirim', tone: 'ok' },
    bad: { label: 'Gagal', tone: 'danger', hint: 'ditolak ERP' },
  }

  it('renders the mapped label with its tone and hint', () => {
    const html = renderToStaticMarkup(<StatusBadge map={MAP} value="bad" />)
    expect(html).toContain('Gagal')
    expect(html).toContain('text-danger')
    expect(html).toContain('title="ditolak ERP"')
  })

  it('never shows a raw unknown code', () => {
    const html = renderToStaticMarkup(<StatusBadge map={MAP} value="weird_code" />)
    expect(html).toContain('Lainnya')
    expect(html).toContain('title="weird_code"')
    expect(html).not.toMatch(/>weird_code</)
  })

  it('accepts a literal tone and label, and warn uses the AA-safe text colour', () => {
    const html = renderToStaticMarkup(<StatusBadge tone="warn" label="Menunggu" />)
    expect(html).toContain('Menunggu')
    expect(html).toContain('text-warn-strong')
  })
})

describe('Switch, ExportButton, FilterBar, overlay stack, additive props', () => {
  it('Switch is a named switch reflecting its state', () => {
    const html = renderToStaticMarkup(<Switch checked label="Bayar terpisah" onChange={noop} />)
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-label="Bayar terpisah"')
  })

  it('ExportButton names a single format and a qualifier', () => {
    expect(exportButtonName('csv')).toBe('Unduh CSV')
    expect(exportButtonName('xlsx')).toBe('Unduh Excel')
    expect(exportButtonName('csv', 'refund')).toBe('Unduh CSV refund')
    const html = renderToStaticMarkup(
      <ExportButton rowCount={312} filterSummary={['Status: Selesai']} onExport={noop} qualifier="refund" />,
    )
    expect(html).toContain('aria-label="Unduh CSV refund"')
    expect(html).toContain('title="Unduh CSV refund · 312 baris · Filter: Status: Selesai"')
    expect(html).toContain('· 312')
  })

  it('ExportButton with two formats is a menu button called Unduh, and is disabled at zero rows', () => {
    const two = renderToStaticMarkup(<ExportButton formats={['csv', 'xlsx']} rowCount={null} filterSummary={[]} onExport={noop} />)
    expect(two).toContain('aria-label="Unduh"')
    expect(two).toContain('aria-haspopup="menu"')
    const zero = renderToStaticMarkup(<ExportButton rowCount={0} filterSummary={[]} onExport={noop} />)
    expect(zero).toMatch(/\sdisabled(=|\s|>)/)
  })

  it('FilterBar parts render on the server without an outlet provider', () => {
    const html = renderToStaticMarkup(
      <FilterBar onReset={noop} activeCount={2}>
        <FilterBar.Scope extra="semua gudang" />
        <FilterBar.Search value="" onChange={noop} label="Cari nama produk" />
        <FilterBar.DateRange from="2026-11-01" to="2026-11-03" onChange={noop} presets={['hari-ini']} />
        <FilterBar.Chips items={[{ id: 'a', label: 'Draf', count: 3 }]} value="a" onChange={noop} />
        <FilterBar.Select label="Status" value="" onChange={noop} options={[{ value: '', label: 'Semua' }]} />
      </FilterBar>,
    )
    expect(html).toContain('Cakupan: Semua outlet · semua gudang · mengikuti pilihan di header')
    expect(html).toContain('aria-label="Cari nama produk"')
    expect(html).toContain('>Dari<')
    expect(html).toContain('>Sampai<')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Atur ulang filter (2)')
  })

  it('presetRange gives local-day bounds', () => {
    const now = new Date(2026, 10, 3, 15, 0)
    expect(presetRange('hari-ini', now)).toEqual({ from: '2026-11-03', to: '2026-11-03' })
    expect(presetRange('7-hari', now)).toEqual({ from: '2026-10-28', to: '2026-11-03' })
    expect(presetRange('30-hari', now)).toEqual({ from: '2026-10-05', to: '2026-11-03' })
    expect(presetRange('bulan-ini', now)).toEqual({ from: '2026-11-01', to: '2026-11-03' })
  })

  it('overlay z-order is modal < slide-over < confirm < toast', () => {
    expect(OVERLAY_Z).toEqual({ modal: 50, slideOver: 55, confirm: 60, toast: 70 })
  })

  it('overlay stack helpers start empty and only the last layer is top', () => {
    resetOverlayStack()
    expect(overlayDepth()).toBe(0)
    expect(isTopOverlay('nope')).toBe(false)
  })

  it('PageHeader keeps the title as an exact h2 and puts the count beside it', () => {
    const html = renderToStaticMarkup(<PageHeader title="Produk" count="312 produk" />)
    expect(html).toContain('>Produk</h2>')
    expect(html).toContain('312 produk')
  })

  it('EmptyState renders an action slot', () => {
    expect(renderToStaticMarkup(<EmptyState icon={<i />} title="Kosong" action={<button type="button">Tambah</button>} />)).toContain('Tambah')
  })

  it('Field associates the label, flags invalid and describes the error', () => {
    const html = renderToStaticMarkup(<Input label="Nama" error="Wajib diisi" id="nm" />)
    expect(html).toContain('for="nm"')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="nm-error"')
    expect(html).toContain('id="nm-error"')
  })

  it('Field without error has no aria-invalid', () => {
    expect(renderToStaticMarkup(<Input label="Nama" />)).not.toContain('aria-invalid')
  })
})
