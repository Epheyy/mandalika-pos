import { useState } from 'react'
import { fetchAllPages, type IngredientTransfer, type Outlet, type Warehouse } from '@mandalika/api'
import { Plus, Send, Ban, PackageCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { exportToCSV, exportToXLSX, buildExportName } from '../../lib/csvUtils'
import { ImportExportMenu } from '../../ui/ImportExportMenu'
import { Button } from '../../ui/Button'
import { Select, fieldClass } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { StatusBadge } from '../../ui/StatusBadge'
import { useConfirm } from '../../ui/ConfirmDialog'
import { labelOf } from '../../lib/labels/types'
import { TRANSFER_STATUS } from '../../lib/labels/transfer'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { IngredientTransferForm } from './IngredientTransferForm'
import { IngredientReceiveModal } from './IngredientReceiveModal'
import { SuratJalanIngredientPanel } from './SuratJalanIngredientPanel'
import { cancelIngredientTransferConfirm, cancelReason, sendIngredientTransferConfirm } from './ingredientTransferConfirm'
import { useListState } from '../../lib/router/useListState'
import { usePastEndRedirect } from '../../lib/pastEndRedirect'
import {
  BAHAN_TRANSFER_SCHEMA,
  bahanDayOf,
  bahanLocationOf,
  bahanPageOf,
  bahanSizeOf,
  transferStatusOf,
} from './bahanRoute'

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

const fmtDate = (s?: string | null) =>
  s
    ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—'


export default function TransferTab() {
  // Filters, page and page size are in the URL (#/inventori/bahan/transfer?status=&lokasi=&dari=&sampai=&hal=&per=).
  const [filters, setFilters] = useListState(BAHAN_TRANSFER_SCHEMA)
  const filterStatus = transferStatusOf(filters.status)
  const locationKey = bahanLocationOf(filters.lokasi)
  const fromDate = bahanDayOf(filters.dari)
  const toDate = bahanDayOf(filters.sampai)
  const page = bahanPageOf(filters.hal)
  const pageSize = bahanSizeOf(filters.per)
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
  // A page past the end (rows swept or deleted meanwhile) comes back empty with the real total: land on the last page.
  usePastEndRedirect(q, page, rows.length, totalPages, (hal) => setFilters({ hal }, { replace: true }))

  const selected = rows.find((t) => t.id === selectedId) ?? null

  function onFilterChange(patch: Partial<typeof filters>) {
    setFilters({ ...patch, hal: 1 })
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
      Status: labelOf(TRANSFER_STATUS, t.status).label,
      Dibuat: fmtDate(t.createdAt),
    }))
    const locName =
      locKind && locId
        ? (locKind === 'outlet' ? outlets : warehouses).find((l) => l.id === locId)?.name
        : undefined
    const name = buildExportName('transfer-bahan', [
      filterStatus ? labelOf(TRANSFER_STATUS, filterStatus).label : undefined,
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
            onChange={(e) => onFilterChange({ status: e.target.value })}
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
            onChange={(e) => onFilterChange({ lokasi: e.target.value })}
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
            onChange={(e) => onFilterChange({ dari: e.target.value })}
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
            onChange={(e) => onFilterChange({ sampai: e.target.value })}
            className={fieldClass}
          />
        </div>
        <div className="flex items-end gap-2 ml-auto">
          <span className="text-xs text-gray-500 pb-2.5">{total} transfer</span>
          <ImportExportMenu
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
      <Card className="overflow-clip">
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
                        <StatusBadge map={TRANSFER_STATUS} value={t.status} />
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
        onChange={(hal) => setFilters({ hal })}
        pageSize={pageSize}
        onPageSizeChange={(per) => setFilters({ per, hal: 1 })}
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
  const ask = useConfirm()

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
          <StatusBadge map={TRANSFER_STATUS} value={transfer.status} />
          {transfer.status === 'draft' && (
            <Button
              size="sm"
              icon={<Send className="w-3.5 h-3.5" />}
              loading={busy}
              onClick={async () => {
                if (!(await ask(sendIngredientTransferConfirm(transfer))).confirmed) return
                void act(() => api.sendIngredientTransfer(transfer.id))
              }}
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
              onClick={async () => {
                const answer = await ask(cancelIngredientTransferConfirm(transfer))
                if (!answer.confirmed) return
                void act(() => api.cancelIngredientTransfer(transfer.id, cancelReason(answer.value)))
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
        <p className="text-sm text-warn-strong">Selisih: {transfer.discrepancyReason}</p>
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
                          ? 'text-danger'
                          : it.difference > 0
                          ? 'text-warn-strong'
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

      {err && <p className="text-sm text-danger">{err}</p>}

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
