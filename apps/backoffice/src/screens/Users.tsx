import { useRef, useState } from 'react'
import type { User, CustomRole, Outlet } from '@mandalika/api'
import { Edit2, Users as UsersIcon, Shield, Check, Plus, Trash2, Download, Upload, Store } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { exportToCSV, parseCSV } from '../lib/csvUtils'
import { Button } from '../ui/Button'
import { Input, Select, Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'

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
  manage_inventory: { label: 'Kelola Gudang', desc: 'Gudang, barang masuk & stok' },
}
const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', manager: 'Manager', cashier: 'Kasir' }
const ROLE_TONE: Record<Role, 'gold' | 'success' | 'danger'> = {
  admin: 'danger',
  manager: 'gold',
  cashier: 'success',
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
  const [pin, setPin] = useState('')
  const [clearPin, setClearPin] = useState(false)
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
      if (clearPin) {
        await api.setUserReceivePin(editingUser.id, { clear: true })
      } else if (pin) {
        await api.setUserReceivePin(editingUser.id, { pin })
      }
      setEditingUser(null)
      setPin('')
      setClearPin(false)
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
      <PageHeader
        title="Pengguna"
        subtitle={`${users.length} pengguna · ${roles.length} role kustom`}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'users', label: 'Pengguna' },
                { id: 'roles', label: 'Manajemen Role' },
              ]}
            />
            {tab === 'users' && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Download className="w-3.5 h-3.5" />}
                  onClick={() => exportToCSV(users.map((u) => ({ Nama: u.displayName, Email: u.email, Role: u.role, Outlet: outletNameOf(u.outletId) || '', Permissions: (u.permissions || []).join(';'), Terdaftar: u.createdAt?.slice(0, 10) || '' })), 'pengguna_mandalika')}
                >
                  Export
                </Button>
                <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => csvRef.current?.click()}>
                  Import
                </Button>
                <input ref={csvRef} type="file" accept=".csv" onChange={importUsers} aria-label="Impor pengguna dari CSV" className="hidden" />
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => setAddOpen(true)}>
                  Tambah
                </Button>
              </>
            )}
            {tab === 'roles' && (
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setEditingRole(null); setRoleForm({ name: '', permissions: [] }); setRoleOpen(true) }}>
                Buat Role
              </Button>
            )}
          </>
        }
      />

      {tab === 'users' && (
        <Card className="overflow-hidden">
          {uq.loading ? (
            <TableSkeleton />
          ) : users.length === 0 ? (
            <EmptyState icon={<UsersIcon />} title="Belum ada pengguna" />
          ) : (
            <div className="divide-y divide-gray-50">
              {users.map((u) => (
                <div key={u.id} className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50">
                  <div className="w-10 h-10 rounded-full bg-gold-50 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {u.photoURL ? <img src={u.photoURL} alt="" className="w-full h-full object-cover" /> : <span className="text-sm font-black text-gold-600">{u.displayName.charAt(0)}</span>}
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
                        <span className="text-xs text-gray-500">· {(u.permissions || []).length} permission aktif</span>
                      )}
                    </div>
                  </div>
                  <Badge tone={ROLE_TONE[u.role as Role]} className="flex-shrink-0">{ROLE_LABEL[u.role as Role]}</Badge>
                  {me?.role === 'admin' && u.id !== me?.id && (
                    <IconButton onClick={() => { setEditingUser(u); setEditRole(u.role as Role); setEditPerms(u.permissions || []); setEditOutletId(u.outletId || ''); setPin(''); setClearPin(false) }}><Edit2 className="w-4 h-4" /></IconButton>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'roles' && (
        <div className="space-y-3">
          {roles.length === 0 ? (
            <Card>
              <EmptyState icon={<Shield />} title="Belum ada role kustom" />
            </Card>
          ) : (
            <Card className="divide-y divide-gray-50">
              {roles.map((r) => (
                <div key={r.id} className="px-5 py-4 flex items-center gap-3">
                  <div className="flex-1">
                    <p className="font-bold text-gray-900">{r.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{r.permissions.length} permission aktif</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {r.permissions.slice(0, 4).map((p) => (
                        <Badge key={p} tone="gold">{PERMS[p]?.label || p}</Badge>
                      ))}
                      {r.permissions.length > 4 && <span className="text-xs text-gray-400 font-bold">+{r.permissions.length - 4} lagi</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <IconButton onClick={() => { setEditingRole(r); setRoleForm({ name: r.name, permissions: [...r.permissions] }); setRoleOpen(true) }}><Edit2 className="w-4 h-4" /></IconButton>
                    <IconButton tone="danger" onClick={() => setDelRole(r.id)}><Trash2 className="w-4 h-4" /></IconButton>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      <Modal
        open={!!editingUser}
        onClose={() => { setEditingUser(null); setPin(''); setClearPin(false) }}
        title="Edit Akses"
        subtitle={editingUser?.displayName}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => { setEditingUser(null); setPin(''); setClearPin(false) }}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={saveUser}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
          </>
        }
      >
        <div className="space-y-5">
          <Field label="Role">
            <div className="grid grid-cols-3 gap-2">
              {(['admin', 'manager', 'cashier'] as Role[]).map((r) => (
                <button key={r} onClick={() => setEditRole(r)} className={`py-2.5 text-sm font-bold rounded-xl border-2 ${editRole === r ? 'border-gold-600 bg-gold-50 text-gold-700' : 'border-gray-200 text-gray-500'}`}>{ROLE_LABEL[r]}</button>
              ))}
            </div>
          </Field>
          <Select
            label="Outlet"
            value={editOutletId}
            onChange={(e) => setEditOutletId(e.target.value)}
          >
            <option value="">Semua Outlet (tanpa pembatasan)</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
          {editRole === 'cashier' && !editOutletId && (
            <p className="text-[11px] text-amber-600 -mt-3">Kasir sebaiknya ditempatkan di satu outlet agar POS dibatasi pada outlet tersebut.</p>
          )}
          <Field label="PIN penerimaan transfer (opsional)">
            <input
              inputMode="numeric"
              maxLength={8}
              placeholder="Isi untuk set / ganti PIN"
              aria-label="PIN penerimaan transfer"
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setClearPin(false) }}
              disabled={clearPin}
              className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition disabled:opacity-50"
            />
            <label className="mt-1 flex items-center gap-2 text-sm text-gray-500">
              <input type="checkbox" checked={clearPin} onChange={(e) => setClearPin(e.target.checked)} />
              Hapus PIN
            </label>
          </Field>
          {editRole !== 'admin' && roles.length > 0 && (
            <Field label="Terapkan Template">
              <div className="flex gap-2 flex-wrap">
                {roles.map((r) => (
                  <Button key={r.id} variant="ghost" size="sm" onClick={() => setEditPerms(r.permissions)}>{r.name}</Button>
                ))}
              </div>
            </Field>
          )}
          {editRole !== 'admin' && (
            <Field label="Permission">
              <div className="space-y-2">
                {Object.entries(PERMS).map(([p, { label, desc }]) => (
                  <button key={p} onClick={() => togglePerm(p, setEditPerms)} className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left ${editPerms.includes(p) ? 'border-gold-400 bg-gold-50' : 'border-gray-100 hover:border-gray-200'}`}>
                    <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${editPerms.includes(p) ? 'bg-gold-600' : 'border-2 border-gray-300'}`}>
                      {editPerms.includes(p) && <Check className="w-3 h-3 text-white" />}
                    </div>
                    <div>
                      <p className={`text-sm font-bold ${editPerms.includes(p) ? 'text-gold-700' : 'text-gray-700'}`}>{label}</p>
                      <p className="text-xs text-gray-400">{desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </Field>
          )}
        </div>
      </Modal>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Tambah Pengguna"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setAddOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={addUser}>{busy ? 'Menambahkan...' : 'Tambah'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          {[
            { k: 'displayName' as const, label: 'Nama *', type: 'text' },
            { k: 'email' as const, label: 'Email *', type: 'email' },
            { k: 'password' as const, label: 'Kata Sandi *', type: 'password' },
          ].map(({ k, label, type }) => (
            <Input key={k} label={label} type={type} value={nf[k]} onChange={(e) => setNf((f) => ({ ...f, [k]: e.target.value }))} />
          ))}
          <Field label="Role">
            <div className="grid grid-cols-3 gap-2">
              {(['admin', 'manager', 'cashier'] as Role[]).map((r) => (
                <button key={r} onClick={() => setNf((f) => ({ ...f, role: r }))} className={`py-2 text-sm font-bold rounded-xl border-2 ${nf.role === r ? 'border-gold-600 bg-gold-50 text-gold-700' : 'border-gray-200 text-gray-500'}`}>{ROLE_LABEL[r]}</button>
              ))}
            </div>
          </Field>
          <Select
            label="Outlet"
            value={nf.outletId}
            onChange={(e) => setNf((f) => ({ ...f, outletId: e.target.value }))}
          >
            <option value="">Semua Outlet (tanpa pembatasan)</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
          {nf.role === 'cashier' && !nf.outletId && (
            <p className="text-[11px] text-amber-600 -mt-3">Kasir sebaiknya ditempatkan di satu outlet.</p>
          )}
          {nf.role !== 'admin' && (
            <Field label="Permission">
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {Object.entries(PERMS).map(([p, { label }]) => (
                  <button key={p} onClick={() => setNf((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))} className={`w-full flex items-center gap-2 p-2.5 rounded-xl border-2 text-left ${nf.permissions.includes(p) ? 'border-gold-400 bg-gold-50' : 'border-gray-100'}`}>
                    <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${nf.permissions.includes(p) ? 'bg-gold-600' : 'border-2 border-gray-300'}`}>
                      {nf.permissions.includes(p) && <Check className="w-2.5 h-2.5 text-white" />}
                    </div>
                    <span className={`text-sm font-bold ${nf.permissions.includes(p) ? 'text-gold-700' : 'text-gray-700'}`}>{label}</span>
                  </button>
                ))}
              </div>
            </Field>
          )}
        </div>
      </Modal>

      <Modal
        open={roleOpen}
        onClose={() => setRoleOpen(false)}
        title={editingRole ? 'Edit Role' : 'Buat Role Kustom'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setRoleOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={saveRole}>Simpan</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Nama Role *" type="text" value={roleForm.name} onChange={(e) => setRoleForm((f) => ({ ...f, name: e.target.value }))} />
          <Field label="Permission">
            <div className="space-y-2">
              {Object.entries(PERMS).map(([p, { label, desc }]) => (
                <button key={p} onClick={() => setRoleForm((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))} className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left ${roleForm.permissions.includes(p) ? 'border-gold-400 bg-gold-50' : 'border-gray-100 hover:border-gray-200'}`}>
                  <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${roleForm.permissions.includes(p) ? 'bg-gold-600' : 'border-2 border-gray-300'}`}>
                    {roleForm.permissions.includes(p) && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <div>
                    <p className={`text-sm font-bold ${roleForm.permissions.includes(p) ? 'text-gold-700' : 'text-gray-700'}`}>{label}</p>
                    <p className="text-xs text-gray-400">{desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!delRole}
        onClose={() => setDelRole(null)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setDelRole(null)}>Batal</Button>
            <Button variant="danger" className="flex-1" onClick={async () => { await api.deleteCustomRole(delRole!); setDelRole(null); await rq.refetch() }}>Ya, Hapus</Button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Role?</h3>
          <p className="text-sm text-gray-400">Template permission akan hilang.</p>
        </div>
      </Modal>
    </div>
  )
}
