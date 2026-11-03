import { useEffect, useRef, useState } from 'react'
import type { ErpOutboxItem, ErpRelayReport } from '@mandalika/api'
import { Cable } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { ERP_STATUS } from '../../lib/labels/erp'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { FilterBar } from '../../ui/FilterBar'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { StatusBadge } from '../../ui/StatusBadge'
import {
  ALL_STATUSES, KIND_LABEL, KIND_ORDER, STATUS_LABEL, STATUS_ORDER, emptyTitle, kindFilterOf, kindLabel, locationText,
  refText, relaySummary, statusFilterOf, type RelaySummary,
} from './erpOutboxFormat'
import { ErpOutboxDetail } from './ErpOutboxDetail'
import { fmtTime } from './fmtTime'

interface ErpListState {
  status: string
  jenis: string
  hal: number
  per: number
  [key: string]: string | number
}

const LIST_SCHEMA: ListSchema<ErpListState> = {
  status: { key: 'status', default: 'dead' },
  jenis: { key: 'jenis', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 50 },
}

const PAGE_SIZES = [25, 50, 100]
const DASH = '—'

const KIND_OPTIONS = [{ value: '', label: 'Semua jenis' }, ...KIND_ORDER.map((k) => ({ value: k, label: KIND_LABEL[k] }))]

/**
 * "Kirim sekarang": one run at a time. The ref is set before the await, so a fast double click on the
 * confirm cannot start a second run before React re-renders the disabled button. The server keys neither
 * this call nor a retry; the relay claims rows under a lease, so this guard is about not asking twice.
 */
