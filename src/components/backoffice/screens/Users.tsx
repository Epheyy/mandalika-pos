import { useState, useEffect, useRef } from 'react'
import type { AppUser, CustomRole } from '../../../types'
import { UserRole, UserPermission } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, updateDoc, addDoc, deleteDoc, doc } from 'firebase/firestore'
import { exportToCSV, parseCSV } from '../../../lib/csvUtils'
import { Edit2, X, Users as UsersIcon, Shield, Loader2, Check, Plus, Trash2, Download, Upload } from 'lucide-react'

interface Props { appUser: AppUser }

const PERMISSION_LABELS: Record<UserPermission, { label: string; desc: string }> = {
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

const ROLE_LABELS: Record<UserRole, string> = { admin: 'Admin', manager: 'Manager', cashier: 'Kasir' }
const ROLE_COLORS: Record<UserRole, string> = { admin: 'bg-red-50 text-red-700', manager: 'bg-indigo-50 text-indigo-700', cashier: 'bg-green-50 text-green-700' }

export default function Users({ appUser }: Props) {
  const [users, setUsers] = useState<AppUser[]>([])
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'users' | 'roles'>('users')

  // User edit modal
  const [editingUser, setEditingUser] = useState<AppUser | null>(null)
  const [editRole, setEditRole] = useState<UserRole>('cashier')
  const [editPermissions, setEditPermissions] = useState<UserPermission[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Add user modal
  const [isAddUserOpen, setIsAddUserOpen] = useState(false)
  const [newUserForm, setNewUserForm] = useState({ displayName: '', email: '', role: 'cashier' as UserRole, permissions: [] as UserPermission[] })

  // Role modal
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null)
  const [roleForm, setRoleForm] = useState({ name: '', permissions: [] as UserPermission[] })
  const [deleteRoleId, setDeleteRoleId] = useState<string | null>(null)

  const csvImportRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'users'), s => { setUsers(s.docs.map(d => ({ id: d.id, ...d.data() } as AppUser))); setIsLoading(false) })
    const u2 = onSnapshot(collection(db, 'customRoles'), s => setCustomRoles(s.docs.map(d => ({ id: d.id, ...d.data() } as CustomRole))))
    return () => { u1(); u2() }
  }, [])

  const openEdit = (user: AppUser) => {
    setEditingUser(user)
    setEditRole(user.role)
    setEditPermissions(user.permissions || [])
  }

  const handleSaveUser = async () => {
    if (!editingUser?.id) return
    setIsSubmitting(true)
    try { await updateDoc(doc(db, 'users', editingUser.id), { role: editRole, permissions: editPermissions }); setEditingUser(null) }
    catch { alert('Gagal menyimpan.') }
    finally { setIsSubmitting(false) }
  }

  const applyRoleTemplate = (role: CustomRole) => {
    setEditPermissions(role.permissions)
  }

  const handleAddUser = async () => {
    if (!newUserForm.displayName.trim() || !newUserForm.email.trim()) { alert('Nama dan email wajib diisi'); return }
    setIsSubmitting(true)
    try {
      const userData: Omit<AppUser, 'id'> = {
        uid: `manual_${Date.now()}`,
        displayName: newUserForm.displayName.trim(),
        email: newUserForm.email.trim(),
        role: newUserForm.role,
        permissions: newUserForm.permissions,
        createdAt: new Date().toISOString(),
      }
      await addDoc(collection(db, 'users'), userData)
      setIsAddUserOpen(false)
      setNewUserForm({ displayName: '', email: '', role: 'cashier', permissions: [] })
      alert('Pengguna ditambahkan. Mereka perlu login dengan email tersebut agar UID diperbarui.')
    } catch { alert('Gagal menambahkan pengguna.') }
    finally { setIsSubmitting(false) }
  }

  // Export users
  const exportUsers = () => {
    exportToCSV(users.map(u => ({
      'Nama': u.displayName, 'Email': u.email, 'Role': u.role,
      'Permissions': (u.permissions || []).join(';'),
      'Terdaftar': u.createdAt ? u.createdAt.slice(0, 10) : '',
    })), 'pengguna_mandalika')
  }

  // Import users
  const importUsers = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const rows = parseCSV(await file.text())
    let count = 0
    for (const row of rows) {
      if (!row['Email']?.trim()) continue
      const userData: Omit<AppUser, 'id'> = {
        uid: `imported_${Date.now()}_${count}`,
        displayName: row['Nama'] || row['Email'],
        email: row['Email'].trim(),
        role: (row['Role'] as UserRole) || 'cashier',
        permissions: row['Permissions'] ? row['Permissions'].split(';').filter(Boolean) as UserPermission[] : [],
        createdAt: new Date().toISOString(),
      }
      await addDoc(collection(db, 'users'), userData)
      count++
    }
    alert(`${count} pengguna berhasil diimport!`)
    e.target.value = ''
  }

  // Custom Roles CRUD
  const openAddRole = () => { setEditingRole(null); setRoleForm({ name: '', permissions: [] }); setIsRoleModalOpen(true) }
  const openEditRole = (r: CustomRole) => { setEditingRole(r); setRoleForm({ name: r.name, permissions: [...r.permissions] }); setIsRoleModalOpen(true) }

  const saveRole = async () => {
    if (!roleForm.name.trim()) { alert('Nama role wajib diisi'); return }
    setIsSubmitting(true)
    try {
      const data = { ...roleForm, createdAt: editingRole?.createdAt || new Date().toISOString() }
      if (editingRole?.id) await updateDoc(doc(db, 'customRoles', editingRole.id), data)
      else await addDoc(collection(db, 'customRoles'), data)
      setIsRoleModalOpen(false)
    } catch { alert('Gagal menyimpan role.') }
    finally { setIsSubmitting(false) }
  }

  const toggleRolePermission = (p: UserPermission) => {
    setRoleForm(f => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter(x => x !== p) : [...f.permissions, p] }))
  }

  const togglePermission = (p: UserPermission) => {
    setEditPermissions(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  const toggleNewUserPermission = (p: UserPermission) => {
    setNewUserForm(f => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter(x => x !== p) : [...f.permissions, p] }))
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Pengguna</h2>
          <p className="text-sm text-gray-400">{users.length} pengguna · {customRoles.length} role kustom</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {(['users', 'roles'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                {tab === 'users' ? 'Pengguna' : 'Manajemen Role'}
              </button>
            ))}
          </div>
          {activeTab === 'users' && (
            <>
              <button onClick={exportUsers} className="flex items-center gap-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl text-xs">
                <Download className="w-3.5 h-3.5" /> Export
              </button>
              <button onClick={() => csvImportRef.current?.click()} className="flex items-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs">
                <Upload className="w-3.5 h-3.5" /> Import
              </button>
              <input ref={csvImportRef} type="file" accept=".csv" onChange={importUsers} className="hidden" />
              <button onClick={() => setIsAddUserOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-indigo-100">
                <Plus className="w-4 h-4" /> Tambah
              </button>
            </>
          )}
          {activeTab === 'roles' && (
            <button onClick={openAddRole}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-indigo-100">
              <Plus className="w-4 h-4" /> Buat Role
            </button>
          )}
        </div>
      </div>

      <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 text-sm text-indigo-700">
        <p className="font-bold mb-1">Cara kerja akses:</p>
        <p>• <strong>Admin</strong> — akses penuh, tidak bisa dibatasi · <strong>Manager/Kasir</strong> — akses sesuai permission</p>
        <p>• Role Kustom adalah template permission yang bisa diterapkan ke pengguna secara cepat</p>
      </div>

      {/* USERS TAB */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {isLoading ? <div className="p-8 text-center text-gray-300">Memuat...</div>
            : users.length === 0 ? (
              <div className="p-12 flex flex-col items-center gap-3 text-gray-300"><UsersIcon className="w-12 h-12" /><p className="font-bold">Belum ada pengguna</p></div>
            ) : (
              <div className="divide-y divide-gray-50">
                {users.map(user => (
                  <div key={user.id} className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 transition-all">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {user.photoURL ? <img src={user.photoURL} alt="" className="w-full h-full object-cover" />
                        : <span className="text-sm font-black text-indigo-600">{user.displayName.charAt(0)}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-gray-900 text-sm">{user.displayName}</p>
                        {user.uid === appUser.uid && <span className="text-xs font-bold text-gray-400">(Anda)</span>}
                      </div>
                      <p className="text-xs text-gray-400">{user.email}</p>
                      {user.role !== 'admin' && (user.permissions || []).length > 0 && (
                        <p className="text-xs text-indigo-500 mt-0.5">{(user.permissions || []).length} permission aktif</p>
                      )}
                    </div>
                    <span className={`px-2.5 py-1 text-xs font-bold rounded-lg flex-shrink-0 ${ROLE_COLORS[user.role]}`}>{ROLE_LABELS[user.role]}</span>
                    {appUser.role === 'admin' && user.uid !== appUser.uid && (
                      <button onClick={() => openEdit(user)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl flex-shrink-0">
                        <Edit2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {/* ROLES TAB */}
      {activeTab === 'roles' && (
        <div className="space-y-3">
          {/* Default roles info */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Role Bawaan (Tidak Dapat Diedit)</p>
            </div>
            {(['admin', 'manager', 'cashier'] as UserRole[]).map(role => (
              <div key={role} className="px-5 py-3 flex items-center gap-3 border-b border-gray-50 last:border-0">
                <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${ROLE_COLORS[role]}`}>{ROLE_LABELS[role]}</span>
                <p className="text-sm text-gray-500">
                  {role === 'admin' ? 'Akses penuh ke semua fitur'
                    : role === 'manager' ? 'Akses ditentukan oleh permission'
                    : 'Hanya akses kasir, back office sesuai permission'}
                </p>
              </div>
            ))}
          </div>

          {/* Custom roles */}
          {customRoles.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Role Kustom</p>
              </div>
              <div className="divide-y divide-gray-50">
                {customRoles.map(role => (
                  <div key={role.id} className="px-5 py-4 flex items-center gap-3">
                    <div className="flex-1">
                      <p className="font-bold text-gray-900">{role.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{role.permissions.length} permission aktif</p>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {role.permissions.slice(0, 4).map(p => (
                          <span key={p} className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-xs font-bold rounded-lg">{PERMISSION_LABELS[p]?.label || p}</span>
                        ))}
                        {role.permissions.length > 4 && <span className="text-xs text-gray-400 font-bold">+{role.permissions.length - 4} lagi</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEditRole(role)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                      <button onClick={() => setDeleteRoleId(role.id!)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {customRoles.length === 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-300">
              <Shield className="w-12 h-12 mx-auto mb-3" />
              <p className="font-bold">Belum ada role kustom</p>
              <p className="text-sm mt-1">Role kustom memudahkan pengaturan permission untuk banyak pengguna</p>
            </div>
          )}
        </div>
      )}

      {/* EDIT USER MODAL */}
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
                  {(['admin', 'manager', 'cashier'] as UserRole[]).map(role => (
                    <button key={role} onClick={() => setEditRole(role)}
                      className={`py-2.5 text-sm font-bold rounded-xl border-2 transition-all ${editRole === role ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>
                      {ROLE_LABELS[role]}
                    </button>
                  ))}
                </div>
                {editRole === 'admin' && (
                  <div className="mt-2 p-3 bg-red-50 rounded-xl flex items-center gap-2">
                    <Shield className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <p className="text-xs text-red-600">Admin memiliki akses penuh.</p>
                  </div>
                )}
              </div>

              {/* Apply role template */}
              {editRole !== 'admin' && customRoles.length > 0 && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Terapkan Role Template</label>
                  <div className="flex gap-2 flex-wrap">
                    {customRoles.map(r => (
                      <button key={r.id} onClick={() => applyRoleTemplate(r)}
                        className="px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-xl hover:bg-indigo-100 transition-all">
                        {r.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {editRole !== 'admin' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Permission</label>
                  <div className="space-y-2">
                    {(Object.entries(PERMISSION_LABELS) as [UserPermission, { label: string; desc: string }][]).map(([p, { label, desc }]) => (
                      <button key={p} onClick={() => togglePermission(p)}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-all ${editPermissions.includes(p) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-100 hover:border-gray-200'}`}>
                        <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${editPermissions.includes(p) ? 'bg-indigo-600' : 'border-2 border-gray-300'}`}>
                          {editPermissions.includes(p) && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div>
                          <p className={`text-sm font-bold ${editPermissions.includes(p) ? 'text-indigo-700' : 'text-gray-700'}`}>{label}</p>
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
              <button onClick={handleSaveUser} disabled={isSubmitting}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD USER MODAL */}
      {isAddUserOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">Tambah Pengguna</h2>
              <button onClick={() => setIsAddUserOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              <div className="bg-yellow-50 rounded-xl p-3 text-xs text-yellow-700">
                <p>Pengguna yang ditambahkan manual perlu login menggunakan email Google yang sama agar akun terhubung ke sistem.</p>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama *</label>
                <input type="text" value={newUserForm.displayName} onChange={e => setNewUserForm(f => ({ ...f, displayName: e.target.value }))} placeholder="Nama lengkap"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Email *</label>
                <input type="email" value={newUserForm.email} onChange={e => setNewUserForm(f => ({ ...f, email: e.target.value }))} placeholder="email@gmail.com"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Role</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['admin', 'manager', 'cashier'] as UserRole[]).map(role => (
                    <button key={role} onClick={() => setNewUserForm(f => ({ ...f, role }))}
                      className={`py-2 text-sm font-bold rounded-xl border-2 transition-all ${newUserForm.role === role ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>
                      {ROLE_LABELS[role]}
                    </button>
                  ))}
                </div>
              </div>
              {newUserForm.role !== 'admin' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Permission</label>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(Object.entries(PERMISSION_LABELS) as [UserPermission, { label: string; desc: string }][]).map(([p, { label }]) => (
                      <button key={p} onClick={() => toggleNewUserPermission(p)}
                        className={`w-full flex items-center gap-2 p-2.5 rounded-xl border-2 text-left transition-all ${newUserForm.permissions.includes(p) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-100 hover:border-gray-200'}`}>
                        <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${newUserForm.permissions.includes(p) ? 'bg-indigo-600' : 'border-2 border-gray-300'}`}>
                          {newUserForm.permissions.includes(p) && <Check className="w-2.5 h-2.5 text-white" />}
                        </div>
                        <span className={`text-sm font-bold ${newUserForm.permissions.includes(p) ? 'text-indigo-700' : 'text-gray-700'}`}>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setIsAddUserOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={handleAddUser} disabled={isSubmitting}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menambahkan...</> : 'Tambah'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ROLE MODAL */}
      {isRoleModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingRole ? 'Edit Role' : 'Buat Role Kustom'}</h2>
              <button onClick={() => setIsRoleModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Role *</label>
                <input type="text" value={roleForm.name} onChange={e => setRoleForm(f => ({ ...f, name: e.target.value }))} placeholder="Contoh: SPG, Supervisor"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Permission</label>
                <div className="space-y-2">
                  {(Object.entries(PERMISSION_LABELS) as [UserPermission, { label: string; desc: string }][]).map(([p, { label, desc }]) => (
                    <button key={p} onClick={() => toggleRolePermission(p)}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-all ${roleForm.permissions.includes(p) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-100 hover:border-gray-200'}`}>
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
              <button onClick={() => setIsRoleModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveRole} disabled={isSubmitting}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" /></> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE ROLE CONFIRM */}
      {deleteRoleId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Role?</h3>
            <p className="text-sm text-gray-400 mb-6">Pengguna yang menggunakan role ini tidak terpengaruh, namun template akan hilang.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteRoleId(null)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={async () => { await deleteDoc(doc(db, 'customRoles', deleteRoleId)); setDeleteRoleId(null) }} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}