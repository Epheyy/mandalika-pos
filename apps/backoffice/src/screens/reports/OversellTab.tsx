import { Fragment, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import type { OversellBreakdown, OversellReport } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { exportToCSV } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { Badge } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Input, Select } from '../../ui/Field'
import { Switch } from '../../ui/Switch'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { PAGE_ONLY_SCHEMA, enumOf, isAnswerFor, pageOf, pageToClamp, uuidOf } from './reportFilters'
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
}

const when = (iso: string) => format(parseISO(iso), 'dd MMM yyyy HH:mm', { locale: idLocale })

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
export function OversellTab({ dateFrom, dateTo, outletId, canAcknowledge }: OversellTabProps) {
  // Filters and page are URL state (#/laporan/stok-minus?status=semua&jenis=shortage&hal=2).
  const [state, setState] = useListState(OVERSELL_SCHEMA)
  const status = oversellStatusOf(state.status)
  const kind = enumOf<string>(state.jenis, OVERSELL_KINDS, '')
  const productId = uuidOf(state.produk)
  const cashierId = uuidOf(state.kasir)
  // Off by default so the list matches the badge (all unchecked lines, any date).
  const useRange = state.rentang
  const page = pageOf(state.hal)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
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
  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / (meta.limit || LIMIT))) : 1
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
      await api.acknowledgeOversell([...selected], note.trim() || undefined)
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

  const doExport = async () => {
    setExportNote(null)
    try {
      const { rows: all, truncated } = await collectOversellForExport((p, l) =>
        api.listOversellReport({ ...filters, page: p, limit: l }),
      )
      exportToCSV(oversellCsvRows(all), `stok-minus_${dateFrom}_${dateTo}`, { appendDate: false })
      if (truncated) setExportNote('Data terpotong: hanya 5.000 baris pertama yang diekspor. Persempit filter lalu ekspor lagi.')
    } catch (e: unknown) {
      setExportNote(e instanceof Error ? e.message : 'Unduhan gagal')
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat value={summary?.lines ?? 0} label="Baris stok minus" />
        <Stat value={summary?.orders ?? 0} label="Transaksi" />
        <Stat value={summary?.totalShortfall ?? 0} label="Total kekurangan (unit)" />
        <Stat value={summary?.activeShortfall ?? 0} label="Masih berlaku" hint={`${summary?.reversedShortfall ?? 0} direfund`} />
        <Stat value={summary?.openCount ?? 0} label="Belum dicek" tone="warning" />
      </div>

      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Select label="Status" value={status} onChange={(e) => setState({ status: oversellStatusToQuery(e.target.value), hal: 1 })}>
            {STATUS_FILTERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
          <Select label="Jenis" value={kind} onChange={(e) => setState({ jenis: e.target.value, hal: 1 })}>
            {KIND_FILTERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
          <Select label="Produk" value={productId} onChange={(e) => setState({ produk: e.target.value, hal: 1 })}>
            <option value="">Semua produk</option>
            {withKnown(productOptions, productId).map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
          </Select>
          <Select label="Kasir" value={cashierId} onChange={(e) => setState({ kasir: e.target.value, hal: 1 })}>
            <option value="">Semua kasir</option>
            {withKnown(cashierOptions, cashierId).map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-paper-0 px-3 py-2">
            <Switch checked={useRange} onChange={(on) => setState({ rentang: on, hal: 1 })} label="Ikuti rentang tanggal" />
            <div>
              <p className="text-sm font-bold text-gray-900">Ikuti rentang tanggal</p>
              <p className="text-xs text-ink-700">
                {useRange
                  ? `Hanya ${dateFrom} s/d ${dateTo}. Angka di sidebar tetap menghitung semua tanggal.`
                  : 'Mati: semua tanggal, sama dengan angka di sidebar.'}
              </p>
            </div>
          </div>
          <Button variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => void doExport()}>
            Unduh CSV
          </Button>
        </div>
        {exportNote && <p role="status" className="text-xs text-amber-700">{exportNote}</p>}
        <p className="text-[11px] text-gray-400">
          Stok sebelum/sesudah adalah saldo server saat penjualan diterapkan, bukan angka di layar tablet.
          Penjualan offline yang terlambat sinkron bisa tercatat kurang karena penjualan lain di antaranya;
          lihat kolom jeda sinkron sebelum menyimpulkan kesalahan kasir.
        </p>
      </Card>

      {(summary?.byProduct.length ?? 0) > 0 && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Breakdown title="Per produk" rows={summary?.byProduct ?? []} showSize />
          <Breakdown title="Per kasir" rows={summary?.byCashier ?? []} />
        </div>
      )}

      {rq.error && <p role="alert" className="text-sm text-red-600">{rq.error}</p>}
      {actionError && <p role="alert" className="text-sm text-red-600">{actionError}</p>}

      {canAcknowledge && selected.size > 0 && (
        <Card className="p-4 flex flex-wrap items-end gap-3 border-gold-200">
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

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<AlertTriangle />} title={rq.loading ? 'Memuat…' : 'Tidak ada baris stok minus pada filter ini'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {canAcknowledge && (
                    <th className="px-4 py-3 w-8">
                      <input
                        type="checkbox"
                        aria-label="Pilih semua yang belum dicek"
                        checked={allOpenSelected}
                        disabled={openRows.length === 0}
                        onChange={() => setSelected(allOpenSelected ? new Set() : new Set(openRows.map((r) => r.id)))}
                      />
                    </th>
                  )}
                  {['Waktu jual', 'No. transaksi', 'Produk', 'Qty', 'Stok', 'Kurang', 'Kasir', 'Jalur', 'Status', 'Cek'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const sameOrder = rows.filter((x) => x.orderId === r.orderId && x.id !== r.id)
                  return (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                        {canAcknowledge && (
                          <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Pilih ${r.orderNumber}`}
                              disabled={!!r.acknowledgedAt}
                              checked={selected.has(r.id)}
                              onChange={() => toggle(r.id)}
                            />
                          </td>
                        )}
                        <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{when(r.soldAt)}</td>
                        <td className="px-4 py-3 text-sm font-mono font-bold text-gray-900">{r.orderNumber}</td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {lineLabel(r)}
                          {r.kind !== 'shortage' && <span className="block text-[11px] text-red-600">{kindLabel(r.kind)}</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">{r.quantity}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                          {r.stockBefore == null ? '—' : `${r.stockBefore} → ${r.stockAfter}`}
                        </td>
                        <td className="px-4 py-3 text-sm font-black text-red-600">{r.shortfall}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.cashierName}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{channelLabel(r.channel)}</td>
                        <td className="px-4 py-3">
                          <Badge tone={r.orderStatus === 'completed' || r.orderStatus === 'partially_refunded' ? 'neutral' : 'danger'}>{orderStatusLabel(r.orderStatus)}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          {r.acknowledgedAt ? <Badge tone="success">Dicek</Badge> : <Badge tone="warning">Belum</Badge>}
                        </td>
                      </tr>
                      {expanded === r.id && (
                        <tr className="bg-gray-50">
                          <td colSpan={canAcknowledge ? 11 : 10} className="px-5 py-4 text-xs text-gray-600 space-y-1">
                            <p>Outlet: <b>{r.outletName}</b> · SKU: <b>{r.sku || '—'}</b> · Stok sekarang: <b>{r.currentStock ?? '—'}</b></p>
                            <p>Dijual {when(r.soldAt)} · diterapkan server {when(r.recordedAt)} · jeda sinkron <b>{syncLagLabel(r.soldAt, r.recordedAt)}</b></p>
                            <p>Shift: {r.shiftId ?? '—'} · Perangkat: {r.deviceId ?? '—'}</p>
                            {r.acknowledgedAt && (
                              <p>Dicek oleh <b>{r.acknowledgedByName ?? '—'}</b> pada {when(r.acknowledgedAt)}{r.acknowledgeNote ? ` — "${r.acknowledgeNote}"` : ''}</p>
                            )}
                            {sameOrder.length > 0 && (
                              <p>Baris lain di transaksi ini (halaman ini): {sameOrder.map((x) => `${lineLabel(x)} (kurang ${x.shortfall})`).join('; ')}</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {meta && meta.total > LIMIT && (
        <div className="flex items-center justify-between px-1">
          <p className="text-xs text-gray-400">Halaman {meta.page} dari {totalPages} · {meta.total} baris</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setState({ hal: Math.max(1, page - 1) })}>Sebelumnya</Button>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setState({ hal: page + 1 })}>Berikutnya</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ value, label, hint, tone }: { value: number; label: string; hint?: string; tone?: 'warning' }) {
  return (
    <Card className="p-4">
      <p className={`text-xl font-black ${tone === 'warning' && value > 0 ? 'text-amber-700' : 'text-gray-900'}`}>{value.toLocaleString('id-ID')}</p>
      <p className="text-xs text-gray-400">{label}</p>
      {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
    </Card>
  )
}

function Breakdown({ title, rows, showSize }: { title: string; rows: ReadonlyArray<OversellBreakdown>; showSize?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-black text-gray-400 uppercase tracking-wider mb-2">{title}</p>
      <ul className="divide-y divide-gray-50">
        {rows.slice(0, 8).map((r) => (
          <li key={`${r.key}-${r.variantSize ?? ''}`} className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-gray-900 truncate">{r.name}{showSize && r.variantSize ? ` · ${r.variantSize}` : ''}</span>
            <span className="text-gray-500 whitespace-nowrap ml-3">{r.lines} baris · <b className="text-red-600">{r.shortfall}</b> unit</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
