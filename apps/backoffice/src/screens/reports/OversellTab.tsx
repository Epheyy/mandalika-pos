import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import type { OversellBreakdown, OversellRecord, OversellReport } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { exportToCSV } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { useToast } from '../../ui/Toast'
import { Badge } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { DataTable, type Column } from '../../ui/DataTable'
import { ExportButton } from '../../ui/ExportButton'
import { Input } from '../../ui/Field'
import { FilterBar } from '../../ui/FilterBar'
import { Switch } from '../../ui/Switch'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { PAGE_ONLY_SCHEMA, enumOf, isAnswerFor, pageOf, pageToClamp, totalPagesOf, uuidOf } from './reportFilters'
import { ReportPager } from './ReportPager'
import {
  KIND_FILTERS,
  OVERSELL_CHANGED,
  STATUS_FILTERS,
  channelLabel,
  collectOversellForExport,
  kindLabel,
  lineLabel,
  orderStatusLabel,
  oversellCsvRows,
  syncLagLabel,
} from './oversellLabels'

const LIMIT = 50
const NOTE_MAX = 500

interface OversellListState {
  status: string
  jenis: string
  produk: string
  kasir: string
  rentang: boolean
  hal: number
  [key: string]: string | number | boolean
}

const OVERSELL_SCHEMA: ListSchema<OversellListState> = {
  status: { key: 'status', default: 'open' },
  jenis: { key: 'jenis', default: '' },
  produk: { key: 'produk', default: '' },
  kasir: { key: 'kasir', default: '' },
  rentang: { key: 'rentang', default: false },
  hal: PAGE_ONLY_SCHEMA.hal,
}

const OVERSELL_KINDS = KIND_FILTERS.map((o) => o.id)
/** The status filter's "all" option is '' but its default is 'open', and a '' value never reaches the URL. */
const ALL_STATUS = 'semua'
const OVERSELL_STATUSES = ['open', 'acknowledged']

/** The status in force from the URL: 'open' (also for junk), 'acknowledged', or '' for "semua". */
function oversellStatusOf(raw: string): string {
  if (raw === ALL_STATUS) return ''
  return enumOf<string>(raw, OVERSELL_STATUSES, 'open')
}

const oversellStatusToQuery = (value: string): string => (value === '' ? ALL_STATUS : value)

/** A filtered option the report no longer lists (it was narrowed away) still shows, so the select matches the filter. */
function withKnown(options: ReadonlyArray<{ key: string; name: string }>, current: string): Array<{ key: string; name: string }> {
  if (current === '' || options.some((o) => o.key === current)) return [...options]
  return [...options, { key: current, name: current }]
}

interface OversellTabProps {
  dateFrom: string
  dateTo: string
  outletId: string
  canAcknowledge: boolean
  /** Tells the hub whether the date range applies, so it can disable its Dari/Sampai fields while it does not. */
  onRangeActiveChange?: (active: boolean) => void
}

const when = (iso: string) => format(parseISO(iso), 'dd MMM yyyy HH:mm', { locale: idLocale })

interface ColumnOptions {
  canAcknowledge: boolean
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  expanded: string | null
  onExpand: (id: string | null) => void
}

function oversellColumns({ canAcknowledge, selected, onToggle, expanded, onExpand }: ColumnOptions): Column<OversellRecord>[] {
  const pick: Column<OversellRecord>[] = canAcknowledge
    ? [
        {
          id: 'pilih',
          header: 'Pilih',
          width: 56,
          hideable: false,
          cell: (r) => (
            <input
              type="checkbox"
              aria-label={`Pilih ${r.orderNumber}`}
              disabled={!!r.acknowledgedAt}
              checked={selected.has(r.id)}
              onChange={() => onToggle(r.id)}
            />
          ),
        },
      ]
    : []
  return [
    ...pick,
    { id: 'waktu', header: 'Waktu jual', cell: (r) => <span className="whitespace-nowrap text-xs">{when(r.soldAt)}</span> },
    {
      id: 'order',
      header: 'No. transaksi',
      cell: (r) => (
        <button
          type="button"
          aria-expanded={expanded === r.id}
          title="Lihat detail baris"
          onClick={() => onExpand(expanded === r.id ? null : r.id)}
          className="rounded font-mono font-bold underline decoration-dotted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
        >
          {r.orderNumber}
        </button>
      ),
    },
    {
      id: 'produk',
      header: 'Produk',
      cell: (r) => (
        <>
          {lineLabel(r)}
          {r.kind !== 'shortage' && <span className="block text-[11px] text-danger">{kindLabel(r.kind)}</span>}
        </>
      ),
    },
    { id: 'qty', header: 'Qty', align: 'right', cell: (r) => r.quantity },
    { id: 'stok', header: 'Stok', align: 'right', cell: (r) => <span className="whitespace-nowrap">{r.stockBefore == null ? '—' : `${r.stockBefore} → ${r.stockAfter}`}</span> },
    { id: 'kurang', header: 'Kurang', align: 'right', cell: (r) => <span className="font-black text-danger">{r.shortfall}</span> },
    { id: 'kasir', header: 'Kasir', cell: (r) => r.cashierName },
    { id: 'jalur', header: 'Jalur', cell: (r) => <span className="text-xs">{channelLabel(r.channel)}</span> },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Badge tone={r.orderStatus === 'completed' || r.orderStatus === 'partially_refunded' ? 'neutral' : 'danger'}>{orderStatusLabel(r.orderStatus)}</Badge>
      ),
    },
    { id: 'cek', header: 'Cek', cell: (r) => (r.acknowledgedAt ? <Badge tone="success">Dicek</Badge> : <Badge tone="warning">Belum</Badge>) },
  ]
}

