import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { MovementSku, StockMovementPage, StockMovementParams, StockMovementRow, WarehouseStockRow } from '@mandalika/api'
import { PackagePlus, Search, SlidersHorizontal, X } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { localDay } from '../../lib/businessDay'
import { downloadCsvText } from '../../lib/csvUtils'
import { LEDGER_BUCKET, LEDGER_ERP_STATUS, LEDGER_KIND } from '../../lib/labels/ledger'
import { labelOf } from '../../lib/labels/types'
import { useListState } from '../../lib/router/useListState'
import { useDismiss } from '../../shell/useDismiss'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ExportButton } from '../../ui/ExportButton'
import { FilterBar } from '../../ui/FilterBar'
import { StatusBadge } from '../../ui/StatusBadge'
import { KIND_GROUPS, daysAgoDay, formatMovementTime, isRecordedLate, movementKindTone, refTypeLabel, signedQty } from './stockCardFormat'
import {
  KARTU_SCHEMA,
  decodeSku,
  encodeSku,
  parseJenis,
  rememberSkuLabel,
  rememberedSkuLabel,
  serializeJenis,
  withGroupSelection,
  type SkuRef,
} from './kartuStokUrl'
import { useLocationParam } from './useLocationParam'
import type { LocationType } from './useLocations'
import { DocumentModal } from './DocumentModal'
import { docRefOf, refundLabel, type DocRef } from './documentRef'
import { GoodsInSlideOver } from '../warehouses/GoodsInSlideOver'
import { AdjustSlideOver } from '../warehouses/AdjustSlideOver'

const PAGE = 50

type PanelLocation = { kind: LocationType; id: string; name: string }

function skuLabel(r: { productName?: string; variantSize: string; sku?: string }): string {
  return `${r.productName ?? '—'} · ${r.variantSize}${r.sku ? ` (${r.sku})` : ''}`
}

const KIND_ITEMS = (kinds: readonly string[]) => kinds.map((k) => ({ id: k, label: labelOf(LEDGER_KIND, k).label }))