function useRelayRun(onDone: () => void) {
  const inFlight = useRef(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RelaySummary | null>(null)

  const confirm = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const r: ErpRelayReport = await api.runErpRelay()
      setResult(relaySummary(r))
      setAsking(false)
      onDone()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal menjalankan relay')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const open = () => { setError(null); setAsking(true) }
  const cancel = () => { if (!inFlight.current) setAsking(false) }
  return { asking, busy, error, result, open, cancel, confirm }
}

function RelayResult({ summary }: { summary: RelaySummary }) {
  const [showTech, setShowTech] = useState(false)
  return (
    <Card className="space-y-3 p-4">
      <div role="status" aria-label="Hasil pengiriman" className="space-y-2">
        {summary.headline && <p className="text-sm font-bold text-ink-900">{summary.headline}</p>}
        {summary.counts.length > 0 && (
          <dl className="flex flex-wrap gap-6">
            {summary.counts.map((c) => (
              <div key={c.label}>
                <dt className="text-xs font-bold text-ink-700">{c.label}</dt>
                <dd className="text-xl font-black tabular-nums text-ink-900">{c.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div>
        <button
          type="button"
          aria-expanded={showTech}
          onClick={() => setShowTech((v) => !v)}
          className="text-xs font-bold text-ink-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
        >
          Detail teknis
        </button>
        {showTech && (
          <ul className="mt-2 list-disc pl-5 text-xs text-ink-700">
            {summary.technical.map((t) => <li key={t}>{t}</li>)}
          </ul>
        )}
      </div>
    </Card>
  )
}

function StatusLegend() {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs font-bold text-ink-700">Arti status</summary>
      <ul className="mt-2 space-y-1.5">
        {STATUS_ORDER.map((s) => (
          <li key={s} className="flex items-start gap-2">
            <StatusBadge map={ERP_STATUS} value={s} />
            <span className="text-xs text-ink-700">{ERP_STATUS[s].hint}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export default function ErpOutboxScreen() {
  const [state, setState] = useListState(LIST_SCHEMA)
  const [selected, setSelected] = useState<ErpOutboxItem | null>(null)
  const pageSize = PAGE_SIZES.includes(state.per) ? state.per : LIST_SCHEMA.per.default
  const page = Math.max(1, Math.floor(state.hal))
  const status = statusFilterOf(state.status)
  const kind = kindFilterOf(state.jenis)

  const q = usePolledQuery(
    () => api.listErpOutbox({ page, limit: pageSize, ...(status ? { status } : {}), ...(kind ? { kind } : {}) }),
    [page, pageSize, status, kind],
  )
  const relay = useRelayRun(() => void q.refetch())
  const rows = q.data?.items ?? []
  const total = q.data?.meta?.total ?? 0
  const counts = q.data?.counts
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // A pasted or stale page number past the end (or the last row of a later page retried away): step back.
  useEffect(() => {
    if (!q.loading && !q.error && q.data?.meta?.page === page && rows.length === 0 && page > 1) setState({ hal: page - 1 }, { replace: true })
  }, [q.loading, q.error, q.data, rows.length, page, setState])

  const chips = [
    { id: ALL_STATUSES, label: 'Semua' },
    ...STATUS_ORDER.map((s) => ({ id: s as string, label: STATUS_LABEL[s], count: counts?.[s] })),
  ]
  const activeStatus = status ?? ALL_STATUSES
  const activeCount = (state.status !== LIST_SCHEMA.status.default ? 1 : 0) + (kind ? 1 : 0)

  const columns: Column<ErpOutboxItem>[] = [
    { id: 'ref', header: 'Dokumen', cell: (r) => <span className="font-bold">{refText(r)}</span> },
    { id: 'time', header: 'Waktu', cell: (r) => fmtTime(r.createdAt) },
    { id: 'kind', header: 'Jenis', cell: (r) => kindLabel(r.kind) },
    { id: 'location', header: 'Lokasi', cell: (r) => locationText(r) },
    { id: 'status', header: 'Status', cell: (r) => <StatusBadge map={ERP_STATUS} value={r.status} /> },
    { id: 'attempts', header: 'Percobaan', align: 'right', cell: (r) => r.attempts },
    { id: 'http', header: 'HTTP', cell: (r) => r.lastHttpStatus ?? DASH, defaultHidden: true },
    {
      id: 'reason',
      header: 'Alasan',
      cell: (r) => {
        const reason = r.holdReason || r.lastError || ''
        return <span className="line-clamp-2 text-ink-700" title={reason}>{reason || DASH}</span>
      },
    },
  ]

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Integrasi ERP"
        count={`${total} dokumen`}
        subtitle="Dokumen stok yang dikirim ke ERP"
        actions={<Button onClick={relay.open}>Kirim sekarang</Button>}
      />
      {relay.result && <RelayResult summary={relay.result} />}
      {q.error && <p role="alert" className="text-sm text-red-600">{q.error}</p>}

      <FilterBar
        onReset={() => setState({ status: LIST_SCHEMA.status.default, jenis: '', hal: 1 })}
        activeCount={activeCount}
      >
        <FilterBar.Chips
          label="Status dokumen"
          items={chips}
          value={activeStatus}
          onChange={(v) => setState({ status: v, hal: 1 })}
        />
        <FilterBar.Select label="Jenis" value={kind} onChange={(v) => setState({ jenis: v, hal: 1 })} options={KIND_OPTIONS} />
      </FilterBar>
      <StatusLegend />

      <DataTable
        caption="Dokumen ke ERP"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.loading && rows.length === 0}
        empty={<EmptyState icon={<Cable />} title={emptyTitle(status ?? '')} />}
        onRowClick={setSelected}
        selectedKey={selected?.id ?? null}
        columnPrefsKey="mandalika.bo.erpOutbox.columns"
        footer={
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onChange={(p) => setState({ hal: p })}
            pageSize={pageSize}
            onPageSizeChange={(s) => setState({ per: s, hal: 1 })}
          />
        }
      />

      <ConfirmDialog
        open={relay.asking}
        title="Kirim dokumen ke ERP sekarang?"
        consequence="Dokumen yang menunggu dikirim ke ERP sekarang, tanpa menunggu jadwal otomatis. Hasilnya tampil di halaman ini."
        confirmLabel="Kirim sekarang"
        busy={relay.busy}
        error={relay.error}
        onConfirm={relay.confirm}
        onCancel={relay.cancel}
      />
      {/* After a retry the row leaves the current filter; back to page 1 so the page can't fall past the end. */}
      <ErpOutboxDetail
        item={selected}
        onClose={() => setSelected(null)}
        onChanged={() => { if (page !== 1) setState({ hal: 1 }); else void q.refetch() }}
      />
    </div>
  )
}
