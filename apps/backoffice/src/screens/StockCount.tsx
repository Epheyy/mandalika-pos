import { useState } from 'react'
import type { StockCount, StockCountItem, Product, Outlet } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, X, Play, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react'
import { api, authStore } from '../api'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'

export default function StockCount() {
  const { outletId, outlets: ctxOutlets, isAdmin } = useOutlet()
  const scq = usePolledQuery<StockCount[]>(() => api.listStockCounts().then((r) => r.data), [outletId])
  const pq = usePolledQuery<Product[]>(() => api.listProducts().then((r) => r.data.filter((p) => p.isActive)), [])
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const stockCounts = scq.data ?? []
  const products = pq.data ?? []
  const outlets = ctxOutlets.length ? ctxOutlets : ouq.data ?? []

  const [expanded, setExpanded] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, StockCountItem[]>>({})
  const [form, setForm] = useState({
    name: '',
    outletId: '',
    plannedDate: new Date().toISOString().slice(0, 10),
    notes: '',
  })

  const itemsFor = (sc: StockCount) => draft[sc.id] ?? sc.items

  const createSC = async () => {
    if (!form.name.trim()) return setErr('Nama wajib diisi')
    const targetOutlet = isAdmin ? form.outletId : null
    if (isAdmin && !targetOutlet) return setErr('Pilih outlet')
    setBusy(true)
    setErr(null)
    const prev = authStore.outletId
    try {
      if (isAdmin) authStore.outletId = targetOutlet
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
        outletId: targetOutlet ?? '',
        plannedDate: form.plannedDate,
        notes: form.notes.trim(),
        items,
      })
      setOpen(false)
      setForm({ name: '', outletId: '', plannedDate: new Date().toISOString().slice(0, 10), notes: '' })
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

  const badge = (s: string) =>
    s === 'planned' ? 'bg-blue-50 text-blue-700' : s === 'in_progress' ? 'bg-yellow-50 text-yellow-700' : s === 'completed' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
  const label = (s: string) =>
    s === 'planned' ? 'Direncanakan' : s === 'in_progress' ? 'Sedang Berjalan' : s === 'completed' ? 'Selesai' : 'Dibatalkan'
  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Stock Count</h2>
          <p className="text-sm text-gray-400">Stok dibekukan saat penghitungan. Transaksi tetap berjalan.</p>
        </div>
        <button onClick={() => { setErr(null); setOpen(true) }} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
          <Plus className="w-4 h-4" /> Buat Stock Count
        </button>
      </div>

      <div className="space-y-3">
        {scq.loading ? (
          <TableSkeleton />
        ) : stockCounts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300">
            <ClipboardList className="w-12 h-12" />
            <p className="font-bold">Belum ada stock count</p>
          </div>
        ) : (
          stockCounts.map((sc) => {
            const items = itemsFor(sc)
            return (
              <div key={sc.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center">
                      <ClipboardList className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div>
                      <p className="font-bold text-gray-900">{sc.name}</p>
                      <p className="text-xs text-gray-400">
                        {outletName(sc.outletId)} · {sc.plannedDate ? format(parseISO(sc.plannedDate), 'dd MMM yyyy', { locale: idLocale }) : '—'} · {items.length} item
                        {sc.status === 'in_progress' && ` · ${items.filter((i) => i.actualQty != null).length}/${items.length} dihitung`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${badge(sc.status)}`}>{label(sc.status)}</span>
                    {sc.status === 'planned' && (
                      <button onClick={() => start(sc)} className="flex items-center gap-1 px-3 py-1.5 bg-yellow-500 hover:bg-yellow-600 text-white text-xs font-bold rounded-xl">
                        <Play className="w-3 h-3" /> Mulai
                      </button>
                    )}
                    {sc.status === 'in_progress' && (
                      <>
                        <button onClick={() => saveProgress(sc)} disabled={activeId === sc.id} className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-bold rounded-xl">
                          {activeId === sc.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Simpan
                        </button>
                        <button onClick={() => complete(sc)} disabled={activeId === sc.id} className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-xl">
                          <CheckCircle className="w-3 h-3" /> Selesai
                        </button>
                      </>
                    )}
                    {['planned', 'in_progress'].includes(sc.status) && (
                      <button onClick={() => cancel(sc)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg">
                        <XCircle className="w-4 h-4" />
                      </button>
                    )}
                    <button onClick={() => setExpanded(expanded === sc.id ? null : sc.id)} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg">
                      {expanded === sc.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
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
                            <td className="px-4 py-2 text-sm font-bold text-blue-600">{it.frozenQty}</td>
                            <td className="px-4 py-2">
                              {sc.status === 'in_progress' ? (
                                <input type="number" value={it.actualQty ?? ''} onChange={(e) => setQty(sc, idx, parseInt(e.target.value) || 0)} className="w-20 px-2 py-1 bg-gray-50 border border-gray-200 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500" />
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
              </div>
            )
          })
        )}
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">Buat Stock Count</h2>
              <button onClick={() => setOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama *</label>
                <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              {isAdmin && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Outlet *</label>
                  <select value={form.outletId} onChange={(e) => setForm((f) => ({ ...f, outletId: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="">Pilih outlet...</option>
                    {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tanggal Rencana</label>
                <input type="date" value={form.plannedDate} onChange={(e) => setForm((f) => ({ ...f, plannedDate: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Catatan</label>
                <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="bg-yellow-50 rounded-xl p-3 text-xs text-yellow-700">
                Stok {products.length} produk aktif akan dibekukan sebagai referensi.
              </div>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={createSC} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Membuat...</> : 'Buat Stock Count'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
