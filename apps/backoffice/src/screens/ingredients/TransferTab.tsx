import { useState } from 'react'
import { fetchAllPages, type IngredientTransfer, type Outlet, type Warehouse } from '@mandalika/api'
import { Plus, Send, Ban, PackageCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { exportToCSV, exportToXLSX, buildExportName } from '../../lib/csvUtils'
import { ImportExportBar } from '../../components/ImportExportBar'
import { Button } from '../../ui/Button'
import { Select, fieldClass } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { IngredientTransferForm } from './IngredientTransferForm'
import { IngredientReceiveModal } from './IngredientReceiveModal'
import { SuratJalanIngredientPanel } from './SuratJalanIngredientPanel'

// ISO date string "YYYY-MM-DD" → "YYYY-MM-DDT00:00:00Z"
function toFromIso(date: string): string {
  return `${date}T00:00:00Z`
}

// ISO date string "YYYY-MM-DD" → next day at midnight UTC (exclusive end)
function toToIso(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const STATUS: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' }> = {
  draft: { label: 'Draf', tone: 'neutral' },
  in_transit: { label: 'Dikirim', tone: 'warning' },
  completed: { label: 'Selesai', tone: 'success' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
}

const fmtDate = (s?: string | null) =>
  s
    ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—'


export default function TransferTab() {
  const [filterStatus, setFilterStatus] = useState('')
  const [locationKey, setLocationKey] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const outlets = ouq.data ?? []
  const warehouses = wq.data ?? []

  const locParts = locationKey ? locationKey.split(':') : null
  const locKind = locParts ? (locParts[0] as 'outlet' | 'warehouse') : undefined
  const locId = locParts ? locParts[1] : undefined

  const q = usePolledQuery(
    () =>
      api.listIngredientTransfers({
        ...(filterStatus ? { status: filterStatus } : {}),
        ...(fromDate ? { from: toFromIso(fromDate) } : {}),
        ...(toDate ? { to: toToIso(toDate) } : {}),
        ...(locKind && locId ? { locKind, locId } : {}),
        page,
        limit: pageSize,
      }),
    [filterStatus, locationKey, fromDate, toDate, page, pageSize],
  )
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const selected = rows.find((t) => t.id === selectedId) ?? null

  function onFilterChange(fn: () => void) {
    fn()
    setPage(1)
    setSelectedId(null)
  }

  const exportIngredientTransfers = async (fmt: 'csv' | 'xlsx') => {
    const all = await fetchAllPages((page, limit) => api.listIngredientTransfers({
      ...(filterStatus ? { status: filterStatus } : {}),
      ...(fromDate ? { from: toFromIso(fromDate) } : {}),
      ...(toDate ? { to: toToIso(toDate) } : {}),
      ...(locKind && locId ? { locKind, locId } : {}),
      page,
      limit,
    }))
    const exportRows = all.map((t) => ({
      No: t.transferNo,
      Sumber: t.source.name ?? t.source.id,
      Tujuan: t.dest.name ?? t.dest.id,
      Status: STATUS[t.status]?.label ?? t.status,
      Dibuat: fmtDate(t.createdAt),
    }))
    const locName =
      locKind && locId
        ? (locKind === 'outlet' ? outlets : warehouses).find((l) => l.id === locId)?.name
        : undefined
    const name = buildExportName('transfer-bahan', [
      filterStatus ? (STATUS[filterStatus]?.label ?? filterStatus) : undefined,
      locName,
      fromDate ? `dari-${fromDate}` : undefined,
      toDate ? `sd-${toDate}` : undefined,
    ])
    if (fmt === 'csv') exportToCSV(exportRows, name)
    else exportToXLSX(exportRows, name)
  }

  return (
    <div className="space-y-5">
      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[180px]">
          <Select
            label="Status"
            value={filterStatus}
            onChange={(e) => onFilterChange(() => setFilterStatus(e.target.value))}
          >
            <option value="">Semua status</option>
            <option value="draft">Draft</option>
            <option value="in_transit">Dalam pengiriman</option>
            <option value="completed">Selesai</option>
            <option value="cancelled">Dibatalkan</option>
          </Select>
        </div>
        <div className="min-w-[200px]">
          <Select
            label="Lokasi"
            value={locationKey}
            onChange={(e) => onFilterChange(() => setLocationKey(e.target.value))}
          >
            <option value="">Semua lokasi</option>
            {outlets.length > 0 && (
              <optgroup label="Outlet">
                {outlets.map((o) => (
                  <option key={o.id} value={`outlet:${o.id}`}>{o.name}</option>
                ))}
              </optgroup>
            )}
            {warehouses.length > 0 && (
              <optgroup label="Gudang">
                {warehouses.map((w) => (
                  <option key={w.id} value={`warehouse:${w.id}`}>{w.name}</option>
                ))}
              </optgroup>
            )}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="ingredient-transfer-from-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Dari</label>
          <input
            id="ingredient-transfer-from-date"
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => onFilterChange(() => setFromDate(e.target.value))}
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="ingredient-transfer-to-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Sampai</label>
          <input
            id="ingredient-transfer-to-date"
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => onFilterChange(() => setToDate(e.target.value))}
            className={fieldClass}
          />
        </div>
        <div className="flex items-end gap-2 ml-auto">
          <span className="text-xs text-gray-500 pb-2.5">{total} transfer</span>
          <ImportExportBar
            onExport={(fmt) => void exportIngredientTransfers(fmt)}
            exportDisabled={total === 0}
          />
          <Button
            onClick={() => setShowCreate(true)}
            icon={<Plus className="w-4 h-4" />}
          >
            Buat Transfer
          </Button>
        </div>
      </div>

      {/* List */}
      <Card className="overflow-hidden">
        {q.loading ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<PackageCheck />} title="Belum ada transfer bahan" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['No', 'Sumber', 'Tujuan', 'Status', 'Dibuat'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((t) => {
                  const s = STATUS[t.status] ?? STATUS.draft
                  return (
                    <tr
                      key={t.id}
                      onClick={() => setSelectedId(t.id === selectedId ? null : t.id)}
                      className={`cursor-pointer transition-colors ${
                        t.id === selectedId ? 'bg-amber-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <td className="px-5 py-3 font-mono text-sm text-gray-900">{t.transferNo}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {t.source.name ?? t.source.id}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {t.dest.name ?? t.dest.id}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">{fmtDate(t.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
      />

      {/* Detail panel */}
      {selected && (
        <TransferDetail
          transfer={selected}
          onDismiss={() => setSelectedId(null)}
          onRefresh={() => q.refetch()}
        />
      )}

      {/* Create modal */}
      {showCreate && (
        <IngredientTransferForm
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            void q.refetch()
          }}
        />
      )}
    </div>
  )
}

interface TransferDetailProps {
  transfer: IngredientTransfer
  onDismiss: () => void
  onRefresh: () => void | Promise<void>
}

function TransferDetail({ transfer: t, onDismiss, onRefresh }: TransferDetailProps) {
  const [receiving, setReceiving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Re-fetch the full transfer to get up-to-date items after an action.
  const detailQ = usePolledQuery<IngredientTransfer>(
    () => api.getIngredientTransfer(t.id),
    [t.id],
  )
  const transfer = detailQ.data ?? t

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await detailQ.refetch()
      await onRefresh()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Aksi gagal.')
    } finally {
      setBusy(false)
    }
  }

  const s = STATUS[transfer.status] ?? STATUS.draft
  const sourceName = transfer.source.name ?? transfer.source.id
  const destName = transfer.dest.name ?? transfer.dest.id

  return (
    <Card className="p-5 space-y-4">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="font-mono font-bold text-gray-900">{transfer.transferNo}</div>
          <div className="text-sm text-gray-500">
            {sourceName} → {destName}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Badge tone={s.tone}>{s.label}</Badge>
          {transfer.status === 'draft' && (
            <Button
              size="sm"
              icon={<Send className="w-3.5 h-3.5" />}
              loading={busy}
              onClick={() => act(() => api.sendIngredientTransfer(transfer.id))}
            >
              Kirim
            </Button>
          )}
          {transfer.status === 'in_transit' && (
            <Button
              size="sm"
              icon={<PackageCheck className="w-3.5 h-3.5" />}
              onClick={() => setReceiving(true)}
            >
              Terima
            </Button>
          )}
          {(transfer.status === 'draft' || transfer.status === 'in_transit') && (
            <Button
              size="sm"
              variant="danger"
              icon={<Ban className="w-3.5 h-3.5" />}
              loading={busy}
              onClick={() => {
                const reason = window.prompt('Alasan pembatalan:')
                if (reason == null) return
                void act(() => api.cancelIngredientTransfer(transfer.id, reason || 'Dibatalkan'))
              }}
            >
              Batalkan
            </Button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-gray-400 hover:text-gray-600 ml-1"
          >
            ✕ Tutup
          </button>
        </div>
      </div>

      {transfer.note && (
        <p className="text-sm text-gray-500">{transfer.note}</p>
      )}
      {transfer.discrepancyReason && (
        <p className="text-sm text-amber-700">Selisih: {transfer.discrepancyReason}</p>
      )}

      {/* Items table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Bahan', 'Satuan', 'Dikirim', 'Diterima', 'Selisih'].map((h) => (
                <th
                  key={h}
                  className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {transfer.items.map((it) => (
              <tr key={it.id}>
                <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.ingredientName}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.ingredientUnit}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.sentQty}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.receivedQty ?? '—'}</td>
                <td className="px-4 py-2 text-sm">
                  {it.difference == null ? (
                    '—'
                  ) : (
                    <span
                      className={
                        it.difference < 0
                          ? 'text-red-600'
                          : it.difference > 0
                          ? 'text-green-600'
                          : 'text-gray-400'
                      }
                    >
                      {it.difference > 0 ? `+${it.difference}` : it.difference}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Surat Jalan panel — mounted when SJ number is available */}
      {(transfer.status === 'in_transit' || transfer.status === 'completed') && (
        <SuratJalanIngredientPanel transfer={transfer} />
      )}

      {/* Receive modal */}
      {receiving && (
        <IngredientReceiveModal
          transfer={transfer}
          onClose={() => setReceiving(false)}
          onDone={async () => {
            await detailQ.refetch()
            await onRefresh()
          }}
        />
      )}
    </Card>
  )
}