/** Kartu Stok: the ledger of one location (and, once picked, one SKU), as `#/inventori/stok/kartu-stok?...`. */
export function StockCard({ exportSlot }: { exportSlot?: HTMLElement | null }) {
  const [state, setState] = useListState(KARTU_SCHEMA)
  const loc = useLocationParam(state.lokasi)
  const sku = useMemo(() => decodeSku(state.sku), [state.sku])
  const fromDay = state.dari || daysAgoDay(30)
  const toDay = state.sampai || localDay()
  const jenis = useMemo(() => parseJenis(state.jenis), [state.jenis])

  const [rows, setRows] = useState<StockMovementRow[]>([])
  const [summary, setSummary] = useState<StockMovementPage['summary']>(undefined)
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const { user } = useAuth()
  const canReadOrders = user?.role === 'admin' || (user?.permissions ?? []).some((p) => p === 'view_reports' || p === 'view_transactions')
  const [doc, setDoc] = useState<DocRef | null>(null)
  // The two shortcuts act on the SKU's LIVE stock row (not the card's range saldo).
  // The location is captured with the row: browser Back can change the card's location under an open panel.
  const [shortcut, setShortcut] = useState<{ kind: 'adjust' | 'receive'; row: WarehouseStockRow; where: PanelLocation } | null>(null)
  const [shortcutBusy, setShortcutBusy] = useState(false)
  const [shortcutError, setShortcutError] = useState<string | null>(null)

  const params = useCallback((): StockMovementParams | null => {
    if (!loc.location) return null
    return {
      locationType: loc.location.type,
      locationId: loc.location.id,
      productId: sku?.productId,
      variantSize: sku?.variantSize,
      kind: jenis.kinds.length ? [...jenis.kinds] : undefined,
      flag: jenis.shortage ? 'shortage' : undefined,
      giveaway: jenis.giveaway ? true : undefined,
      from: fromDay,
      to: toDay,
    }
  }, [loc.location, sku, jenis, fromDay, toDay])

  const load = useCallback(
    async (cursor?: string) => {
      const base = params()
      if (!base) return
      const mine = ++generation.current
      setLoading(true)
      setError(null)
      if (!cursor) {
        // Never leave rows of another filter (or another SKU) under the new heading while this loads.
        setRows([])
        setNextCursor(undefined)
        setSummary(undefined)
      }
      try {
        const page = await api.listStockMovements({ ...base, limit: PAGE, cursor })
        if (mine !== generation.current) return
        setRows((prev) => (cursor ? [...prev, ...page.data] : page.data))
        setNextCursor(page.nextCursor)
        if (!cursor) setSummary(page.summary)
      } catch (e) {
        if (mine === generation.current) setError(e instanceof Error ? e.message : 'Gagal memuat kartu stok')
      } finally {
        if (mine === generation.current) setLoading(false)
      }
    },
    [params],
  )

  useEffect(() => {
    void load()
  }, [load])

  const exportCsv = async () => {
    const base = params()
    if (!base) return
    const text = await api.exportStockMovements(base)
    downloadCsvText(text, `kartu-stok_${fromDay}_${toDay}.csv`)
  }

  const openShortcut = async (kind: 'adjust' | 'receive') => {
    if (!loc.location || !sku) return
    setShortcutBusy(true)
    setShortcutError(null)
    const where: PanelLocation = { kind: loc.location.type, id: loc.location.id, name: locName }
    try {
      const stock = await api.getTransferLocationStock(where.kind, where.id)
      const row = stock.find((r) => r.productId === sku.productId && r.variantSize === sku.variantSize)
      if (!row) throw new Error('SKU ini belum punya baris stok di lokasi ini.')
      setShortcut({ kind, row, where })
    } catch (e) {
      setShortcutError(e instanceof Error ? e.message : 'Gagal memuat stok')
    } finally {
      setShortcutBusy(false)
    }
  }

  const locName = loc.location
    ? ([...loc.outlets, ...loc.warehouses].find((l) => l.id === loc.location?.id)?.name ?? '')
    : ''

  // The URL carries ids only: the name comes from the pick that opened the card, else from a loaded row.
  const named = rows.find((r) => sku && r.productId === sku.productId && r.variantSize === sku.variantSize)
  const pickedLabel = sku ? (rememberedSkuLabel(sku) ?? (named ? skuLabel(named) : `SKU ${sku.variantSize}`)) : ''

  const pickSku = (r: MovementSku) => {
    const ref: SkuRef = { productId: r.productId, variantSize: r.variantSize }
    rememberSkuLabel(ref, skuLabel(r))
    setState({ sku: encodeSku(ref) })
  }

  const activeCount = [state.lokasi, state.sku, state.dari, state.sampai, state.jenis].filter((v) => v !== '').length

  const exportButton = (
    <ExportButton
      rowCount={null}
      filterSummary={[`Rentang ${fromDay} s/d ${toDay}`, ...(sku ? [pickedLabel] : ['Semua SKU'])]}
      disabled={!loc.location}
      onExport={exportCsv}
    />
  )

  return (
    <div className="space-y-4">
      {/* The download lives in the page header (portal) when the host gives a slot; otherwise it sits in the filter row. */}
      {exportSlot && createPortal(exportButton, exportSlot)}
      <div className="space-y-4">
        <FilterBar
          onReset={() => setState({ lokasi: '', sku: '', dari: '', sampai: '', jenis: '' })}
          activeCount={activeCount}
          actions={exportSlot ? undefined : exportButton}
        >
          <SkuCombobox
            locationType={loc.location?.type}
            locationId={loc.location?.id}
            pickedLabel={sku ? pickedLabel : null}
            onPick={pickSku}
            onClear={() => setState({ sku: '' })}
          />
          <FilterBar.Select
            label="Lokasi"
            value={loc.locationKey}
            onChange={(key) => setState({ lokasi: key, sku: '' })}
            options={[
              { value: '', label: 'Pilih lokasi...' },
              ...loc.outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
              ...loc.warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
            ]}
          />
          <FilterBar.DateRange
            from={fromDay}
            to={toDay}
            presets={['hari-ini', '7-hari', '30-hari', 'bulan-ini']}
            onChange={(r) => {
              if (r.from && r.to) setState({ dari: r.from, sampai: r.to })
            }}
          />
        </FilterBar>

        <p className="text-xs text-ink-700">
          Rentang tanggal mengikuti waktu tercatat. Waktu Kejadian di tabel adalah saat barang bergerak.
        </p>

        <div role="group" aria-label="Filter jenis" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {KIND_GROUPS.map((g) => {
            const ids = g.bucket === 'hadiah' ? ['hadiah'] : [...g.kinds]
            const items = g.bucket === 'hadiah' ? [{ id: 'hadiah', label: LEDGER_BUCKET.hadiah.label }] : KIND_ITEMS(g.kinds)
            const redundant = items.length === 1 && items[0].label === LEDGER_BUCKET[g.bucket].label
            return (
              <div key={g.bucket} className="flex items-center gap-2">
                {!redundant && <span className="text-[13px] font-bold text-ink-700">{LEDGER_BUCKET[g.bucket].label}:</span>}
                <FilterBar.Chips
                  multiple
                  label={LEDGER_BUCKET[g.bucket].label}
                  items={items}
                  value={[...jenis.kinds.filter((k) => ids.includes(k)), ...(g.bucket === 'hadiah' && jenis.giveaway ? ['hadiah'] : [])]}
                  onChange={(next) => setState({ jenis: serializeJenis(withGroupSelection(jenis, ids, next)) })}
                />
              </div>
            )
          })}
          <FilterBar.Chips
            multiple
            label="Tanda"
            items={[{ id: 'minus', label: 'Minus' }]}
            value={jenis.shortage ? ['minus'] : []}
            onChange={(next) => setState({ jenis: serializeJenis(withGroupSelection(jenis, ['minus'], next)) })}
          />
        </div>

        <details className="text-xs text-ink-700">
          <summary className="w-fit cursor-pointer rounded font-bold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong">
            Arti jenis gerakan
          </summary>
          <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {KIND_GROUPS.map((g) => (
              <div key={g.bucket} className="flex gap-2">
                <dt className="font-bold">{LEDGER_BUCKET[g.bucket].label}</dt>
                <dd>{LEDGER_BUCKET[g.bucket].hint}</dd>
              </div>
            ))}
          </dl>
        </details>

        {sku && summary && <SaldoHeader label={pickedLabel} summary={summary} />}
        {sku && loc.location && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<SlidersHorizontal className="h-4 w-4" />} loading={shortcutBusy} onClick={() => void openShortcut('adjust')}>
              Tambah penyesuaian
            </Button>
            <Button variant="secondary" icon={<PackagePlus className="h-4 w-4" />} loading={shortcutBusy} onClick={() => void openShortcut('receive')}>
              Tambah barang masuk
            </Button>
          </div>
        )}
        {shortcutError && <p role="alert" className="text-sm text-danger">{shortcutError}</p>}
        {!sku && loc.location && (
          <p className="text-xs text-ink-700">Pilih satu SKU di filter untuk melihat saldo awal, total masuk/keluar, dan saldo akhir.</p>
        )}

        <DataTable
          caption="Kartu stok"
          columns={movementColumns({ zone: loc.zone, showProduct: !sku, canReadOrders, onOpenDoc: setDoc })}
          rows={rows}
          rowKey={(m) => m.id}
          rowHeight={ROW_HEIGHT}
          loading={loading && rows.length === 0}
          error={error}
          onRetry={() => void load()}
          empty={<EmptyState icon={<Search />} title="Tidak ada pergerakan stok untuk filter ini" />}
          footer={
            nextCursor ? (
              <div className="flex justify-center">
                <Button variant="secondary" loading={loading} onClick={() => void load(nextCursor)}>
                  Muat lebih banyak
                </Button>
              </div>
            ) : undefined
          }
        />
      </div>

      {doc && <DocumentModal doc={doc} zone={loc.zone} onClose={() => setDoc(null)} />}
      {shortcut && shortcut.kind === 'adjust' && (
        <AdjustSlideOver
          location={shortcut.where}
          row={shortcut.row}
          onClose={() => setShortcut(null)}
          onDone={() => load()}
        />
      )}
      {shortcut && shortcut.kind === 'receive' && (
        <GoodsInSlideOver
          open
          location={shortcut.where}
          rows={[shortcut.row]}
          onClose={() => setShortcut(null)}
          onDone={() => load()}
        />
      )}
    </div>
  )
}

