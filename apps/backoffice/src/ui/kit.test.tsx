import { Inbox } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmDialog, initialFocusTarget, useConfirm } from './ConfirmDialog'
import { DataTable, groupRuns, type Column } from './DataTable'
import { ExportButton, exportButtonName } from './ExportButton'
import { presetRange, FilterBar } from './FilterBar'
import { OVERLAY_Z, isTopOverlay, overlayDepth, resetOverlayStack } from './overlayStack'
import { SlideOver } from './SlideOver'
import { StatusBadge, TONE_CLASS } from './StatusBadge'
import { Switch } from './Switch'
import { EmptyState } from './EmptyState'
import { Input } from './Field'
import { IconButton } from './IconButton'
import { ImportExportMenu } from './ImportExportMenu'
import { Pagination, pageList } from './Pagination'
import { Tabs, nextTabIndex } from './Tabs'
import { isOverflowing } from './useHorizontalOverflow'
import { PageHeader } from './PageHeader'
import { Badge } from './Badge'
import { Button } from './Button'
import { SaveBar } from './SaveBar'
import { readFileSync } from 'node:fs'
import type { LabelMap } from '../lib/labels/types'

const noop = () => {}

const tokensCss = readFileSync(new URL('../../../../packages/ui-tokens/tokens.css', import.meta.url), 'utf8')
function tokenHex(name: string): string {
  const m = tokensCss.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`token ${name} missing`)
  return m[1]
}
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [16, 8, 0].map((sh) => {
    const c = ((n >> sh) & 0xff) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

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
    expect(html).toContain('aria-current="true"')
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

describe('initialFocusTarget: where a ConfirmDialog starts', () => {
  it('starts on the confirm button for a plain question, the field when there is one', () => {
    expect(initialFocusTarget({ hasInput: false })).toBe('confirm')
    expect(initialFocusTarget({ hasInput: true })).toBe('field')
  })
  it('starts on Batal for a danger action', () => expect(initialFocusTarget({ tone: 'danger', hasInput: true })).toBe('cancel'))
  it('starts on Batal when asked, even for a default-tone question (the D-79 activation questions)', () => {
    expect(initialFocusTarget({ initialFocus: 'cancel', hasInput: false })).toBe('cancel')
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
    expect(two).toContain('aria-expanded="false"')
    expect(two).not.toContain('role="menu"')
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

describe('review fixes', () => {
  it('a toast region is always mounted as role=status and never role=alert', async () => {
    const { ToastProvider } = await import('./Toast')
    const html = renderToStaticMarkup(
      <ToastProvider>
        <p>x</p>
      </ToastProvider>,
    )
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="alert"')
  })

  it('chip count is separated from the label for the accessible name', () => {
    const html = renderToStaticMarkup(
      <FilterBar.Chips items={[{ id: 'a', label: 'Masuk', count: 12 }]} value="a" onChange={noop} />,
    )
    expect(html).toContain('Masuk<span class="sr-only"> </span>')
    expect(html).not.toContain('opacity-80')
  })

  it('Field keeps a caller aria-describedby next to its own error id', () => {
    const html = renderToStaticMarkup(<Input label="Nama" error="Wajib" id="n" aria-describedby="extra" />)
    expect(html).toContain('aria-describedby="extra n-error"')
  })

  it('only the column row of a grouped header is sticky', () => {
    const html = renderToStaticMarkup(
      <DataTable caption="c" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />,
    )
    const group = html.match(/<th[^>]*scope="colgroup"[^>]*>/)?.[0] ?? ''
    expect(group).not.toContain('sticky')
    expect(html).toContain('sticky top-0')
  })
})

describe('K2: tabs', () => {
  const tabs = [
    { id: 'a', label: 'Satu' },
    { id: 'b', label: 'Dua', dirty: true },
  ]
  const html = renderToStaticMarkup(<Tabs value="b" onChange={noop} tabs={tabs} scope="s" label="Bagian" />)

  it('is a tablist of tabs with aria-selected, never aria-pressed', () => {
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Bagian"')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-selected="false"')
    expect(html).not.toContain('aria-pressed')
  })
  it('keeps data-tab-key and data-dirty for the browser gate', () => {
    expect(html).toContain('data-tab-key="s.a"')
    expect(html).toContain('data-tab-key="s.b"')
    expect(html).toContain('data-dirty="true"')
  })
  it('has one tab stop: the selected tab, or the first when the value matches nothing', () => {
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1)
    const stale = renderToStaticMarkup(<Tabs value={'zz' as 'a'} onChange={noop} tabs={tabs} />)
    expect(stale.match(/tabindex="0"/g)).toHaveLength(1)
  })
  it('does not change weight on selection', () => {
    expect(html).not.toContain('font-bold')
    expect(html).toContain('tabular-nums')
  })
  it('moves focus with arrows, wrapping, and Home/End', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0)
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(nextTabIndex('ArrowLeft', 2, 3)).toBe(1)
    expect(nextTabIndex('Home', 2, 3)).toBe(0)
    expect(nextTabIndex('End', 0, 3)).toBe(2)
    expect(nextTabIndex('Enter', 0, 3)).toBeNull()
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull()
  })
})

describe('K2: DataTable single scroll', () => {
  const html = renderToStaticMarkup(<DataTable caption="c" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />)
  it('has no inner vertical scroll box', () => {
    expect(html).not.toContain('max-h-')
    expect(html).not.toContain('overflow-auto')
    expect(html).not.toContain('overflow-hidden')
  })
  it('clips the card and the wrapper without making either a scroll container while the table fits', () => {
    expect(html).toContain('overflow-clip')
    expect(html).toContain('overflow-x-clip')
  })
  it('draws the sticky header border as a shadow, not a border', () => {
    expect(html).toContain('shadow-[inset_0_-1px_0')
  })
  it('flags a table as overflowing only past the rounding tolerance', () => {
    expect(isOverflowing(800, 800)).toBe(false)
    expect(isOverflowing(801, 800)).toBe(false)
    expect(isOverflowing(802, 800)).toBe(true)
    expect(isOverflowing(500, 800)).toBe(false)
  })
})

describe('K2: pagination, filters, icon buttons', () => {
  it('Pagination shows the range, numbered pages with aria-current, and "per halaman"', () => {
    const html = renderToStaticMarkup(<Pagination page={2} totalPages={3} total={60} pageSize={25} onChange={noop} onPageSizeChange={noop} />)
    expect(html).toContain('Menampilkan 26–50 dari 60')
    expect(html).toContain('aria-label="Halaman 1"')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="Halaman 2"[^>]*aria-current="page"|aria-current="page"[^>]*aria-label="Halaman 2"/)
    expect(html).toContain('25 per halaman')
    expect(html).toContain('aria-label="Baris per halaman"')
    expect(html).toContain('h-9')
  })
  it('Pagination controls are real buttons (keyboard works natively); prev/next are aria-disabled at the ends so focus is never dropped', () => {
    const first = renderToStaticMarkup(<Pagination page={1} totalPages={3} total={60} pageSize={25} onChange={noop} onPageSizeChange={noop} />)
    expect(first).toMatch(/<button type="button" aria-label="Sebelumnya"[^>]*aria-disabled="true"/)
    expect(first).not.toMatch(/aria-label="Berikutnya"[^>]*aria-disabled="true"/)
    const last = renderToStaticMarkup(<Pagination page={3} totalPages={3} total={60} pageSize={25} onChange={noop} onPageSizeChange={noop} />)
    expect(last).toMatch(/aria-label="Berikutnya"[^>]*aria-disabled="true"/)
  })
  it('pageList collapses long ranges to first, last and the current neighbours', () => {
    expect(pageList(1, 1)).toEqual([1])
    expect(pageList(1, 3)).toEqual([1, 2, 3])
    expect(pageList(1, 13)).toEqual([1, 2, 'gap', 13])
    expect(pageList(7, 13)).toEqual([1, 'gap', 6, 7, 8, 'gap', 13])
    expect(pageList(13, 13)).toEqual([1, 'gap', 12, 13])
    expect(pageList(4, 6)).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('Pagination shows no range for an empty list', () => {
    const html = renderToStaticMarkup(<Pagination page={1} totalPages={1} total={0} pageSize={25} onChange={noop} onPageSizeChange={noop} />)
    expect(html).not.toContain('Menampilkan')
  })
  it('FilterBar.Select puts the label inline and keeps it as the accessible name', () => {
    const html = renderToStaticMarkup(<FilterBar.Select label="Kategori" value="" onChange={noop} options={[{ value: '', label: 'Semua' }]} />)
    expect(html).toContain('aria-label="Kategori"')
    expect(html).toContain('Kategori:')
    expect(html).not.toContain('<label')
  })
  it('IconButton gives its label as aria-label and title, and stays optional', () => {
    const named = renderToStaticMarkup(<IconButton label="Ubah Melati">x</IconButton>)
    expect(named).toContain('aria-label="Ubah Melati"')
    expect(named).toContain('title="Ubah Melati"')
    expect(named).toContain('h-9 w-9')
    expect(renderToStaticMarkup(<IconButton aria-label="Hapus">x</IconButton>)).toContain('aria-label="Hapus"')
  })
})

describe('K2: dialogs and the import/export menu', () => {
  it('SlideOver and ConfirmDialog are opaque solid panels with a plain scrim', () => {
    const slide = renderToStaticMarkup(<SlideOver open onClose={noop} title="T">b</SlideOver>)
    expect(slide).toContain('surface-solid')
    expect(slide).toContain('bg-ink-900/30')
    expect(slide).not.toContain('backdrop-blur')
    const confirm = renderToStaticMarkup(<ConfirmDialog open title="Hapus Melati?" consequence="Tidak bisa dibatalkan." confirmLabel="Hapus" onCancel={noop} onConfirm={noop} />)
    expect(confirm).toContain('surface-solid')
    expect(confirm).not.toContain('backdrop-blur')
    expect(confirm.indexOf('Batal')).toBeLessThan(confirm.indexOf('>Hapus<'))
  })
  it('ImportExportMenu renders one closed disclosure button with an import input, and nothing without capabilities', () => {
    const both = renderToStaticMarkup(<ImportExportMenu onExport={noop} importKind="customers" />)
    expect(both).toContain('Impor / Ekspor')
    expect(both).toContain('aria-expanded="false"')
    expect(both).toContain('aria-label="Impor dari file CSV"')
    expect(both).not.toContain('Ekspor CSV')
    expect(renderToStaticMarkup(<ImportExportMenu />)).toBe('')
    expect(renderToStaticMarkup(<ImportExportMenu onExport={noop} />)).not.toContain('Impor dari file CSV')
  })
})

describe('G1: Kaca fidelity kit changes', () => {
  it('StatusBadge shows a decorative coloured dot before the word, and the dot is never the only cue', () => {
    const html = renderToStaticMarkup(<StatusBadge tone="ok" label="Selesai" />)
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*bg-current[^"]*"><\/span>Selesai/)
  })

  it.each([
    ['ok', 'ok', 'ok-bg'],
    ['warn', 'warn-strong', 'warn-bg'],
    ['danger', 'danger', 'danger-bg'],
    ['info', 'info', 'info-bg'],
    ['promo', 'promo', 'promo-bg'],
    ['reward', 'reward', 'reward-bg'],
    ['neutral', 'ink-700', 'paper-1'],
  ] as const)('the %s pill dot (currentColor = its word colour) clears 3:1 on its tint and its class is mapped', (tone, fg, bg) => {
    expect(TONE_CLASS[tone]).toContain(fg === 'warn-strong' ? 'text-warn-strong' : `text-${fg}`)
    expect(ratio(tokenHex(fg), tokenHex(bg))).toBeGreaterThanOrEqual(4.5)
  })

  it('Badge only draws the dot when asked', () => {
    expect(renderToStaticMarkup(<Badge tone="success">Admin</Badge>)).not.toContain('bg-current')
    expect(renderToStaticMarkup(<Badge tone="success" dot>Aktif</Badge>)).toContain('bg-current')
  })

  it('the secondary button is a filled paper tile with no border', () => {
    const html = renderToStaticMarkup(<Button variant="secondary">Batal</Button>)
    expect(html).toContain('bg-paper-1')
    expect(html).not.toContain('border')
  })

  it('Switch off track is light grey with an ink-500 edge ring', () => {
    const html = renderToStaticMarkup(<Switch checked={false} label="Aktif" onChange={noop} />)
    expect(html).toContain('bg-ink-900/15')
    expect(html).toContain('ring-ink-500')
  })

  it('field labels are sentence-case bold, not uppercase', () => {
    const html = renderToStaticMarkup(<Input label="Nama produk" />)
    expect(html).toContain('Nama produk')
    expect(html).not.toContain('uppercase')
  })

  it('PageHeader and EmptyState use readable ink tokens, not pale greys', () => {
    const html = renderToStaticMarkup(<PageHeader title="Produk" subtitle="Katalog" />)
    expect(html).not.toContain('gray-')
    expect(html).toContain('text-ink-700')
    expect(renderToStaticMarkup(<EmptyState icon={<Inbox />} title="Kosong" />)).not.toContain('gray-')
  })

  it('FilterBar sits on a group panel, chips are rounded tiles, and the active preset is pressed', () => {
    const from = presetRange('hari-ini')
    const html = renderToStaticMarkup(
      <FilterBar>
        <FilterBar.DateRange from={from.from} to={from.to} onChange={noop} presets={['hari-ini', '7-hari']} />
        <FilterBar.Chips items={[{ id: 'a', label: 'Semua', count: 312 }, { id: 'b', label: 'Aktif' }]} value="a" onChange={noop} />
      </FilterBar>,
    )
    expect(html).toContain('surface-group')
    expect(html).toContain('rounded-xl')
    expect(html).not.toContain('rounded-full')
    expect(html).toMatch(/aria-pressed="true"[^>]*>Hari ini</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>7 hari</)
    expect(html).toContain('>Dari<')
  })

  it('ConfirmDialog is 520 px wide with one button row when it has a third action', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open title="Keluar?" consequence="x" confirmLabel="Simpan & lanjut" cancelLabel="Tetap di sini" extra={{ label: 'Buang perubahan', tone: 'danger', onClick: noop }} onCancel={noop} onConfirm={noop} />,
    )
    expect(html).toContain('max-w-[520px]')
    expect(html).toContain('sm:flex-nowrap')
    expect(renderToStaticMarkup(<ConfirmDialog open title="T" consequence="x" confirmLabel="Ya" onCancel={noop} onConfirm={noop} />)).toContain('max-w-sm')
  })

  it('SlideOver is a floating rounded panel with a filled close square and a counted error summary', () => {
    const html = renderToStaticMarkup(
      <SlideOver open onClose={noop} title="Ubah" errorSummary={[{ fieldId: 'a', label: 'SKU' }, { fieldId: 'b', label: 'Harga' }]}>b</SlideOver>,
    )
    expect(html).toContain('fixed inset-0 flex justify-end p-3')
    expect(html).toContain('rounded-3xl')
    expect(html).not.toContain('rounded-l-3xl')
    expect(html).toContain('bg-paper-1 p-2')
    expect(html).toContain('2 kolom perlu diperbaiki:')
  })

  it('SaveBar is a floating card with a warn dot, and Batalkan is a filled secondary button', () => {
    const html = renderToStaticMarkup(<SaveBar count={2} items={['a', 'b']} status="idle" onSave={noop} onDiscard={noop} />)
    expect(html).toContain('rounded-2xl')
    expect(html).toContain('text-warn-strong')
    expect(html).toContain('2 perubahan belum disimpan')
    expect(html).not.toContain('-mx-6')
  })

  it('DataTable headers are uppercase grey, and rowHeight fixes the row height', () => {
    const html = renderToStaticMarkup(<DataTable caption="Daftar" columns={COLS} rows={ROWS} rowKey={(r) => r.id} rowHeight={52} />)
    expect(html).toContain('uppercase')
    expect(html).toContain('text-ink-500')
    expect(html).toContain('height:52px')
    expect(renderToStaticMarkup(<DataTable caption="Daftar" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />)).not.toContain('height:52px')
  })

  it('ink-500 header text clears AA on the white header cell', () => {
    expect(ratio(tokenHex('ink-500'), '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })
})
