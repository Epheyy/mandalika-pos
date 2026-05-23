import { useRef, useState } from 'react'
import type { User, CustomRole, Outlet } from '@mandalika/api'
import { Edit2, X, Users as UsersIcon, Shield, Loader2, Check, Plus, Trash2, Download, Upload, Store } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { exportToCSV, parseCSV } from '../lib/csvUtils'

type Role = 'admin' | 'manager' | 'cashier'
const PERMS: Record<string, { label: string; desc: string }> = {
  view_dashboard: { label: 'Lihat Dashboard', desc: 'Akses ringkasan & grafik' },
  view_transactions: { label: 'Lihat Transaksi', desc: 'Riwayat semua transaksi' },
  manage_products: { label: 'Kelola Produk', desc: 'Tambah, edit, hapus produk' },
  manage_customers: { label: 'Kelola Pelanggan', desc: 'Akses data pelanggan' },
  manage_outlets: { label: 'Kelola Outlet', desc: 'Tambah dan edit outlet' },
  manage_users: { label: 'Kelola Pengguna', desc: 'Atur role & akses' },
  process_refund: { label: 'Proses Refund', desc: 'Memproses pengembalian dana' },
  manage_promotions: { label: 'Kelola Promosi', desc: 'Buat dan edit promosi' },
  view_reports: { label: 'Lihat Laporan', desc: 'Akses laporan & export' },
  manage_settings: { label: 'Pengaturan', desc: 'Ubah konfigurasi sistem' },
  manage_stock_count: { label: 'Stock Count', desc: 'Kelola penghitungan stok' },
}
const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', manager: 'Manager', cashier: 'Kasir' }
const ROLE_COLOR: Record<Role, string> = {
  admin: 'bg-red-50 text-red-700',
  manager: 'bg-indigo-50 text-indigo-700',
  cashier: 'bg-green-50 text-green-700',
}