interface MovementColumnsInput {
  zone: string
  showProduct: boolean
  canReadOrders: boolean
  onOpenDoc: (d: DocRef) => void
}

const nowrap = 'whitespace-nowrap'
/** Even ledger rows like the mock (about 50 px); a row with a document sub-line may grow past it. */
const ROW_HEIGHT = 52

/** The 13 ledger columns. Waktu Kejadian and Jenis lead and stay in view while the table scrolls sideways;
 *  Waktu Tercatat sits with the notes (a sticky column has to be one of the leading ones). */
function movementColumns({ zone, showProduct, canReadOrders, onOpenDoc }: MovementColumnsInput): Column<StockMovementRow>[] {
  return [
    {
      id: 'kejadian',
      header: 'Waktu Kejadian',
      sticky: true,
      width: 190,
      cell: (m) => <span className={nowrap}>{formatMovementTime(m.occurredAt, zone)}</span>,
    },
    {
      id: 'jenis',
      header: 'Jenis',
      sticky: true,
      width: 150,
      cell: (m) => <StatusBadge tone={movementKindTone(m.kind)} label={labelOf(LEDGER_KIND, m.kind).label} className={nowrap} />,
    },
    ...(showProduct
      ? [
          {
            id: 'produk',
            header: 'Produk',
            cell: (m: StockMovementRow) => (
              <span className={nowrap}>
                {m.productName ?? '—'} · {m.variantSize}
                {m.sku ? ` (${m.sku})` : ''}
              </span>
            ),
          } satisfies Column<StockMovementRow>,
        ]
      : []),
    {
      id: 'dokumen',
      header: 'Dokumen',
      cell: (m) => {
        const doc = docRefOf(m, canReadOrders)
        const text = m.kind === 'refund' ? refundLabel(m) : (m.refNumber ?? refTypeLabel(m.refType))
        return (
          <div className={nowrap}>
            {doc ? (
              <button type="button" className="text-gold-700 underline underline-offset-2 hover:text-gold-900" onClick={() => onOpenDoc(doc)}>
                {text}
              </button>
            ) : (
              <span>{text}</span>
            )}
            {m.docNumber && <span className="block text-xs text-ink-700">{m.docNumber}</span>}
            {m.requisitionNumber && <span className="block text-xs text-ink-700">dari {m.requisitionNumber}</span>}
          </div>
        )
      },
    },
    { id: 'masuk', header: 'Masuk', align: 'right', cell: (m) => <span className="font-bold text-ok">{m.qty > 0 ? signedQty(m.qty) : ''}</span> },
    { id: 'keluar', header: 'Keluar', align: 'right', cell: (m) => <span className="font-bold text-danger">{m.qty < 0 ? signedQty(m.qty) : ''}</span> },
    { id: 'saldo', header: 'Saldo', align: 'right', cell: (m) => <span className="font-black">{m.qtyAfter}</span> },
    { id: 'oleh', header: 'Oleh', cell: (m) => <span className={nowrap}>{m.actorName ?? ''}</span> },
    { id: 'penyetuju', header: 'Penyetuju', cell: (m) => <span className={nowrap}>{m.approvedByName ?? ''}</span> },
    { id: 'alasan', header: 'Alasan', cell: (m) => m.reasonText ?? '' },
    {
      id: 'tanda',
      header: 'Tanda',
      cell: (m) => (
        <span className="flex gap-1 whitespace-nowrap">
          {m.isGiveaway && <StatusBadge tone="reward" label="Hadiah" />}
          {m.isWarranty && <StatusBadge tone="info" label="Garansi" />}
          {m.flags.includes('shortage') && <StatusBadge tone="danger" label="Minus" />}
          {isRecordedLate(m.occurredAt, m.recordedAt, zone) && <StatusBadge tone="warn" label="Tercatat terlambat" />}
        </span>
      ),
    },
    {
      id: 'tercatat',
      header: 'Waktu Tercatat',
      cell: (m) => <span className={`${nowrap} text-ink-700`}>{formatMovementTime(m.recordedAt, zone)}</span>,
    },
    {
      id: 'erp',
      header: 'ERP',
      cell: (m) => (m.erpStatus ? <StatusBadge map={LEDGER_ERP_STATUS} value={m.erpStatus} /> : ''),
    },
  ]
}