function OversellDetail({ row, sameOrder, onClose }: { row: OversellRecord; sameOrder: readonly OversellRecord[]; onClose: () => void }) {
  return (
    <Card className="space-y-1 px-5 py-4 text-xs text-ink-700">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-gray-900">Detail {row.orderNumber}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>Tutup</Button>
      </div>
      <p>Outlet: <b>{row.outletName}</b> · SKU: <b>{row.sku || '—'}</b> · Stok sekarang: <b>{row.currentStock ?? '—'}</b></p>
      <p>Dijual {when(row.soldAt)} · diterapkan server {when(row.recordedAt)} · jeda sinkron <b>{syncLagLabel(row.soldAt, row.recordedAt)}</b></p>
      <p>Shift: {row.shiftId ?? '—'} · Perangkat: {row.deviceId ?? '—'}</p>
      {row.acknowledgedAt && (
        <p>Dicek oleh <b>{row.acknowledgedByName ?? '—'}</b> pada {when(row.acknowledgedAt)}{row.acknowledgeNote ? ` — "${row.acknowledgeNote}"` : ''}</p>
      )}
      {sameOrder.length > 0 && (
        <p>Baris lain di transaksi ini (halaman ini): {sameOrder.map((x) => `${lineLabel(x)} (kurang ${x.shortfall})`).join('; ')}</p>
      )}
    </Card>
  )
}

/** Remembers every option seen so a narrowed filter does not shrink its own list. */
function useRememberedOptions(rows: ReadonlyArray<OversellBreakdown> | undefined) {
  const [seen, setSeen] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!rows?.length) return
    setSeen((prev) => {
      const next = { ...prev }
      for (const r of rows) next[r.key] = r.name
      return next
    })
  }, [rows])
  return useMemo(
    () => Object.entries(seen).sort((a, b) => a[1].localeCompare(b[1])).map(([key, name]) => ({ key, name })),
    [seen],
  )
}

/**
 * "Stok Minus" report (A44): every sale line that went short of stock, so an
 * auditor can tell a cashier or counting error from a late sync. An auditor marks a
 * line "sudah dicek" (optional note); the sidebar/tab badge counts unchecked lines.
 * Outlet scope rides the request header (outletId here is a refetch dependency only).
 */
