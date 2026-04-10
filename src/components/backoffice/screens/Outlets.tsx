import { useState, useEffect } from 'react'
import type { AppUser, Outlet } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, orderBy, limit } from 'firebase/firestore'
import { Plus, Edit2, Trash2, X, Store, MapPin, Phone, Loader2, ToggleLeft, ToggleRight, RefreshCw } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

interface SyncLog {
  id: string
  cashierId: string
  cashierName: string
  outletId: string
  syncedAt: string
  counts: { products: number; categories: number; promotions: number }
}

interface Props { appUser?: AppUser }

const EMPTY_OUTLET = { name: '', address: '', phone: '', isActive: true }

export default function Outlets({ appUser: _appUser }: Props) {
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingOutlet, setEditingOutlet] = useState<Outlet | null>(null)
  const [formData, setFormData] = useState(EMPTY_OUTLET)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([])

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'outlets'), snap => {
      setOutlets(snap.docs.map(d => ({ id: d.id, ...d.data() } as Outlet)))
      setIsLoading(false)
    })
    const u2 = onSnapshot(
      query(collection(db, 'syncLogs'), orderBy('syncedAt', 'desc'), limit(50)),
      snap => setSyncLogs(snap.docs.map(d => ({ id: d.id, ...d.data() } as SyncLog)))
    )
    return () => { u1(); u2() }
  }, [])

  const openAdd = () => {
    setEditingOutlet(null)
    setFormData(EMPTY_OUTLET)
    setIsModalOpen(true)
  }

  const openEdit = (outlet: Outlet) => {
    setEditingOutlet(outlet)
    setFormData({ name: outlet.name, address: outlet.address || '', phone: outlet.phone || '', isActive: outlet.isActive })
    setIsModalOpen(true)
  }

  const handleSave = async () => {
    if (!formData.name.trim()) { alert('Nama outlet wajib diisi'); return }
    setIsSubmitting(true)
    try {
      const data = {
        name: formData.name.trim(),
        address: formData.address.trim(),
        phone: formData.phone.trim(),
        isActive: formData.isActive,
      }
      if (editingOutlet?.id) {
        await updateDoc(doc(db, 'outlets', editingOutlet.id), data)
      } else {
        await addDoc(collection(db, 'outlets'), { ...data, createdAt: new Date().toISOString() })
      }
      setIsModalOpen(false)
    } catch {
      alert('Gagal menyimpan outlet.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'outlets', id))
      setDeleteConfirmId(null)
    } catch {
      alert('Gagal menghapus outlet.')
    }
  }

  const toggleActive = async (outlet: Outlet) => {
    if (!outlet.id) return
    await updateDoc(doc(db, 'outlets', outlet.id), { isActive: !outlet.isActive })
  }

  return (
    <div className="p-6 space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Outlet</h2>
          <p className="text-sm text-gray-400">{outlets.length} outlet terdaftar</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-100"
        >
          <Plus className="w-4 h-4" />
          Tambah Outlet
        </button>
      </div>

      {/* Outlets Grid */}
      {isLoading ? (
        <div className="text-center text-gray-300 py-8">Memuat outlet...</div>
      ) : outlets.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300">
          <Store className="w-12 h-12" />
          <p className="font-bold">Belum ada outlet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {outlets.map(outlet => (
            <div key={outlet.id} className={`bg-white rounded-2xl border-2 p-5 transition-all ${outlet.isActive ? 'border-gray-100' : 'border-gray-100 opacity-60'}`}>

              {/* Top row */}
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Store className="w-5 h-5 text-indigo-600" />
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => openEdit(outlet)} className="p-1.5 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-lg transition-all">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setDeleteConfirmId(outlet.id!)} className="p-1.5 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Name */}
              <h3 className="font-black text-gray-900 mb-2">{outlet.name}</h3>

              {/* Details */}
              <div className="space-y-1.5">
                {outlet.address && (
                  <div className="flex items-start gap-2 text-xs text-gray-500">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>{outlet.address}</span>
                  </div>
                )}
                {outlet.phone && (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{outlet.phone}</span>
                  </div>
                )}
              </div>

              {/* Active toggle */}
              <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
                <span className={`text-xs font-bold ${outlet.isActive ? 'text-green-600' : 'text-gray-400'}`}>
                  {outlet.isActive ? 'Aktif' : 'Nonaktif'}
                </span>
                <button onClick={() => toggleActive(outlet)} className="text-gray-400 hover:text-indigo-600 transition-colors">
                  {outlet.isActive
                    ? <ToggleRight className="w-6 h-6 text-indigo-600" />
                    : <ToggleLeft className="w-6 h-6" />
                  }
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sync Logs */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-gray-400" />
          <h3 className="font-black text-gray-900">Log Sinkronisasi Kasir</h3>
          <span className="text-xs text-gray-400 font-normal">— 50 terakhir</span>
        </div>
        {syncLogs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-300 text-sm">
            Belum ada log sinkronisasi
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {/* Group by cashier: show one row per unique cashier with their latest sync */}
            {(() => {
              const byId: Record<string, SyncLog> = {}
              syncLogs.forEach(log => {
                if (!byId[log.cashierId]) byId[log.cashierId] = log
              })
              return Object.values(byId).map(log => (
                <div key={log.cashierId} className="flex items-center justify-between px-5 py-3 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-black text-indigo-600">
                        {log.cashierName.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900">{log.cashierName}</p>
                      <p className="text-xs text-gray-400">
                        {log.counts.products} produk · {log.counts.categories} kategori · {log.counts.promotions} promosi
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-bold text-gray-700">
                      {format(parseISO(log.syncedAt), 'dd MMM yyyy', { locale: idLocale })}
                    </p>
                    <p className="text-xs text-gray-400">
                      {format(parseISO(log.syncedAt), 'HH:mm', { locale: idLocale })}
                    </p>
                  </div>
                </div>
              ))
            })()}
          </div>
        )}
        {/* Full history collapsible */}
        {syncLogs.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-xs text-indigo-600 font-bold hover:text-indigo-800 select-none">
              Lihat semua riwayat ({syncLogs.length})
            </summary>
            <div className="mt-2 bg-white rounded-2xl border border-gray-100 overflow-hidden">
              {syncLogs.map(log => (
                <div key={log.id} className="flex items-center justify-between px-5 py-2.5 border-b border-gray-50 last:border-0">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{log.cashierName}</p>
                    <p className="text-xs text-gray-400">{log.counts.products}P · {log.counts.categories}K · {log.counts.promotions}PR</p>
                  </div>
                  <p className="text-xs text-gray-500">
                    {format(parseISO(log.syncedAt), 'dd MMM HH:mm', { locale: idLocale })}
                  </p>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Add/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editingOutlet ? 'Edit Outlet' : 'Tambah Outlet'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl transition-all">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Outlet *</label>
                <input type="text" value={formData.name} onChange={e => setFormData(f => ({ ...f, name: e.target.value }))} placeholder="Contoh: Mandalika - Tunjungan Plaza" className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Alamat</label>
                <textarea value={formData.address} onChange={e => setFormData(f => ({ ...f, address: e.target.value }))} placeholder="Alamat lengkap outlet..." rows={2} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">No. Telepon</label>
                <input type="tel" value={formData.phone} onChange={e => setFormData(f => ({ ...f, phone: e.target.value }))} placeholder="031-xxxxxxx" className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formData.isActive} onChange={e => setFormData(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Outlet Aktif</span>
              </label>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setIsModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 transition-all">Batal</button>
              <button onClick={handleSave} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl transition-all flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : editingOutlet ? 'Simpan' : 'Tambah'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Trash2 className="w-7 h-7 text-red-500" />
            </div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Outlet?</h3>
            <p className="text-sm text-gray-400 mb-6">Data outlet akan terhapus permanen.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50">Batal</button>
              <button onClick={() => handleDelete(deleteConfirmId)} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl transition-all">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}