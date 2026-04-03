import { useState, useEffect } from 'react'
import type { AppUser, StockCount, StockCountItem, Product, Outlet } from '../../../types'
import { StockCountStatus } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, addDoc, updateDoc, doc, query, orderBy } from 'firebase/firestore'
import { Plus, X, Play, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

interface Props { appUser: AppUser }

export default function StockCountScreen({ appUser }: Props) {
  const [stockCounts, setStockCounts] = useState<StockCount[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [activeCountId, setActiveCountId] = useState<string | null>(null)

  const [form, setForm] = useState({ name: '', outletId: '', plannedDate: new Date().toISOString().slice(0, 10), notes: '' })

  useEffect(() => {
    const u1 = onSnapshot(query(collection(db, 'stockCounts'), orderBy('createdAt', 'desc')), s => {
      setStockCounts(s.docs.map(d => ({ id: d.id, ...d.data() } as StockCount)))
      setIsLoading(false)
    })
    const u2 = onSnapshot(collection(db, 'products'), s => setProducts(s.docs.map(d => ({ id: d.id, ...d.data() } as Product)).filter(p => p.isActive)))
    const u3 = onSnapshot(collection(db, 'outlets'), s => setOutlets(s.docs.map(d => ({ id: d.id, ...d.data() } as Outlet))))
    return () => { u1(); u2(); u3() }
  }, [])

  const createStockCount = async () => {
    if (!form.name.trim()) { alert('Nama stock count wajib diisi'); return }
    if (!form.outletId) { alert('Pilih outlet'); return }
    setIsSubmitting(true)
    try {
      // Snapshot current stock as frozen quantities
      const items: StockCountItem[] = products.flatMap(p =>
        p.variants.map(v => ({
          productId: p.id!,
          productName: p.name,
          variantSize: v.size,
          sku: v.sku,
          frozenQty: v.stock,
          actualQty: undefined,
          difference: undefined,
        }))
      )
      const sc: Omit<StockCount, 'id'> = {
        name: form.name.trim(),
        status: StockCountStatus.PLANNED,
        outletId: form.outletId,
        plannedDate: form.plannedDate,
        items,
        notes: form.notes.trim(),
        createdBy: appUser.uid,
        createdAt: new Date().toISOString(),
      }
      await addDoc(collection(db, 'stockCounts'), sc)
      setIsModalOpen(false)
      setForm({ name: '', outletId: '', plannedDate: new Date().toISOString().slice(0, 10), notes: '' })
    } catch { alert('Gagal membuat stock count.') }
    finally { setIsSubmitting(false) }
  }

  const startCount = async (sc: StockCount) => {
    if (!sc.id) return
    await updateDoc(doc(db, 'stockCounts', sc.id), {
      status: StockCountStatus.IN_PROGRESS,
      startedAt: new Date().toISOString(),
    })
    setExpandedId(sc.id)
  }

  const updateActualQty = (scId: string, itemIndex: number, qty: number) => {
    setStockCounts(prev => prev.map(sc => {
      if (sc.id !== scId) return sc
      const items = [...sc.items]
      items[itemIndex] = { ...items[itemIndex], actualQty: qty, difference: qty - items[itemIndex].frozenQty }
      return { ...sc, items }
    }))
  }

  const saveCountProgress = async (sc: StockCount) => {
    if (!sc.id) return
    setActiveCountId(sc.id)
    try {
      await updateDoc(doc(db, 'stockCounts', sc.id), { items: sc.items })
      alert('Progress disimpan!')
    } catch { alert('Gagal menyimpan.') }
    finally { setActiveCountId(null) }
  }

  const completeCount = async (sc: StockCount) => {
    if (!sc.id) return
    const incomplete = sc.items.filter(i => i.actualQty === undefined || i.actualQty === null)
    if (incomplete.length > 0) {
      if (!confirm(`${incomplete.length} item belum dihitung. Tetap selesaikan?`)) return
    }
    if (!confirm('Selesaikan stock count dan update stok produk?')) return
    setActiveCountId(sc.id)
    try {
      // Update products with actual quantities
      const productMap = new Map<string, StockCountItem[]>()
      sc.items.forEach(item => {
        if (item.actualQty !== undefined) {
          if (!productMap.has(item.productId)) productMap.set(item.productId, [])
          productMap.get(item.productId)!.push(item)
        }
      })

      for (const [productId, items] of productMap.entries()) {
        const product = products.find(p => p.id === productId)
        if (!product) continue
        const updatedVariants = product.variants.map(v => {
          const countItem = items.find(i => i.variantSize === v.size)
          return countItem ? { ...v, stock: countItem.actualQty! } : v
        })
        await updateDoc(doc(db, 'products', productId), { variants: updatedVariants })
      }

      await updateDoc(doc(db, 'stockCounts', sc.id), {
        status: StockCountStatus.COMPLETED,
        completedAt: new Date().toISOString(),
        items: sc.items,
      })
      alert('Stock count selesai! Stok produk telah diperbarui.')
    } catch { alert('Gagal menyelesaikan stock count.') }
    finally { setActiveCountId(null) }
  }

  const cancelCount = async (sc: StockCount) => {
    if (!sc.id || !confirm('Batalkan stock count ini?')) return
    await updateDoc(doc(db, 'stockCounts', sc.id), { status: StockCountStatus.CANCELLED })
  }

  const getStatusBadge = (status: StockCountStatus) => {
    switch (status) {
      case 'planned': return 'bg-blue-50 text-blue-700'
      case 'in_progress': return 'bg-yellow-50 text-yellow-700'
      case 'completed': return 'bg-green-50 text-green-700'
      case 'cancelled': return 'bg-gray-100 text-gray-500'
    }
  }

  const getStatusLabel = (status: StockCountStatus) => {
    switch (status) {
      case 'planned': return 'Direncanakan'
      case 'in_progress': return 'Sedang Berjalan'
      case 'completed': return 'Selesai'
      case 'cancelled': return 'Dibatalkan'
    }
  }

  const getOutletName = (id: string) => outlets.find(o => o.id === id)?.name || id

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Stock Count</h2>
          <p className="text-sm text-gray-400">Stok produk dibekukan saat penghitungan. Transaksi tetap berjalan normal.</p>
        </div>
        <button onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-indigo-100">
          <Plus className="w-4 h-4" /> Buat Stock Count
        </button>
      </div>

      <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 text-sm text-indigo-700">
        <p className="font-bold mb-1">Cara Kerja:</p>
        <p>1. Buat stock count → stok saat ini dibekukan sebagai referensi</p>
        <p>2. Mulai penghitungan → input jumlah fisik aktual per item</p>
        <p>3. Kasir tetap bisa bertransaksi (stok live tetap berjalan normal)</p>
        <p>4. Selesaikan → stok produk diperbarui dengan hasil hitungan aktual</p>
      </div>

      {/* Stock count list */}
      <div className="space-y-3">
        {isLoading ? <div className="text-center text-gray-300 py-8">Memuat...</div>
          : stockCounts.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300">
              <ClipboardList className="w-12 h-12" />
              <p className="font-bold">Belum ada stock count</p>
            </div>
          ) : stockCounts.map(sc => (
            <div key={sc.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              {/* Header */}
              <div className="px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center">
                    <ClipboardList className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <p className="font-bold text-gray-900">{sc.name}</p>
                    <p className="text-xs text-gray-400">
                      {getOutletName(sc.outletId)} ·
                      Rencana: {format(parseISO(sc.plannedDate), 'dd MMM yyyy', { locale: idLocale })} ·
                      {sc.items.length} item ·
                      {sc.status === 'in_progress' && ` ${sc.items.filter(i => i.actualQty !== undefined).length}/${sc.items.length} dihitung`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${getStatusBadge(sc.status)}`}>
                    {getStatusLabel(sc.status)}
                  </span>
                  {/* Action buttons */}
                  {sc.status === 'planned' && (
                    <button onClick={() => startCount(sc)} className="flex items-center gap-1 px-3 py-1.5 bg-yellow-500 hover:bg-yellow-600 text-white text-xs font-bold rounded-xl">
                      <Play className="w-3 h-3" /> Mulai
                    </button>
                  )}
                  {sc.status === 'in_progress' && (
                    <>
                      <button onClick={() => saveCountProgress(sc)} disabled={activeCountId === sc.id}
                        className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-bold rounded-xl">
                        {activeCountId === sc.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Simpan
                      </button>
                      <button onClick={() => completeCount(sc)} disabled={activeCountId === sc.id}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-xl">
                        <CheckCircle className="w-3 h-3" /> Selesai
                      </button>
                    </>
                  )}
                  {['planned', 'in_progress'].includes(sc.status) && (
                    <button onClick={() => cancelCount(sc)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg">
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                  <button onClick={() => setExpandedId(expandedId === sc.id ? null : sc.id!)}
                    className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg">
                    {expandedId === sc.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Expanded items */}
              {expandedId === sc.id && (
                <div className="border-t border-gray-100 overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr>
                        {['Produk', 'Varian', 'SKU', 'Stok Beku', 'Stok Aktual', 'Selisih'].map(h => (
                          <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {sc.items.map((item, idx) => (
                        <tr key={`${item.productId}-${item.variantSize}`} className="hover:bg-gray-50">
                          <td className="px-4 py-2 text-sm font-bold text-gray-900">{item.productName}</td>
                          <td className="px-4 py-2 text-xs text-gray-600">{item.variantSize}</td>
                          <td className="px-4 py-2 text-xs text-gray-400 font-mono">{item.sku}</td>
                          <td className="px-4 py-2 text-sm font-bold text-blue-600">{item.frozenQty}</td>
                          <td className="px-4 py-2">
                            {sc.status === 'in_progress' ? (
                              <input type="number" value={item.actualQty ?? ''}
                                onChange={e => updateActualQty(sc.id!, idx, parseInt(e.target.value) || 0)}
                                className="w-20 px-2 py-1 bg-gray-50 border border-gray-200 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            ) : (
                              <span className="text-sm font-bold text-gray-900">{item.actualQty ?? '—'}</span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            {item.difference !== undefined ? (
                              <span className={`text-sm font-black ${item.difference > 0 ? 'text-green-600' : item.difference < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                                {item.difference > 0 ? '+' : ''}{item.difference}
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
          ))
        }
      </div>

      {/* Create modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">Buat Stock Count</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama *</label>
                <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Contoh: Stock Count April 2026"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Outlet *</label>
                <select value={form.outletId} onChange={e => setForm(f => ({ ...f, outletId: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Pilih outlet...</option>
                  {outlets.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tanggal Rencana</label>
                <input type="date" value={form.plannedDate} onChange={e => setForm(f => ({ ...f, plannedDate: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Catatan</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2} placeholder="Instruksi tambahan..."
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="bg-yellow-50 rounded-xl p-3 text-xs text-yellow-700">
                <p className="font-bold">Perhatian:</p>
                <p>Saat dibuat, stok semua {products.length} produk aktif akan dibekukan sebagai referensi penghitungan.</p>
              </div>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setIsModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={createStockCount} disabled={isSubmitting}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Membuat...</> : 'Buat Stock Count'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}