import { useState } from 'react'
import type { StockCount, StockCountItem, Product, Outlet, Warehouse, ListResult } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Play, CheckCircle, XCircle, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react'
import { api, authStore } from '../api'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { Button, Input, Select, Textarea, Modal, Card, Badge, IconButton, EmptyState, PageHeader, Pagination, fieldClass } from '../ui'

const PAGE_SIZE = 25

export default function StockCount() {
  const { outletId, outlets: ctxOutlets, isAdmin } = useOutlet()
  const [page, setPage] = useState(1)
  const scq = usePolledQuery<ListResult<StockCount>>(() => api.listStockCounts(page, PAGE_SIZE), [outletId, page])
  const pq = usePolledQuery<Product[]>(() => api.listProducts().then((r) => r.data.filter((p) => p.isActive)), [])
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const stockCounts = scq.data?.data ?? []
  const scTotal = scq.data?.meta?.total ?? 0
  const scTotalPages = Math.max(1, Math.ceil(scTotal / PAGE_SIZE))
  const products = pq.data ?? []
  const outlets = ctxOutlets.length ? ctxOutlets : ouq.data ?? []
  const warehouses = wq.data ?? []

  const [expanded, setExpanded] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, StockCountItem[]>>({})
  const [form, setForm] = useState({
    name: '',
    locationKey: '',
    plannedDate: new Date().toISOString().slice(0, 10),
    notes: '',
  })

  const itemsFor = (sc: StockCount) => draft[sc.id] ?? sc.items

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
    await api.updateStockCount(sc.id, { status: 'in_progress' })
    setExpanded(sc.id)
    await scq.refetch()
  }
  const cancel = async (sc: StockCount) => {
    await api.updateStockCount(sc.id, { status: 'cancelled' })
    await scq.refetch()
  }
  const setQty = (sc: StockCount, idx: number, qty: number) => {
    setDraft((d) => {
      const base = (d[sc.id] ?? sc.items).map((it) => ({ ...it }))
      base[idx] = { ...base[idx], actualQty: qty, difference: qty - base[idx].frozenQty }
      return { ...d, [sc.id]: base }
    })
  }
  const saveProgress = async (sc: StockCount) => {
    setActiveId(sc.id)
    try {
      await api.updateStockCount(sc.id, { items: itemsFor(sc) })
      await scq.refetch()
    } finally {
      setActiveId(null)
    }
  }
  const complete = async (sc: StockCount) => {
    setActiveId(sc.id)
    try {
      await api.completeStockCount(sc.id, itemsFor(sc))
      setDraft((d) => {
        const n = { ...d }
        delete n[sc.id]
        return n
      })
      await Promise.all([scq.refetch(), pq.refetch()])
    } finally {
      setActiveId(null)
    }
  }

  const tone = (s: string): 'gold' | 'success' | 'danger' | 'neutral' =>
    s === 'in_progress' ? 'gold' : s === 'completed' ? 'success' : s === 'cancelled' ? 'danger' : 'neutral'
  const label = (s: string) =>
    s === 'planned' ? 'Direncanakan' : s === 'in_progress' ? 'Sedang Berjalan' : s === 'completed' ? 'Selesai' : 'Dibatalkan'
  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid
  const locName = (sc: StockCount) =>
    sc.warehouseId
      ? warehouses.find((w) => w.id === sc.warehouseId)?.name ?? 'Gudang'
      : outletName(sc.outletId ?? '')
  const locKind = (sc: StockCount) => (sc.warehouseId ? 'Gudang' : 'Outlet')

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Stock Count"
        subtitle="Stok dibekukan saat penghitungan. Transaksi tetap berjalan."
        actions={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setErr(null); setOpen(true) }}>
            Buat Stock Count
          </Button>
        }
      />

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
                          {['Produk', 'Varian', 'SKU', 'Stok Beku', 'Stok Aktual', 'Selisih'].map((h) => (
                            <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {items.map((it, idx) => (
                          <tr key={`${it.productId}-${it.variantSize}`} className="hover:bg-gray-50">
                            <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.productName}</td>
                            <td className="px-4 py-2 text-xs text-gray-600">{it.variantSize}</td>
                            <td className="px-4 py-2 text-xs text-gray-400 font-mono">{it.sku}</td>
                            <td className="px-4 py-2 text-sm font-bold text-gold-700">{it.frozenQty}</td>
                            <td className="px-4 py-2">
                              {sc.status === 'in_progress' ? (
                                <input type="number" value={it.actualQty ?? ''} onChange={(e) => setQty(sc, idx, parseInt(e.target.value) || 0)} className={`${fieldClass} w-20 px-2 py-1 text-center`} />
                              ) : (
                                <span className="text-sm font-bold text-gray-900">{it.actualQty ?? '—'}</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {it.difference != null ? (
                                <span className={`text-sm font-black ${it.difference > 0 ? 'text-green-600' : it.difference < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                                  {it.difference > 0 ? '+' : ''}{it.difference}
                                </span>
                              ) : '—'}
                            </td>
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

      {scTotalPages > 1 && (
        <Pagination page={page} totalPages={scTotalPages} total={scTotal} onChange={setPage} />
      )}

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
