import { useState } from 'react'
import type { Outlet, Transfer, Warehouse } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { Plus, ArrowLeft, Send, Ban, PackageCheck } from 'lucide-react'
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
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { TransferForm } from './TransferForm'
import { ReceiveModal } from './ReceiveModal'
import { SuratJalanPanel } from './SuratJalanPanel'

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


type View = { kind: 'list' } | { kind: 'create' } | { kind: 'detail'; id: string }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' }> = {
  draft: { label: 'Draf', tone: 'neutral' },
  in_transit: { label: 'Dikirim', tone: 'warning' },
  completed: { label: 'Selesai', tone: 'success' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
}

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

export function Transfers() {
  const [view, setView] = useState<View>({ kind: 'list' })
  // Locations for the create form (loaded once at this level).
  const oq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])

  if (view.kind === 'create') {
    return (
      <TransferForm
        outlets={oq.data ?? []}
        warehouses={wq.data ?? []}
        onCancel={() => setView({ kind: 'list' })}
        onCreated={(id) => setView({ kind: 'detail', id })}
      />
    )
  }
  if (view.kind === 'detail') {
    return <TransferDetail id={view.id} onBack={() => setView({ kind: 'list' })} />
  }
  return (
    <TransferList
      outlets={oq.data ?? []}
      warehouses={wq.data ?? []}
      onCreate={() => setView({ kind: 'create' })}
      onOpen={(id) => setView({ kind: 'detail', id })}
    />
  )
}

interface TransferListProps {
  outlets: Outlet[]
  warehouses: Warehouse[]
  onCreate: () => void
  onOpen: (id: string) => void
}

function TransferList({ outlets, warehouses, onCreate, onOpen }: TransferListProps) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [filterStatus, setFilterStatus] = useState('')
  const [locationKey, setLocationKey] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const locParts = locationKey ? locationKey.split(':') : null
  const locKind = locParts ? (locParts[0] as 'outlet' | 'warehouse') : undefined
  const locId = locParts ? locParts[1] : undefined

  const q = usePolledQuery(
    () => api.listTransfers({
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

  function onFilterChange(fn: () => void) {
    fn()
    setPage(1)
  }

  const exportTransfers = async (fmt: 'csv' | 'xlsx') => {
    const result = await api.listTransfers({
      ...(filterStatus ? { status: filterStatus } : {}),
      ...(fromDate ? { from: toFromIso(fromDate) } : {}),
      ...(toDate ? { to: toToIso(toDate) } : {}),
      ...(locKind && locId ? { locKind, locId } : {}),
      page: 1,
      limit: 10000,
    })
    const exportRows = result.data.map((t) => ({
      No: t.transferNo,
      Sumber: t.source.name,
      Tujuan: t.dest.name,
      Status: STATUS[t.status]?.label ?? t.status,
      Dibuat: fmtDate(t.createdAt),
    }))
    const locName =
      locKind && locId
        ? (locKind === 'outlet' ? outlets : warehouses).find((l) => l.id === locId)?.name
        : undefined
    const name = buildExportName('transfer-produk', [
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
      <PageHeader
        title="Transfer Stok"
        subtitle={`${total} transfer`}
        actions={
          <>
            <ImportExportBar
              onExport={(fmt) => void exportTransfers(fmt)}
              exportDisabled={total === 0}
            />
            <Button onClick={onCreate} icon={<Plus className="w-4 h-4" />}>
              Transfer Baru
            </Button>
          </>
        }
      />

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
          <label htmlFor="transfers-from-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Dari</label>
          <input
            id="transfers-from-date"
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => onFilterChange(() => setFromDate(e.target.value))}
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="transfers-to-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Sampai</label>
          <input
            id="transfers-to-date"
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => onFilterChange(() => setToDate(e.target.value))}
            className={fieldClass}
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        {q.loading ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<PackageCheck />} title="Belum ada transfer" />
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
                      onClick={() => onOpen(t.id)}
                      className="hover:bg-gray-50 cursor-pointer"
                    >
                      <td className="px-5 py-3 font-mono text-sm text-gray-900">{t.transferNo}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">{t.source.name}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">{t.dest.name}</td>
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
    </div>
  )
}

function TransferDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const q = usePolledQuery<Transfer>(() => api.getTransfer(id), [id])
  const t = q.data
  const [receiving, setReceiving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await q.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Aksi gagal.')
    } finally {
      setBusy(false)
    }
  }

  if (!t) {
    return (
      <div className="space-y-5">
        <PageHeader title="Transfer" actions={<Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>Kembali</Button>} />
        <Card className="p-8"><TableSkeleton /></Card>
      </div>
    )
  }
  const s = STATUS[t.status] ?? STATUS.draft

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.transferNo}
        subtitle={`${t.source.name} → ${t.dest.name}`}
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>
              Kembali
            </Button>
            {t.status === 'draft' && (
              <Button icon={<Send className="w-4 h-4" />} loading={busy} onClick={() => act(() => api.sendTransfer(t.id))}>
                Kirim
              </Button>
            )}
            {t.status === 'in_transit' && (
              <Button icon={<PackageCheck className="w-4 h-4" />} onClick={() => setReceiving(true)}>
                Terima
              </Button>
            )}
            {(t.status === 'draft' || t.status === 'in_transit') && (
              <Button variant="danger" icon={<Ban className="w-4 h-4" />} loading={busy} onClick={() => act(() => api.cancelTransfer(t.id))}>
                Batalkan
              </Button>
            )}
          </>
        }
      />

      {t.suratJalanNo && <SuratJalanPanel transfer={t} />}

      <Card className="p-5">
        <div className="flex items-center gap-3 mb-4">
          <Badge tone={s.tone}>{s.label}</Badge>
          {t.note && <span className="text-sm text-gray-500">{t.note}</span>}
        </div>
        {t.discrepancyReason && (
          <p className="text-sm text-amber-700 mb-3">Selisih: {t.discrepancyReason}</p>
        )}
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Produk', 'Ukuran', 'Dikirim', 'Diterima', 'Selisih'].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {t.items.map((it) => (
              <tr key={`${it.productId}|${it.variantSize}`}>
                <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.productName}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{variantLabel(it.variantSize)}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.sentQty}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.receivedQty ?? '—'}</td>
                <td className="px-4 py-2 text-sm">
                  {it.difference == null ? (
                    '—'
                  ) : (
                    <span className={it.difference < 0 ? 'text-red-600' : it.difference > 0 ? 'text-green-600' : 'text-gray-400'}>
                      {it.difference > 0 ? `+${it.difference}` : it.difference}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      </Card>

      {receiving && (
        <ReceiveModal
          transfer={t}
          onClose={() => setReceiving(false)}
          onDone={() => q.refetch()}
        />
      )}
    </div>
  )
}
