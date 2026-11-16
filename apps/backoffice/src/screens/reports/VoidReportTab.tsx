import { useEffect } from 'react'
import { fetchAllPages } from '@mandalika/api'
import type { VoidReport, VoidReportRow } from '@mandalika/api'
import { Ban } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { buildExportName, exportToCSV } from '../../lib/csvUtils'
import { VOID_REASONS, voidReasonLabel } from '../../lib/labels/void'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { Badge } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ExportButton } from '../../ui/ExportButton'
import { FilterBar } from '../../ui/FilterBar'
import { Pagination } from '../../ui/Pagination'
import { PAGING_SCHEMA, enumOf, isAnswerFor, pageOf, pageSizeOf, pageToClamp, totalPagesOf, uuidOf } from './reportFilters'
import { formatVoidTime, reasonCards, tendersText, voidCsvRecords, voidStateLabel } from './voidReport'

interface VoidListState {
  alasan: string
  oleh: string
  tutup: string
  hal: number
  per: number
  [key: string]: string | number
}

const VOID_SCHEMA: ListSchema<VoidListState> = {
  alasan: { key: 'alasan', default: '' },
  oleh: { key: 'oleh', default: '' },
  tutup: { key: 'tutup', default: '' },
  hal: PAGING_SCHEMA.hal,
  per: PAGING_SCHEMA.per,
}

const REASON_CODES = VOID_REASONS.map((r) => r.code)
const REASON_OPTIONS = [{ value: '', label: 'Semua' }, ...VOID_REASONS.map((r) => ({ value: r.code as string, label: r.label }))]
const STATE_TONE: Record<VoidReportRow['state'], 'success' | 'warning' | 'neutral' | 'gold'> = {
  replaced: 'success', awaiting_replacement: 'warning', no_replacement: 'neutral', legacy: 'neutral',
}

const money = (n: number) => BRAND.currency.format(n)

const COLUMNS: Column<VoidReportRow>[] = [
  { id: 'asli', header: 'No. Asli', cell: (r) => <span className="whitespace-nowrap font-mono font-bold">{r.orderNumber}</span> },
  {
    id: 'tanggal',
    header: 'Tanggal',
    cell: (r) => (
      <span className="whitespace-nowrap">
        {r.businessDate}
        <span className="block text-xs text-ink-700">{r.outletName}</span>
      </span>
    ),
  },
  { id: 'penjual', header: 'Kasir penjual', cell: (r) => r.soldByName },
  {
    id: 'alasan',
    header: 'Alasan',
    cell: (r) => (
      <span className="block max-w-xs">
        {r.reasonCode ? voidReasonLabel(r.reasonCode) : '—'}
        {r.note && <span className="block text-xs text-ink-700">{r.note}</span>}
      </span>
    ),
  },
  {
    id: 'oleh',
    header: 'Dibatalkan oleh / Perangkat',
    cell: (r) => (
      <>
        {r.voidedByName || '—'}
        <span className="block text-xs text-ink-700">
          {r.source === 'pos' ? `POS${r.deviceId ? ` ${r.deviceId}` : ''}` : r.source === 'backoffice' ? 'Backoffice' : ''}
          {r.voidedAt ? ` · ${formatVoidTime(r.voidedAt)}` : ''}
          {r.afterClose ? ' · setelah tutup' : ''}
        </span>
      </>
    ),
  },
  {
    id: 'total',
    header: 'Asli (Total · Metode)',
    cell: (r) => (
      <span className="block">
        <span className="font-black">{money(r.originalTotal)}</span>
        <span className="block text-xs text-ink-700">{tendersText(r.originalTenders)}</span>
      </span>
    ),
  },
  {
    id: 'pengganti',
    header: 'Pengganti',
    cell: (r) => r.replacementOrderNumber ? (
      <span className="block">
        <span className="font-mono font-bold">{r.replacementOrderNumber}</span>
        <span className="block text-xs text-ink-700">{r.replacementTotal != null ? money(r.replacementTotal) : ''} {tendersText(r.replacementTenders)}</span>
      </span>
    ) : '—',
  },
  {
    id: 'penyesuaian',
    header: 'Penyesuaian',
    align: 'right',
    cell: (r) => r.correctionAmount ? <span className="whitespace-nowrap">{r.correctionAmount < 0 ? '-' : '+'}{money(Math.abs(r.correctionAmount))}</span> : '—',
  },
  { id: 'status', header: 'Status', cell: (r) => <Badge tone={STATE_TONE[r.state]}>{voidStateLabel(r)}</Badge> },
]

interface VoidReportTabProps {
  dateFrom: string
  dateTo: string
  outletId: string
}