function SaldoHeader({ label, summary }: { label: string; summary: NonNullable<StockMovementPage['summary']> }) {
  const cells: Array<[string, number]> = [
    ['Saldo Awal', summary.opening],
    ['Total Masuk', summary.totalIn],
    ['Total Keluar', summary.totalOut],
    ['Saldo Akhir', summary.closing],
  ]
  return (
    <Card className="p-4">
      <p className="text-sm font-bold text-gray-900 mb-3">{label}</p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cells.map(([name, value]) => (
          <div key={name}>
            <dt className="text-xs font-black text-ink-700">{name}</dt>
            <dd className="text-xl font-black text-gray-900">{value.toLocaleString('id-ID')}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

interface SkuComboboxProps {
  locationType: LocationType | undefined
  locationId: string | undefined
  /** The picked SKU's name, or null when no SKU is picked. */
  pickedLabel: string | null
  onPick: (s: MovementSku) => void
  onClear: () => void
}

/** The SKU filter: the picked SKU as a removable pill, or a search over the SKUs that have ledger history at the
 *  location. The endpoint answers nothing for an empty query and at most a few rows, so it is search-driven. */
function SkuCombobox({ locationType, locationId, pickedLabel, onPick, onClear }: SkuComboboxProps) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<MovementSku[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const q = text.trim()
    if (!locationType || !locationId || q.length < 2) {
      setResults([])
      setStatus('idle')
      setActive(-1)
      return
    }
    let stale = false
    setStatus('loading')
    setActive(-1)
    const t = setTimeout(() => {
      api
        .listMovementSkus({ locationType, locationId, q })
        .then((r) => {
          if (stale) return
          setResults(r.data)
          setActive(-1)
          setStatus('done')
        })
        .catch(() => {
          if (stale) return
          setResults([])
          setActive(-1)
          setStatus('error')
        })
    }, 300)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [text, locationType, locationId])

  useDismiss(open, () => setOpen(false), root)

  const pick = (r: MovementSku) => {
    onPick(r)
    setText('')
    setResults([])
    setStatus('idle')
    setActive(-1)
    setOpen(false)
  }
  const optionId = (i: number) => `${listId}-opt-${i}`
  const listVisible = pickedLabel === null && open && status !== 'idle'
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.length === 0) return
      e.preventDefault()
      setOpen(true)
      const down = e.key === 'ArrowDown'
      setActive((i) => (down ? (i + 1) % results.length : i <= 0 ? results.length - 1 : i - 1))
    } else if (e.key === 'Enter' && listVisible && active >= 0 && results[active]) {
      e.preventDefault()
      pick(results[active])
    }
  }

  return (
    <div ref={root} className="relative">
      <div className="flex h-10 w-72 items-center gap-1.5 rounded-xl border border-paper-2 bg-white pl-3 pr-1 text-[13px] focus-within:ring-2 focus-within:ring-brand-strong">
        <span aria-hidden="true" className="flex-shrink-0 text-ink-500">
          SKU:
        </span>
        {pickedLabel !== null ? (
          <>
            <span className="min-w-0 flex-1 truncate font-bold text-ink-900" title={pickedLabel}>
              {pickedLabel}
            </span>
            <IconButton label="Hapus pilihan SKU" onClick={() => {
                onClear()
                requestAnimationFrame(() => inputRef.current?.focus())
              }}>
              <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </>
        ) : (
          <input
            ref={inputRef}
            id="kartu-sku"
            type="search"
            role="combobox"
            aria-label="SKU / barcode / nama"
            aria-autocomplete="list"
            aria-expanded={listVisible && results.length > 0}
            aria-controls={listVisible && results.length > 0 ? listId : undefined}
            aria-activedescendant={listVisible && active >= 0 ? optionId(active) : undefined}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Semua SKU: ketik untuk memilih"
            className="h-full min-w-0 flex-1 bg-transparent font-bold text-ink-900 placeholder:font-normal focus:outline-none"
          />
        )}
      </div>
      {listVisible && status !== 'done' && results.length === 0 && (
        <p
          role={status === 'error' ? 'alert' : 'status'}
          className={`absolute left-0 top-full z-20 mt-1 w-full min-w-72 rounded-xl border border-paper-2 bg-white px-3 py-2 text-[13px] shadow-lg ${status === 'error' ? 'text-danger' : 'text-ink-700'}`}
        >
          {status === 'error' ? 'Gagal memuat SKU. Coba lagi.' : 'Mencari SKU...'}
        </p>
      )}
      {listVisible && status === 'done' && results.length === 0 && (
        <p role="status" className="absolute left-0 top-full z-20 mt-1 w-full min-w-72 rounded-xl border border-paper-2 bg-white px-3 py-2 text-[13px] text-ink-700 shadow-lg">
          Tidak ada SKU yang cocok.
        </p>
      )}
      {listVisible && results.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Hasil SKU" className="absolute left-0 top-full z-20 mt-1 max-h-72 w-full min-w-72 overflow-auto rounded-xl border border-paper-2 bg-white py-1 shadow-lg">
          {results.map((r, i) => (
            <li
              key={`${r.productId}|${r.variantSize}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={`flex h-10 w-full cursor-pointer items-center px-3 text-left text-[13px] text-ink-900 hover:bg-paper-1 ${i === active ? 'bg-paper-1' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
            >
              {skuLabel(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
