import { useState } from 'react'
import type { Outlet } from '@mandalika/api'
import { Plus, Edit2, X, Store, MapPin, Phone, Loader2, ToggleLeft, ToggleRight } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'

const EMPTY = { name: '', code: '', address: '', phone: '', isActive: true }

export default function Outlets() {
  const q = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const outlets = q.data ?? []
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Outlet | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const openAdd = () => {
    setEditing(null)
    setForm(EMPTY)
    setErr(null)
    setOpen(true)
  }
  const openEdit = (o: Outlet) => {
    setEditing(o)
    setForm({ name: o.name, code: o.code || '', address: o.address || '', phone: o.phone || '', isActive: o.isActive })
    setErr(null)
    setOpen(true)
  }

  const save = async () => {
    if (!form.name.trim()) {
      setErr('Nama outlet wajib diisi')
      return
    }
    const code = form.code.trim().toUpperCase()
    if (!/^[A-Z0-9]{2,4}$/.test(code)) {
      setErr('Kode wajib 2–4 huruf/angka (mis. JKT) — dipakai sebagai prefix no. order')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body = {
        name: form.name.trim(),
        code,
        address: form.address.trim(),
        phone: form.phone.trim(),
        isActive: form.isActive,
      }
      if (editing) await api.updateOutlet(editing.id, body)
      else await api.createOutlet(body)
      setOpen(false)
      await q.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan outlet.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (o: Outlet) => {
    await api.updateOutlet(o.id, {
      name: o.name,
      code: o.code || '',
      address: o.address || '',
      phone: o.phone || '',
      isActive: !o.isActive,
    })
    await q.refetch()
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Outlet</h2>
          <p className="text-sm text-gray-400">{outlets.length} outlet terdaftar</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-100">
          <Plus className="w-4 h-4" /> Tambah Outlet
        </button>
      </div>

      {q.loading ? (
        <TableSkeleton />
      ) : outlets.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300">
          <Store className="w-12 h-12" />
          <p className="font-bold">Belum ada outlet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {outlets.map((o) => (
            <div key={o.id} className={`bg-white rounded-2xl border-2 border-gray-100 p-5 ${o.isActive ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Store className="w-5 h-5 text-indigo-600" />
                </div>
                <button onClick={() => openEdit(o)} className="p-1.5 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-lg">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <h3 className="font-black text-gray-900 mb-2">{o.name}</h3>
              <div className="space-y-1.5">
                {o.address && (
                  <div className="flex items-start gap-2 text-xs text-gray-500">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>{o.address}</span>
                  </div>
                )}
                {o.phone && (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{o.phone}</span>
                  </div>
                )}
              </div>
              <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
                <span className={`text-xs font-bold ${o.isActive ? 'text-green-600' : 'text-gray-400'}`}>
                  {o.isActive ? 'Aktif' : 'Nonaktif'}
                </span>
                <button onClick={() => toggle(o)} className="text-gray-400 hover:text-indigo-600">
                  {o.isActive ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editing ? 'Edit Outlet' : 'Tambah Outlet'}</h2>
              <button onClick={() => setOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Outlet *</label>
                <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Kode *</label>
                <input type="text" value={form.code} maxLength={4}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))}
                  placeholder="mis. JKT"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <p className="text-[11px] text-gray-400 mt-1">2–4 huruf/angka, unik. Prefix nomor order: <span className="font-mono">{(form.code || 'JKT')}-A0042</span></p>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Alamat</label>
                <textarea value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">No. Telepon</label>
                <input type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Outlet Aktif</span>
              </label>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={save} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : editing ? 'Simpan' : 'Tambah'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
