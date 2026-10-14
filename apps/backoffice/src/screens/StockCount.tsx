import { useState } from 'react'
import type { StockCount, StockCountItem, Product, Outlet, Warehouse, ListResult } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Play, CheckCircle, XCircle, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react'
import { api, authStore } from '../api'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { exportToCSV, exportToXLSX, buildExportName } from '../lib/csvUtils'
import { ImportExportBar } from '../components/ImportExportBar'
import { Button } from '../ui/Button'
import { Input, Select, Textarea, fieldClass } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Pagination } from '../ui/Pagination'


const tone = (s: string): 'gold' | 'success' | 'danger' | 'neutral' =>
  s === 'in_progress' ? 'gold' : s === 'completed' ? 'success' : s === 'cancelled' ? 'danger' : 'neutral'
const label = (s: string) =>
  s === 'planned' ? 'Direncanakan' : s === 'in_progress' ? 'Sedang Berjalan' : s === 'completed' ? 'Selesai' : 'Dibatalkan'
const locKind = (sc: StockCount) => (sc.warehouseId ? 'Gudang' : 'Outlet')

export default function StockCount() {
  const { outletId, outlets: ctxOutlets, isAdmin } = useOutlet()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const scq = usePolledQuery<ListResult<StockCount>>(() => api.listStockCounts(page, pageSize), [outletId, page, pageSize])
  const pq = usePolledQuery<Product[]>(() => api.listProducts().then((r) => r.data.filter((p) => p.isActive)), [outletId])
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const stockCounts = scq.data?.data ?? []
  const scTotal = scq.data?.meta?.total ?? 0
  const scTotalPages = Math.max(1, Math.ceil(scTotal / pageSize))
  const products = pq.data ?? []
  const outlets = ctxOutlets.length ? ctxOutlets : ouq.data ?? []
  const warehouses = wq.data ?? []

  const [expanded, setExpanded] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)
  // Unsaved local edits: count id -> line key -> counted qty (null = cleared).
  const [edits, setEdits] = useState<Record<string, Record<string, number | null>>>({})
  const [form, setForm] = useState({
    name: '',
    locationKey: '',
    plannedDate: new Date().toISOString().slice(0, 10),
    notes: '',
  })

  const lineKey = (it: StockCountItem) => `${it.productId}|${it.variantSize}`
  const itemsFor = (sc: StockCount) =>
    sc.items.map((it) => {
      const e = edits[sc.id]?.[lineKey(it)]
      return e === undefined ? it : { ...it, actualQty: e }
    })
  // Edited lines not yet saved, as payload lines.
  const pendingLines = (sc: StockCount) =>
    itemsFor(sc).filter((it) => edits[sc.id]?.[lineKey(it)] !== undefined)
  const clearEdits = (scId: string, keys: string[]) =>
    setEdits((d) => {
      const rest = { ...(d[scId] ?? {}) }
      keys.forEach((k) => delete rest[k])
      return { ...d, [scId]: rest }
    })
  const fail = (e: unknown, fallback: string) => setPageErr(e instanceof Error ? e.message : fallback)

  const createSC = async () => {
    if (!form.name.trim()) return setErr('Nama wajib diisi')
    if (isAdmin && !form.locationKey) return setErr('Pilih lokasi')
    const [kind, locId] = isAdmin ? form.locationKey.split(':') : ['o', null]
    setBusy(true)
    setErr(null)
    const prev = authStore.outletId
    try {
      if (kind === 'w' && locId) {
        // Warehouse count: snapshot from warehouse stock, no authStore switch.
        const wrows = await api.getWarehouseStock(locId)
        const items: StockCountItem[] = wrows.map((r) => ({
          productId: r.productId,
          productName: r.productName,
          variantSize: r.variantSize,
          sku: r.sku ?? '',
          frozenQty: r.stock,
        }))
        await api.createStockCount({
          name: form.name.trim(),
          warehouseId: locId,
          plannedDate: form.plannedDate,
          notes: form.notes.trim(),
          items,
        })
      } else {
        // Outlet count: snapshot from products, switch authStore for admins.
        if (isAdmin && locId) authStore.outletId = locId
        const items: StockCountItem[] = products.flatMap((p) =>
          p.variants.map((v) => ({
            productId: p.id,
            productName: p.name,
            variantSize: v.size,
            sku: v.sku,
            frozenQty: v.stock,
          })),
        )
        await api.createStockCount({
          name: form.name.trim(),
          outletId: isAdmin ? locId ?? '' : '',
          plannedDate: form.plannedDate,
          notes: form.notes.trim(),
          items,
        })
      }
      setOpen(false)
      setForm({ name: '', locationKey: '', plannedDate: new Date().toISOString().slice(0, 10), notes: '' })
      await scq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal membuat stock count.')
    } finally {
      authStore.outletId = prev
      setBusy(false)
    }
  }

  const start = async (sc: StockCount) => {
    setPageErr(null)
    try {
      await api.updateStockCount(sc.id, { status: 'in_progress' })
      setExpanded(sc.id)
    } catch (e) {
      fail(e, 'Gagal memulai stock count.')
    }
    await scq.refetch()
  }
  const cancel = async (sc: StockCount) => {
    setPageErr(null)
    try {
      await api.updateStockCount(sc.id, { status: 'cancelled' })
    } catch (e) {
      fail(e, 'Gagal membatalkan stock count.')
    }
    await scq.refetch()
  }
  const setQty = (sc: StockCount, it: StockCountItem, raw: string) => {
    const qty = raw.trim() === '' ? null : Math.max(0, parseInt(raw, 10) || 0)
    setEdits((d) => ({ ...d, [sc.id]: { ...(d[sc.id] ?? {}), [lineKey(it)]: qty } }))
  }
  // Save one line on blur/Enter so the server captures the stock at count time.
  const saveLine = async (sc: StockCount, it: StockCountItem) => {
    const key = lineKey(it)
    const v = edits[sc.id]?.[key]
    if (v === undefined) return
    setPageErr(null)
    try {
      await api.updateStockCount(sc.id, { items: [{ ...it, actualQty: v }] })
      clearEdits(sc.id, [key])
      await scq.refetch()
    } catch (e) {
      fail(e, 'Gagal menyimpan hitungan.')
    }
  }
  const saveProgress = async (sc: StockCount) => {
    const lines = pendingLines(sc)
    if (lines.length === 0) return
    setActiveId(sc.id)
    setPageErr(null)
    try {
      await api.updateStockCount(sc.id, { items: lines })
      clearEdits(sc.id, lines.map(lineKey))
      await scq.refetch()
    } catch (e) {
      fail(e, 'Gagal menyimpan progres.')
    } finally {
      setActiveId(null)
    }
  }
  const complete = async (sc: StockCount) => {
    const ok = window.confirm(
      'Selesaikan stock count? Selisih hitungan akan diterapkan ke stok saat ini. Penjualan yang terjadi selama penghitungan tetap dihitung.',
    )
    if (!ok) return
    setActiveId(sc.id)
    setPageErr(null)
    try {
      const lines = pendingLines(sc)
      await api.completeStockCount(sc.id, lines)
      clearEdits(sc.id, lines.map(lineKey))
      await Promise.all([scq.refetch(), pq.refetch()])
    } catch (e) {
      fail(e, 'Gagal menyelesaikan stock count.')
      await scq.refetch()
    } finally {
      setActiveId(null)
    }
  }

  const exportStockCounts = async (fmt: 'csv' | 'xlsx') => {
    const result = await api.listStockCounts(1, 10000)
    const exportRows = result.data.map((sc) => ({
      Nama: sc.name,
      Lokasi: locName(sc),
      'Tipe Lokasi': locKind(sc),
      Status:
        sc.status === 'planned' ? 'Direncanakan'
        : sc.status === 'in_progress' ? 'Sedang Berjalan'
        : sc.status === 'completed' ? 'Selesai'
        : 'Dibatalkan',
      'Tanggal Rencana': sc.plannedDate ?? '',
      Selesai: sc.completedAt ? sc.completedAt.slice(0, 10) : '',
      'Jumlah Item': sc.items.length,
    }))
    const scope = outletId ? (ctxOutlets.find((o) => o.id === outletId)?.name ?? null) : 'semua-outlet'
    const name = buildExportName('opname-produk', [scope])
    if (fmt === 'csv') exportToCSV(exportRows, name)
    else exportToXLSX(exportRows, name)
  }

  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid
  const locName = (sc: StockCount) =>
    sc.warehouseId
      ? warehouses.find((w) => w.id === sc.warehouseId)?.name ?? 'Gudang'
      : outletName(sc.outletId ?? '')

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Stock Count"
        subtitle="Selisih hitungan diterapkan ke stok saat ini. Transaksi tetap berjalan."
        actions={
          <>
            <ImportExportBar
              onExport={(fmt) => void exportStockCounts(fmt)}
              exportDisabled={scTotal === 0}
            />
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setErr(null); setOpen(true) }}>
              Buat Stock Count
            </Button>
          </>
        }
      />

      {pageErr && (
        <div role="alert" className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm flex justify-between gap-3">
          <span>{pageErr}</span>
          <button type="button" className="font-bold" onClick={() => setPageErr(null)}>Tutup</button>
        </div>
      )}

      <div className="space-y-3">
        {scq.loading ? (
          <TableSkeleton />
        ) : stockCounts.length === 0 ? (
          <Card>
            <EmptyState icon={<ClipboardList />} title="Belum ada stock count" />
          </Card>
        ) : (
          stockCounts.map((sc) => {
            const items = itemsFor(sc)
            return (
              <Card key={sc.id} className="overflow-hidden">
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gold-50 rounded-xl flex items-center justify-center">
                      <ClipboardList className="w-5 h-5 text-gold-600" />
                    </div>
                    <div>
                      <p className="font-bold text-gray-900">{sc.name}</p>
                      <p className="text-xs text-gray-400">
                        <span className="font-bold text-gray-500">{locKind(sc)}</span> {locName(sc)} · {sc.plannedDate ? format(parseISO(sc.plannedDate), 'dd MMM yyyy', { locale: idLocale }) : '—'} · {items.length} item
                        {sc.status === 'in_progress' && ` · ${items.filter((i) => i.actualQty != null).length}/${items.length} dihitung`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={tone(sc.status)}>{label(sc.status)}</Badge>
                    {sc.status === 'planned' && (
                      <Button size="sm" icon={<Play className="w-3 h-3" />} onClick={() => start(sc)}>
                        Mulai
                      </Button>
                    )}
                    {sc.status === 'in_progress' && (
                      <>
                        <Button variant="secondary" size="sm" loading={activeId === sc.id} onClick={() => saveProgress(sc)}>
                          Simpan
                        </Button>
                        <Button size="sm" icon={<CheckCircle className="w-3 h-3" />} disabled={activeId === sc.id} onClick={() => complete(sc)}>
                          Selesai
                        </Button>
                      </>
                    )}
                    {['planned', 'in_progress'].includes(sc.status) && (
                      <IconButton tone="danger" onClick={() => cancel(sc)}>
                        <XCircle className="w-4 h-4" />
                      </IconButton>
                    )}
                    <IconButton onClick={() => setExpanded(expanded === sc.id ? null : sc.id)}>
                      {expanded === sc.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </IconButton>
                  </div>
                </div>
                {expanded === sc.id && (
                  <div className="border-t border-gray-100 overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-gray-50">
                        <tr>
                          {['Produk', 'Varian', 'SKU', 'Stok Beku', 'Stok Aktual', 'Selisih', ...(sc.status === 'completed' ? ['Stok Sebelum → Sesudah'] : [])].map((h) => (
                            <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {items.map((it) => (
                          <tr key={`${it.productId}-${it.variantSize}`} className="hover:bg-gray-50">
                            <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.productName}</td>
                            <td className="px-4 py-2 text-xs text-gray-600">{it.variantSize}</td>
                            <td className="px-4 py-2 text-xs text-gray-400 font-mono">{it.sku}</td>
                            <td className="px-4 py-2 text-sm font-bold text-gold-700">{it.frozenQty}</td>
                            <td className="px-4 py-2">
                              {sc.status === 'in_progress' ? (
                                <div className="flex items-center gap-2">
                                  <input type="number" min={0} value={it.actualQty ?? ''} onChange={(e) => setQty(sc, it, e.target.value)} onBlur={() => void saveLine(sc, it)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} aria-label={`Jumlah aktual ${it.productName}${it.variantSize ? ` ${it.variantSize}` : ''}`} className={`${fieldClass} w-20 px-2 py-1 text-center`} />
                                  {it.countedAt && edits[sc.id]?.[lineKey(it)] === undefined && (
                                    <span className="text-[10px] text-gray-400">dihitung {format(parseISO(it.countedAt), 'HH:mm')}</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-sm font-bold text-gray-900">{it.actualQty ?? '—'}</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {(() => {
                                const diff = it.difference ?? (it.actualQty != null ? it.actualQty - (it.baselineQty ?? it.frozenQty) : null)
                                return diff != null ? (
                                  <span className={`text-sm font-black ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                                    {diff > 0 ? '+' : ''}{diff}
                                  </span>
                                ) : '—'
                              })()}
                            </td>
                            {sc.status === 'completed' && (
                              <td className="px-4 py-2 text-xs text-gray-600">
                                {it.stockBefore != null && it.stockAfter != null ? `${it.stockBefore} → ${it.stockAfter}` : '—'}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Buat Stock Count"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={createSC}>{busy ? 'Membuat...' : 'Buat Stock Count'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Nama *" type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          {isAdmin && (
            <Select label="Lokasi *" value={form.locationKey} onChange={(e) => setForm((f) => ({ ...f, locationKey: e.target.value }))}>
              <option value="">Pilih lokasi...</option>
              <optgroup label="Outlet">
                {outlets.map((o) => <option key={o.id} value={`o:${o.id}`}>{o.name}</option>)}
              </optgroup>
              <optgroup label="Gudang">
                {warehouses.map((w) => <option key={w.id} value={`w:${w.id}`}>{w.name}</option>)}
              </optgroup>
            </Select>
          )}
          <Input label="Tanggal Rencana" type="date" value={form.plannedDate} onChange={(e) => setForm((f) => ({ ...f, plannedDate: e.target.value }))} />
          <Textarea label="Catatan" rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          <div className="bg-amber-50 rounded-xl p-3 text-xs text-amber-700">
            Stok {products.length} produk aktif akan dibekukan sebagai referensi.
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>
    </div>
  )
}