export function OversellTab({ dateFrom, dateTo, outletId, canAcknowledge, onRangeActiveChange }: OversellTabProps) {
  // Filters and page are URL state (#/laporan/stok-minus?status=semua&jenis=shortage&hal=2).
  const [state, setState] = useListState(OVERSELL_SCHEMA)
  const status = oversellStatusOf(state.status)
  const kind = enumOf<string>(state.jenis, OVERSELL_KINDS, '')
  const productId = uuidOf(state.produk)
  const cashierId = uuidOf(state.kasir)
  // Off by default so the list matches the badge (all unchecked lines, any date).
  const useRange = state.rentang
  const page = pageOf(state.hal)
  useEffect(() => {
    onRangeActiveChange?.(useRange)
    return () => onRangeActiveChange?.(true)
  }, [useRange, onRangeActiveChange])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const toast = useToast()
  const [exportNote, setExportNote] = useState<string | null>(null)

  // A selection belongs to the list it was made in. (hal goes back to 1 in the patch that changes a filter.)
  useEffect(() => {
    setSelected(new Set())
  }, [status, kind, productId, cashierId, useRange, dateFrom, dateTo, outletId])

  const filters = {
    ...(useRange ? { dateFrom, dateTo } : {}),
    ...(status ? { status: status as 'open' | 'acknowledged' } : {}),
    ...(kind ? { kind: kind as 'shortage' } : {}),
    ...(productId ? { productId } : {}),
    ...(cashierId ? { cashierId } : {}),
  }
  const rq = usePolledQuery<OversellReport>(
    () => api.listOversellReport({ ...filters, page, limit: LIMIT }),
    [status, kind, productId, cashierId, useRange, dateFrom, dateTo, outletId, page],
  )
  const report = rq.data
  const rows = report?.data ?? []
  const summary = report?.summary
  const meta = report?.meta
  // A page past the end (the last open line acknowledged away, a stale link) moves to the last page.
  useEffect(() => {
    if (rq.loading || rq.error || !isAnswerFor(meta, page)) return
    if (!meta) return
    const target = pageToClamp(page, meta.total, meta.limit || LIMIT)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [rq.loading, rq.error, meta, page, setState])
  const productOptions = useRememberedOptions(summary?.byProduct)
  const cashierOptions = useRememberedOptions(summary?.byCashier)

  const openRows = rows.filter((r) => !r.acknowledgedAt)
  const allOpenSelected = openRows.length > 0 && openRows.every((r) => selected.has(r.id))
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const acknowledge = async () => {
    if (selected.size === 0 || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const count = await api.acknowledgeOversell([...selected], note.trim() || undefined)
      toast({ message: count > 0 ? `${count} baris ditandai sudah dicek` : 'Baris sudah dicek sebelumnya', tone: 'ok' })
      setSelected(new Set())
      setNote('')
      window.dispatchEvent(new Event(OVERSELL_CHANGED))
      await rq.refetch()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Gagal menandai sudah dicek')
    } finally {
      setBusy(false)
    }
  }

  // A failed export is shown by the ExportButton itself (it keeps the server's message); a cut-off export is a note here.
  const doExport = async () => {
    setExportNote(null)
    const { rows: all, truncated } = await collectOversellForExport((p, l) =>
      api.listOversellReport({ ...filters, page: p, limit: l }),
    )
    exportToCSV(oversellCsvRows(all), `stok-minus_${dateFrom}_${dateTo}`, { appendDate: false })
    if (truncated) setExportNote('Data terpotong: hanya 5.000 baris pertama yang diekspor. Persempit filter lalu ekspor lagi.')
  }

  const columns = oversellColumns({ canAcknowledge, selected, onToggle: toggle, expanded, onExpand: setExpanded })
  const expandedRow = expanded ? rows.find((r) => r.id === expanded) : undefined

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat value={summary?.lines ?? 0} label="Baris stok minus" />
        <Stat value={summary?.orders ?? 0} label="Transaksi" />
        <Stat value={summary?.totalShortfall ?? 0} label="Total kekurangan (unit)" />
        <Stat value={summary?.activeShortfall ?? 0} label="Masih berlaku" hint={`${summary?.reversedShortfall ?? 0} direfund`} />
        <Stat value={summary?.openCount ?? 0} label="Belum dicek" tone="warning" />
      </div>

      <div className="space-y-3">
        <FilterBar
          onReset={() => setState({ status: 'open', jenis: '', produk: '', kasir: '', rentang: false, hal: 1 })}
          activeCount={(status !== 'open' ? 1 : 0) + (kind ? 1 : 0) + (productId ? 1 : 0) + (cashierId ? 1 : 0) + (useRange ? 1 : 0)}
          actions={
            <ExportButton
              rowCount={meta ? meta.total : null}
              filterSummary={[useRange ? `${dateFrom} s/d ${dateTo}` : 'semua tanggal', status && `status ${STATUS_FILTERS.find((o) => o.id === status)?.label ?? status}`, kind && `jenis ${KIND_FILTERS.find((o) => o.id === kind)?.label ?? kind}`].filter(Boolean) as string[]}
              onExport={doExport}
            />
          }
        >
          <FilterBar.Select
            label="Status"
            value={status}
            onChange={(v) => setState({ status: oversellStatusToQuery(v), hal: 1 })}
            options={STATUS_FILTERS.map((o) => ({ value: o.id, label: o.label }))}
          />
          <FilterBar.Select label="Jenis" value={kind} onChange={(v) => setState({ jenis: v, hal: 1 })} options={KIND_FILTERS.map((o) => ({ value: o.id, label: o.label }))} />
          <FilterBar.Select
            label="Produk"
            value={productId}
            onChange={(v) => setState({ produk: v, hal: 1 })}
            options={[{ value: '', label: 'Semua produk' }, ...withKnown(productOptions, productId).map((o) => ({ value: o.key, label: o.name }))]}
          />
          <FilterBar.Select
            label="Kasir"
            value={cashierId}
            onChange={(v) => setState({ kasir: v, hal: 1 })}
            options={[{ value: '', label: 'Semua kasir' }, ...withKnown(cashierOptions, cashierId).map((o) => ({ value: o.key, label: o.name }))]}
          />
        </FilterBar>
        <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-paper-0 px-3 py-2">
          <Switch checked={useRange} offClassName="bg-paper-2" onChange={(on) => setState({ rentang: on, hal: 1 })} label="Ikuti rentang tanggal" />
          <div>
            <p className="text-sm font-bold text-gray-900">Ikuti rentang tanggal</p>
            <p className="text-xs text-ink-700">
              {useRange
                ? `Hanya ${dateFrom} s/d ${dateTo}. Angka di sidebar tetap menghitung semua tanggal.`
                : 'Mati: semua tanggal, sama dengan angka di sidebar.'}
            </p>
          </div>
        </div>
        {exportNote && <p role="status" className="text-xs text-warn-strong">{exportNote}</p>}
        <p className="text-[11px] text-ink-700">
          Stok sebelum/sesudah adalah saldo server saat penjualan diterapkan, bukan angka di layar tablet.
          Penjualan offline yang terlambat sinkron bisa tercatat kurang karena penjualan lain di antaranya;
          lihat kolom jeda sinkron sebelum menyimpulkan kesalahan kasir.
        </p>
      </div>


      {(summary?.byProduct.length ?? 0) > 0 && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Breakdown title="Per produk" rows={summary?.byProduct ?? []} showSize />
          <Breakdown title="Per kasir" rows={summary?.byCashier ?? []} />
        </div>
      )}

      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}

      {canAcknowledge && selected.size > 0 && (
        <Card className="sticky bottom-3 z-20 p-4 flex flex-wrap items-end gap-3 border-brand-strong shadow-lg">
          <div className="flex-1 min-w-56">
            <Input
              label={`Catatan (opsional, ${selected.size} baris dipilih)`}
              value={note}
              maxLength={NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              placeholder="mis. botol ada di rak, salah hitung"
            />
          </div>
          <Button loading={busy} onClick={() => void acknowledge()}>Tandai sudah dicek</Button>
        </Card>
      )}

      {canAcknowledge && openRows.length > 0 && (
        <label className="flex items-center gap-2 text-xs font-bold text-ink-700">
          <input
            type="checkbox"
            aria-label="Pilih semua yang belum dicek"
            checked={allOpenSelected}
            onChange={() => setSelected(allOpenSelected ? new Set() : new Set(openRows.map((r) => r.id)))}
          />
          Pilih semua yang belum dicek
        </label>
      )}

      {expandedRow && (
        <OversellDetail
          row={expandedRow}
          sameOrder={rows.filter((x) => x.orderId === expandedRow.orderId && x.id !== expandedRow.id)}
          onClose={() => setExpanded(null)}
        />
      )}

      <DataTable
        caption="Baris stok minus"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey={expanded}
        loading={rq.loading && !rq.data}
        error={rq.error ? `Gagal memuat laporan stok minus. ${rq.error}` : null}
        onRetry={() => void rq.refetch()}
        empty={<EmptyState icon={<AlertTriangle />} title="Tidak ada baris stok minus pada filter ini" />}
        footer={meta && totalPagesOf(meta.total, meta.limit || LIMIT) > 1 ? <ReportPager page={page} total={meta.total} limit={meta.limit || LIMIT} onChange={(p) => setState({ hal: p })} /> : undefined}
      />


    </div>
  )
}

function Stat({ value, label, hint, tone }: { value: number; label: string; hint?: string; tone?: 'warning' }) {
  return (
    <Card className="p-4">
      <p className={`text-xl font-black ${tone === 'warning' && value > 0 ? 'text-warn-strong' : 'text-gray-900'}`}>{value.toLocaleString('id-ID')}</p>
      <p className="text-xs text-ink-500">{label}</p>
      {hint && <p className="text-[11px] text-ink-500">{hint}</p>}
    </Card>
  )
}

function Breakdown({ title, rows, showSize }: { title: string; rows: ReadonlyArray<OversellBreakdown>; showSize?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-black text-ink-500 uppercase tracking-wider mb-2">{title}</p>
      <ul className="divide-y divide-gray-50">
        {rows.slice(0, 8).map((r) => (
          <li key={`${r.key}-${r.variantSize ?? ''}`} className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-gray-900 truncate">{r.name}{showSize && r.variantSize ? ` · ${r.variantSize}` : ''}</span>
            <span className="text-ink-700 whitespace-nowrap ml-3">{r.lines} baris · <b className="text-danger">{r.shortfall}</b> unit</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