export default function Users() {
  const { user: me } = useAuth()
  const uq = usePolledQuery<User[]>(() => api.listUsers().then((r) => r.data), [])
  const rq = usePolledQuery<CustomRole[]>(() => api.listCustomRoles(), [])
  const oq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const users = uq.data ?? []
  const roles = rq.data ?? []
  const outlets = oq.data ?? []
  const outletNameOf = (id?: string | null) => outlets.find((o) => o.id === id)?.name
  const [tab, setTab] = useState<'users' | 'roles'>('users')
  const csvRef = useRef<HTMLInputElement>(null)

  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [editRole, setEditRole] = useState<Role>('cashier')
  const [editPerms, setEditPerms] = useState<string[]>([])
  const [editOutletId, setEditOutletId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [nf, setNf] = useState({ displayName: '', email: '', password: '', role: 'cashier' as Role, outletId: '', permissions: [] as string[] })

  const [roleOpen, setRoleOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null)
  const [roleForm, setRoleForm] = useState({ name: '', permissions: [] as string[] })
  const [delRole, setDelRole] = useState<string | null>(null)

  const saveUser = async () => {
    if (!editingUser) return
    setBusy(true)
    try {
      await api.updateUser(editingUser.id, { role: editRole, permissions: editPerms, outletId: editOutletId || null })
      setEditingUser(null)
      await uq.refetch()
    } finally {
      setBusy(false)
    }
  }

  const addUser = async () => {
    if (!nf.displayName.trim() || !nf.email.trim() || !nf.password) return
    setBusy(true)
    try {
      await api.createUser({
        email: nf.email.trim(),
        password: nf.password,
        displayName: nf.displayName.trim(),
        role: nf.role,
        outletId: nf.outletId || null,
        permissions: nf.permissions,
      })
      setAddOpen(false)
      setNf({ displayName: '', email: '', password: '', role: 'cashier', outletId: '', permissions: [] })
      await uq.refetch()
    } finally {
      setBusy(false)
    }
  }

  const importUsers = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    for (const row of parseCSV(await file.text())) {
      if (!row['Email']?.trim()) continue
      await api.createUser({
        email: row['Email'].trim(),
        password: row['Password'] || 'changeme123',
        displayName: row['Nama'] || row['Email'],
        role: (row['Role'] as Role) || 'cashier',
        outletId: row['Outlet'] ? (outlets.find((o) => o.name === row['Outlet'].trim())?.id ?? null) : null,
        permissions: row['Permissions'] ? row['Permissions'].split(';').filter(Boolean) : [],
      })
    }
    e.target.value = ''
    await uq.refetch()
  }

  const saveRole = async () => {
    if (!roleForm.name.trim()) return
    setBusy(true)
    try {
      if (editingRole) await api.updateCustomRole(editingRole.id, roleForm)
      else await api.createCustomRole(roleForm)
      setRoleOpen(false)
      await rq.refetch()
    } finally {
      setBusy(false)
    }
  }

  const togglePerm = (p: string, set: React.Dispatch<React.SetStateAction<string[]>>) =>
    set((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]))

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Pengguna</h2>
          <p className="text-sm text-gray-400">{users.length} pengguna · {roles.length} role kustom</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {(['users', 'roles'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                {t === 'users' ? 'Pengguna' : 'Manajemen Role'}
              </button>
            ))}
          </div>
          {tab === 'users' && (
            <>
              <button onClick={() => exportToCSV(users.map((u) => ({ Nama: u.displayName, Email: u.email, Role: u.role, Outlet: outletNameOf(u.outletId) || '', Permissions: (u.permissions || []).join(';'), Terdaftar: u.createdAt?.slice(0, 10) || '' })), 'pengguna_mandalika')} className="flex items-center gap-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl text-xs">
                <Download className="w-3.5 h-3.5" /> Export
              </button>
              <button onClick={() => csvRef.current?.click()} className="flex items-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs">
                <Upload className="w-3.5 h-3.5" /> Import
              </button>
              <input ref={csvRef} type="file" accept=".csv" onChange={importUsers} className="hidden" />
              <button onClick={() => setAddOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
                <Plus className="w-4 h-4" /> Tambah
              </button>
            </>
          )}
          {tab === 'roles' && (
            <button onClick={() => { setEditingRole(null); setRoleForm({ name: '', permissions: [] }); setRoleOpen(true) }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
              <Plus className="w-4 h-4" /> Buat Role
            </button>
          )}
        </div>
      </div>

      {tab === 'users' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {uq.loading ? (
            <TableSkeleton />
          ) : users.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-gray-300"><UsersIcon className="w-12 h-12" /><p className="font-bold">Belum ada pengguna</p></div>
          ) : (
            <div className="divide-y divide-gray-50">
              {users.map((u) => (
                <div key={u.id} className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50">
                  <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {u.photoURL ? <img src={u.photoURL} alt="" className="w-full h-full object-cover" /> : <span className="text-sm font-black text-indigo-600">{u.displayName.charAt(0)}</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-gray-900 text-sm">{u.displayName}</p>
                      {u.id === me?.id && <span className="text-xs font-bold text-gray-400">(Anda)</span>}
                    </div>
                    <p className="text-xs text-gray-400">{u.email}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                        <Store className="w-3 h-3 flex-shrink-0" />
                        {outletNameOf(u.outletId) || (u.role === 'admin' ? 'Semua Outlet' : 'Belum diatur')}
                      </span>
                      {u.role !== 'admin' && (u.permissions || []).length > 0 && (
                        <span className="text-xs text-indigo-500">· {(u.permissions || []).length} permission aktif</span>
                      )}
                    </div>
                  </div>
                  <span className={`px-2.5 py-1 text-xs font-bold rounded-lg flex-shrink-0 ${ROLE_COLOR[u.role as Role]}`}>{ROLE_LABEL[u.role as Role]}</span>
                  {me?.role === 'admin' && u.id !== me?.id && (
                    <button onClick={() => { setEditingUser(u); setEditRole(u.role as Role); setEditPerms(u.permissions || []); setEditOutletId(u.outletId || '') }} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl flex-shrink-0"><Edit2 className="w-4 h-4" /></button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'roles' && (
        <div className="space-y-3">
          {roles.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-300">
              <Shield className="w-12 h-12 mx-auto mb-3" />
              <p className="font-bold">Belum ada role kustom</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
              {roles.map((r) => (
                <div key={r.id} className="px-5 py-4 flex items-center gap-3">
                  <div className="flex-1">
                    <p className="font-bold text-gray-900">{r.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{r.permissions.length} permission aktif</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {r.permissions.slice(0, 4).map((p) => (
                        <span key={p} className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-xs font-bold rounded-lg">{PERMS[p]?.label || p}</span>
                      ))}
                      {r.permissions.length > 4 && <span className="text-xs text-gray-400 font-bold">+{r.permissions.length - 4} lagi</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => { setEditingRole(r); setRoleForm({ name: r.name, permissions: [...r.permissions] }); setRoleOpen(true) }} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                    <button onClick={() => setDelRole(r.id)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editingUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div><h2 className="text-xl font-black text-gray-900">Edit Akses</h2><p className="text-sm text-gray-400">{editingUser.displayName}</p></div>
              <button onClick={() => setEditingUser(null)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-5">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Role</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['admin', 'manager', 'cashier'] as Role[]).map((r) => (
                    <button key={r} onClick={() => setEditRole(r)} className={`py-2.5 text-sm font-bold rounded-xl border-2 ${editRole === r ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>{ROLE_LABEL[r]}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Outlet</label>
                <select value={editOutletId} onChange={(e) => setEditOutletId(e.target.value)} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Semua Outlet (tanpa pembatasan)</option>
                  {outlets.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
                {editRole === 'cashier' && !editOutletId && (
                  <p className="text-[11px] text-amber-600 mt-1">Kasir sebaiknya ditempatkan di satu outlet agar POS dibatasi pada outlet tersebut.</p>
                )}
              </div>
              {editRole !== 'admin' && roles.length > 0 && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Terapkan Template</label>
                  <div className="flex gap-2 flex-wrap">
                    {roles.map((r) => (
                      <button key={r.id} onClick={() => setEditPerms(r.permissions)} className="px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-xl hover:bg-indigo-100">{r.name}</button>
                    ))}
                  </div>
                </div>
              )}
              {editRole !== 'admin' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Permission</label>
                  <div className="space-y-2">
                    {Object.entries(PERMS).map(([p, { label, desc }]) => (
                      <button key={p} onClick={() => togglePerm(p, setEditPerms)} className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left ${editPerms.includes(p) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-100 hover:border-gray-200'}`}>
                        <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${editPerms.includes(p) ? 'bg-indigo-600' : 'border-2 border-gray-300'}`}>
                          {editPerms.includes(p) && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div>
                          <p className={`text-sm font-bold ${editPerms.includes(p) ? 'text-indigo-700' : 'text-gray-700'}`}>{label}</p>
                          <p className="text-xs text-gray-400">{desc}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setEditingUser(null)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveUser} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">Tambah Pengguna</h2>
              <button onClick={() => setAddOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              {[
                { k: 'displayName' as const, label: 'Nama *', type: 'text' },
                { k: 'email' as const, label: 'Email *', type: 'email' },
                { k: 'password' as const, label: 'Kata Sandi *', type: 'password' },
              ].map(({ k, label, type }) => (
                <div key={k}>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{label}</label>
                  <input type={type} value={nf[k]} onChange={(e) => setNf((f) => ({ ...f, [k]: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              ))}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Role</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['admin', 'manager', 'cashier'] as Role[]).map((r) => (
                    <button key={r} onClick={() => setNf((f) => ({ ...f, role: r }))} className={`py-2 text-sm font-bold rounded-xl border-2 ${nf.role === r ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>{ROLE_LABEL[r]}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Outlet</label>
                <select value={nf.outletId} onChange={(e) => setNf((f) => ({ ...f, outletId: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Semua Outlet (tanpa pembatasan)</option>
                  {outlets.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
                {nf.role === 'cashier' && !nf.outletId && (
                  <p className="text-[11px] text-amber-600 mt-1">Kasir sebaiknya ditempatkan di satu outlet.</p>
                )}
              </div>
              {nf.role !== 'admin' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Permission</label>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {Object.entries(PERMS).map(([p, { label }]) => (
                      <button key={p} onClick={() => setNf((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))} className={`w-full flex items-center gap-2 p-2.5 rounded-xl border-2 text-left ${nf.permissions.includes(p) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-100'}`}>
                        <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${nf.permissions.includes(p) ? 'bg-indigo-600' : 'border-2 border-gray-300'}`}>
                          {nf.permissions.includes(p) && <Check className="w-2.5 h-2.5 text-white" />}
                        </div>
                        <span className={`text-sm font-bold ${nf.permissions.includes(p) ? 'text-indigo-700' : 'text-gray-700'}`}>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setAddOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={addUser} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Menambahkan...</> : 'Tambah'}
              </button>
            </div>
          </div>
        </div>
      )}

      {roleOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingRole ? 'Edit Role' : 'Buat Role Kustom'}</h2>
              <button onClick={() => setRoleOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Role *</label>
                <input type="text" value={roleForm.name} onChange={(e) => setRoleForm((f) => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Permission</label>
                <div className="space-y-2">
                  {Object.entries(PERMS).map(([p, { label, desc }]) => (
                    <button key={p} onClick={() => setRoleForm((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))} className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left ${roleForm.permissions.includes(p) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-100 hover:border-gray-200'}`}>
                      <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${roleForm.permissions.includes(p) ? 'bg-indigo-600' : 'border-2 border-gray-300'}`}>
                        {roleForm.permissions.includes(p) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div>
                        <p className={`text-sm font-bold ${roleForm.permissions.includes(p) ? 'text-indigo-700' : 'text-gray-700'}`}>{label}</p>
                        <p className="text-xs text-gray-400">{desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setRoleOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveRole} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {delRole && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Role?</h3>
            <p className="text-sm text-gray-400 mb-6">Template permission akan hilang.</p>
            <div className="flex gap-3">
              <button onClick={() => setDelRole(null)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={async () => { await api.deleteCustomRole(delRole); setDelRole(null); await rq.refetch() }} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