/** Laporan > Pembatalan (remounted by the hub on date/outlet change): one row per voided sale over the hub's business-day range. */
export function VoidReportTab({ dateFrom, dateTo, outletId }: VoidReportTabProps) {
  const { user } = useAuth()
  const [state, setState] = useListState(VOID_SCHEMA)
  const page = pageOf(state.hal)
  const pageSize = pageSizeOf(state.per)
  const reason = enumOf<string>(state.alasan, REASON_CODES, '')
  const voider = uuidOf(state.oleh)
  const afterClose = state.tutup === '1'

  // The voider list comes from /users, which is admin-only: other roles filter by reason and after-close only.
  const isAdmin = user?.role === 'admin'
  const uq = usePolledQuery(async () => (isAdmin ? (await api.listUsers(1, 200)).data : []), [isAdmin], 300000)
  const voiderOptions = [{ value: '', label: 'Semua' }, ...(uq.data ?? []).map((u) => ({ value: u.id, label: u.displayName }))]

  const filters = {
    dateFrom, dateTo, outletId: outletId || undefined, reasonCode: reason || undefined,
    cashierId: voider || undefined, afterClose: afterClose ? true : undefined,
  }
  const rq = usePolledQuery<VoidReport>(
    () => api.getVoidReport({ ...filters, page, limit: pageSize }),
    [dateFrom, dateTo, outletId, reason, voider, afterClose, page, pageSize],
  )

  const rows = rq.data?.data ?? []
  const totals = rq.data?.totals
  const total = rq.data?.meta?.total ?? 0
  const totalPages = totalPagesOf(total, pageSize)
  const cards = reasonCards(rq.data?.byReason)

  useEffect(() => {
    if (rq.loading || rq.error || !rq.data || !isAnswerFor(rq.data.meta, page, pageSize)) return
    const target = pageToClamp(page, total, pageSize)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [rq.loading, rq.error, rq.data, page, total, pageSize, setState])

  const runExport = async () => {
    // fetchAllPages pages on {id} rows; a void row is keyed by its order.
    const all = await fetchAllPages(async (p, limit) => {
      const r = await api.getVoidReport({ ...filters, page: p, limit })
      return { ...r, data: r.data.map((x) => ({ ...x, id: x.orderId })) }
    })
    exportToCSV(voidCsvRecords(all), buildExportName('laporan-pembatalan', [dateFrom, dateTo, reason]))
  }

  const active = (reason ? 1 : 0) + (voider ? 1 : 0) + (afterClose ? 1 : 0)

  return (
    <div className="space-y-5">
      <FilterBar
        onReset={() => setState({ alasan: '', oleh: '', tutup: '', hal: 1 })}
        activeCount={active}
        actions={
          <ExportButton
            qualifier="pembatalan"
            rowCount={rq.data ? total : null}
            filterSummary={[dateFrom && `dari ${dateFrom}`, dateTo && `sampai ${dateTo}`, reason && `alasan ${voidReasonLabel(reason)}`].filter(Boolean) as string[]}
            disabled={!!rq.error}
            onExport={runExport}
          />
        }
      >
        <FilterBar.Select label="Alasan" value={reason} onChange={(v) => setState({ alasan: v, hal: 1 })} options={REASON_OPTIONS} />
        {isAdmin && <FilterBar.Select label="Dibatalkan oleh" value={voider} onChange={(v) => setState({ oleh: v, hal: 1 })} options={voiderOptions} />}
        <label className="flex h-10 items-center gap-2 rounded-xl bg-paper-1 px-3 text-[13px] font-bold text-ink-900">
          <input type="checkbox" checked={afterClose} onChange={(e) => setState({ tutup: e.target.checked ? '1' : '', hal: 1 })} />
          Setelah shift ditutup
        </label>
      </FilterBar>

      {cards.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" aria-label="Ringkasan per alasan">
          {cards.map((c) => (
            <Card key={c.code} className="p-4">
              <p className="text-xl font-black text-gray-900">{c.voids}</p>
              <p className="text-xs text-ink-500">{c.label}</p>
              <p className="text-xs text-ink-700">{money(c.originalTotal)}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4"><p className="text-xl font-black text-gray-900">{String(totals?.voids ?? 0)}</p><p className="text-xs text-ink-500">Pembatalan</p></Card>
        <Card className="p-4"><p className="text-xl font-black text-gray-900">{money(totals?.originalTotal ?? 0)}</p><p className="text-xs text-ink-500">Total asli</p></Card>
        <Card className="p-4"><p className="text-xl font-black text-gray-900">{money(totals?.replacementTotal ?? 0)}</p><p className="text-xs text-ink-500">Total pengganti</p></Card>
        <Card className="p-4"><p className="text-xl font-black text-gray-900">{money(totals?.correctionTotal ?? 0)}</p><p className="text-xs text-ink-500">Penyesuaian koreksi</p></Card>
      </div>

      <DataTable
        caption="Daftar pembatalan"
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.orderId}
        loading={rq.loading && !rq.data}
        error={rq.error ? `Gagal memuat data. Data sebelumnya mungkin ditampilkan. ${rq.error}` : null}
        onRetry={() => void rq.refetch()}
        empty={<EmptyState icon={<Ban />} title="Belum ada pembatalan pada rentang ini" />}
        footer={
          totalPages > 1 ? (
            <Pagination
              page={page} totalPages={totalPages} total={total} onChange={(p) => setState({ hal: p })}
              pageSize={pageSize} onPageSizeChange={(n) => setState({ per: n, hal: 1 })}
            />
          ) : undefined
        }
      />
    </div>
  )
}
