import { useState } from 'react'
import { fetchAllPages, type IngredientStockCount, type IngredientStockCountItem, type Outlet, type Warehouse } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Play, CheckCircle, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react'
import { api } from '../../api'
import { localDay } from '../../lib/businessDay'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { exportToCSV, exportToXLSX } from '../../lib/csvUtils'
import { ImportExportBar } from '../../components/ImportExportBar'
import { Button } from '../../ui/Button'
import { Input, Select, Textarea, fieldClass } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { badgeTone } from '../../lib/labels/badgeTone'
import { OPNAME_STATUS } from '../../lib/labels/opname'
import { labelOf } from '../../lib/labels/types'
import { IconButton } from '../../ui/IconButton'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'

const fmtQty = (n: number | null | undefined) => {
  if (n == null) return '—'
  return n.toLocaleString('id-ID', { maximumFractionDigits: 3 })
}

// ---- inline subcomponents ----

interface ItemsTableProps {
  sc: IngredientStockCount
  items: IngredientStockCountItem[]
  counted: Record<string, number>
  onCountChange: (itemId: string, val: number) => void
}

function ItemsTable({ sc, items, counted, onCountChange }: ItemsTableProps) {
  const isEditable = sc.status === 'in_progress'
  const showDiff = sc.status === 'completed' || sc.status === 'in_progress'
  return (
    <div className="border-t border-gray-100 overflow-x-auto max-h-96 overflow-y-auto">
      <table className="w-full">
        <thead className="sticky top-0 bg-gray-50">
          <tr>
            {['Bahan', 'Satuan', 'Dihitung', ...(showDiff ? ['Selisih'] : [])].map((h) => (
              <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {items.map((it) => {
            const serverDiff = it.difference
            return (
              <tr key={it.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.ingredientName}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{it.ingredientUnit}</td>
                <td className="px-4 py-2">
                  {isEditable ? (
                    <input
                      type="number"
                      step="any"
                      value={counted[it.id] !== undefined ? counted[it.id] : (it.counted ?? '')}
                      onChange={(e) => onCountChange(it.id, parseFloat(e.target.value) || 0)}
                      className={`${fieldClass} w-24 px-2 py-1 text-center`}
                      aria-label="Jumlah dihitung"
                    />
                  ) : (
                    <span className="text-sm font-bold text-gray-900">{fmtQty(it.counted)}</span>
                  )}
                </td>
                {showDiff && (
                  <td className="px-4 py-2">
                    {sc.status === 'completed' && serverDiff != null ? (
                      <span
                        className={`text-sm font-black ${serverDiff > 0 ? 'text-green-600' : serverDiff < 0 ? 'text-red-600' : 'text-gray-400'}`}
                      >
                        {serverDiff > 0 ? '+' : ''}
                        {fmtQty(serverDiff)}
                      </span>
                    ) : sc.status === 'in_progress' && counted[it.id] !== undefined && it.counted != null ? (
                      (() => {
                        const d = (counted[it.id] ?? 0) - (it.counted ?? 0)
                        return (
                          <span
                            className={`text-xs ${d > 0 ? 'text-green-600' : d < 0 ? 'text-red-500' : 'text-gray-400'}`}
                          >
                            {d > 0 ? '+' : ''}
                            {fmtQty(d)}
                          </span>
                        )
                      })()
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {items.length === 0 && (
        <p className="text-sm text-gray-400 px-4 py-6 text-center">Belum ada item</p>
      )}
    </div>
  )
}


// ---- main component ----

const parseLocationKey = (key: string): { kind: 'outlet' | 'warehouse'; id: string } | null => {
  if (!key) return null
  const idx = key.indexOf(':')
  return { kind: key.slice(0, idx) as 'outlet' | 'warehouse', id: key.slice(idx + 1) }
}

const exportIngredientStockCounts = async (fmt: 'csv' | 'xlsx') => {
  const all = await fetchAllPages((page, limit) => api.listIngredientStockCounts({ page, limit }))
  const exportRows = all.map((sc) => ({
    Nama: sc.name,
    Lokasi: sc.location.name ?? sc.location.id,
    'Tipe Lokasi': sc.location.kind === 'outlet' ? 'Outlet' : 'Gudang',
    Status:
      sc.status === 'planned' ? 'Direncanakan'
      : sc.status === 'in_progress' ? 'Sedang Berjalan'
      : sc.status === 'completed' ? 'Selesai'
      : 'Dibatalkan',
    'Tanggal Rencana': sc.plannedDate ?? '',
    Selesai: sc.completedAt ? sc.completedAt.slice(0, 10) : '',
  }))
  if (fmt === 'csv') exportToCSV(exportRows, 'opname-bahan')
  else exportToXLSX(exportRows, 'opname-bahan')
}

const tone = (s: string) => badgeTone(labelOf(OPNAME_STATUS, s).tone)

const statusLabel = (s: string) => labelOf(OPNAME_STATUS, s).label

const locationKindLabel = (kind: 'outlet' | 'warehouse') =>
  kind === 'outlet' ? 'Outlet' : 'Gudang'

export default function OpnameTab() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const scq = usePolledQuery(
    () => api.listIngredientStockCounts({ page, limit: pageSize }),
    [page, pageSize],
  )
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const stockCounts = scq.data?.data ?? []
  const scTotal = scq.data?.meta?.total ?? 0
  const scTotalPages = Math.max(1, Math.ceil(scTotal / pageSize))
  const outlets = ouq.data ?? []
  const warehouses = (wq.data ?? []).filter((w) => w.isActive)

  // All location options encoded as "kind:id"
  const locationOptions = [
    ...warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
    ...outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
  ]

  const [expanded, setExpanded] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // draft counted values: Record<stockCountId, Record<itemId, counted>>
  const [draft, setDraft] = useState<Record<string, Record<string, number>>>({})
  const [form, setForm] = useState({
    name: '',
    locationKey: '',
    plannedDate: localDay(),
    notes: '',
  })

  const countedFor = (sc: IngredientStockCount) => draft[sc.id] ?? {}

  const createSC = async () => {
    if (!form.name.trim()) return setErr('Nama wajib diisi')
    const loc = parseLocationKey(form.locationKey)
    if (!loc) return setErr('Pilih lokasi')
    setBusy(true)
    setErr(null)
    try {
      await api.createIngredientStockCount({
        name: form.name.trim(),
        location: { kind: loc.kind, id: loc.id },
        plannedDate: form.plannedDate || null,
        notes: form.notes.trim() || null,
      })
      setOpen(false)
      setForm({ name: '', locationKey: '', plannedDate: localDay(), notes: '' })
      await scq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal membuat opname.')
    } finally {
      setBusy(false)
    }
  }

  const startSC = async (sc: IngredientStockCount) => {
    setActiveId(sc.id)
    try {
      await api.startIngredientStockCount(sc.id)
      setExpanded(sc.id)
      await scq.refetch()
    } finally {
      setActiveId(null)
    }
  }

  const setQty = (sc: IngredientStockCount, itemId: string, val: number) => {
    setDraft((d) => ({
      ...d,
      [sc.id]: { ...(d[sc.id] ?? {}), [itemId]: val },
    }))
  }

  const saveProgress = async (sc: IngredientStockCount) => {
    setActiveId(sc.id)
    const items = sc.items ?? []
    const counted = countedFor(sc)
    try {
      await api.saveIngredientStockCount(sc.id, {
        items: items.map((it) => ({
          itemId: it.id,
          counted: counted[it.id] ?? it.counted ?? 0,
        })),
      })
      await scq.refetch()
    } finally {
      setActiveId(null)
    }
  }

  const completeSC = async (sc: IngredientStockCount) => {
    const locationLabel = sc.location.name ?? sc.location.id
    const ok = window.confirm(
      `Selesaikan opname? Qty bahan di ${locationLabel} akan diperbarui sesuai jumlah yang dihitung.`,
    )
    if (!ok) return
    setActiveId(sc.id)
    try {
      await api.completeIngredientStockCount(sc.id)
      setDraft((d) => {
        const n = { ...d }
        delete n[sc.id]
        return n
      })
      await scq.refetch()
    } finally {
      setActiveId(null)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Opname Bahan"
        subtitle="Hitung stok bahan baku per lokasi (outlet atau gudang)."
        actions={
          <>
            <ImportExportBar
              onExport={(fmt) => void exportIngredientStockCounts(fmt)}
              exportDisabled={scTotal === 0}
            />
            <Button
              icon={<Plus className="w-4 h-4" />}
              onClick={() => {
                setErr(null)
                setOpen(true)
              }}
            >
              Buat Opname Baru
            </Button>
          </>
        }
      />

      <div className="space-y-3">
        {scq.loading ? (
          <TableSkeleton />
        ) : stockCounts.length === 0 ? (
          <Card>
            <EmptyState icon={<ClipboardList />} title="Belum ada opname bahan" />
          </Card>
        ) : (
          stockCounts.map((sc) => {
            const items = sc.items ?? []
            const counted = countedFor(sc)
            const countedCount = items.filter(
              (it) => counted[it.id] !== undefined || it.counted != null,
            ).length
            return (
              <Card key={sc.id} className="overflow-hidden">
                {/* Row header */}
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gold-50 rounded-xl flex items-center justify-center">
                      <ClipboardList className="w-5 h-5 text-gold-600" />
                    </div>
                    <div>
                      <p className="font-bold text-gray-900">{sc.name}</p>
                      <p className="text-xs text-gray-400">
                        <span className="font-bold text-gray-500">
                          {locationKindLabel(sc.location.kind)}
                        </span>{' '}
                        {sc.location.name ?? sc.location.id} ·{' '}
                        {sc.plannedDate
                          ? format(parseISO(sc.plannedDate), 'dd MMM yyyy', { locale: idLocale })
                          : format(parseISO(sc.createdAt), 'dd MMM yyyy', { locale: idLocale })}{' '}
                        · {items.length} bahan
                        {sc.status === 'in_progress' && ` · ${countedCount}/${items.length} dihitung`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={tone(sc.status)}>{statusLabel(sc.status)}</Badge>

                    {sc.status === 'planned' && (
                      <Button
                        size="sm"
                        icon={<Play className="w-3 h-3" />}
                        loading={activeId === sc.id}
                        onClick={() => startSC(sc)}
                      >
                        Mulai Opname
                      </Button>
                    )}

                    {sc.status === 'in_progress' && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={activeId === sc.id}
                          onClick={() => saveProgress(sc)}
                        >
                          Simpan
                        </Button>
                        <Button
                          size="sm"
                          icon={<CheckCircle className="w-3 h-3" />}
                          disabled={activeId === sc.id}
                          onClick={() => completeSC(sc)}
                        >
                          Selesai
                        </Button>
                      </>
                    )}

                    <IconButton onClick={() => setExpanded(expanded === sc.id ? null : sc.id)}>
                      {expanded === sc.id ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </IconButton>
                  </div>
                </div>

                {/* Expandable items table */}
                {expanded === sc.id && (
                  <ItemsTable
                    sc={sc}
                    items={items}
                    counted={counted}
                    onCountChange={(itemId, val) => setQty(sc, itemId, val)}
                  />
                )}
              </Card>
            )
          })
        )}
      </div>

      <Pagination
        page={page}
        totalPages={scTotalPages}
        total={scTotal}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
      />

      {/* Create modal */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Buat Opname Baru"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
              Batal
            </Button>
            <Button className="flex-1" loading={busy} onClick={createSC}>
              {busy ? 'Membuat...' : 'Buat Opname'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Nama *"
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="mis. Opname Mei 2026"
          />
          <Select
            label="Lokasi *"
            value={form.locationKey}
            onChange={(e) => setForm((f) => ({ ...f, locationKey: e.target.value }))}
          >
            <option value="">Pilih lokasi...</option>
            {locationOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <Input
            label="Tanggal Rencana"
            type="date"
            value={form.plannedDate}
            onChange={(e) => setForm((f) => ({ ...f, plannedDate: e.target.value }))}
          />
          <Textarea
            label="Catatan"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
          <div className="bg-amber-50 rounded-xl p-3 text-xs text-amber-700">
            Item bahan baku di lokasi terpilih akan diambil otomatis saat opname dimulai.
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>
    </div>
  )
}
