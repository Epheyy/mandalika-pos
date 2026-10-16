import { useReducer, useState } from 'react'
import type { User, CustomRole, Outlet } from '@mandalika/api'
import { Edit2, Users as UsersIcon, Shield, Plus, Trash2, Download, Store, KeyRound, X } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { exportToCSV } from '../lib/csvUtils'
import { Button } from '../ui/Button'
import { Select, Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { PERMS, PermissionPicker } from './users/PermissionPicker'
import { AddUserModal } from './users/AddUserModal'
import { RoleModal } from './users/RoleModal'
import { ResetPasswordModal } from './users/ResetPasswordModal'

type Role = 'admin' | 'manager' | 'cashier'
const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', manager: 'Manager', cashier: 'Kasir' }
const ROLE_TONE: Record<Role, 'gold' | 'success' | 'danger'> = {
  admin: 'danger',
  manager: 'gold',
  cashier: 'success',
}

type EditUserState = {
  editingUser: User | null
  editRole: Role
  editPerms: string[]
  editOutletId: string
  pin: string
  clearPin: boolean
}

type EditUserAction =
  | { type: 'OPEN_EDIT'; user: User }
  | { type: 'SET_ROLE'; value: Role }
  | { type: 'SET_PERMS'; value: string[] }
  | { type: 'TOGGLE_PERM'; perm: string }
  | { type: 'SET_OUTLET'; value: string }
  | { type: 'SET_PIN'; value: string }
  | { type: 'SET_CLEAR_PIN'; value: boolean }
  | { type: 'CLOSE' }

const initialEditUser: EditUserState = {
  editingUser: null,
  editRole: 'cashier',
  editPerms: [],
  editOutletId: '',
  pin: '',
  clearPin: false,
}

const editUserReducer = (state: EditUserState, action: EditUserAction): EditUserState => {
  switch (action.type) {
    case 'OPEN_EDIT':
      return {
        editingUser: action.user,
        editRole: action.user.role as Role,
        editPerms: action.user.permissions || [],
        editOutletId: action.user.outletId || '',
        pin: '',
        clearPin: false,
      }
    case 'SET_ROLE':
      return { ...state, editRole: action.value }
    case 'SET_PERMS':
      return { ...state, editPerms: action.value }
    case 'TOGGLE_PERM':
      return {
        ...state,
        editPerms: state.editPerms.includes(action.perm)
          ? state.editPerms.filter((x) => x !== action.perm)
          : [...state.editPerms, action.perm],
      }
    case 'SET_OUTLET':
      return { ...state, editOutletId: action.value }
    case 'SET_PIN':
      return { ...state, pin: action.value, clearPin: false }
    case 'SET_CLEAR_PIN':
      return { ...state, clearPin: action.value }
    case 'CLOSE':
      return { ...state, editingUser: null, pin: '', clearPin: false }
    default:
      return state
  }
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

  const [editUser, dispatch] = useReducer(editUserReducer, initialEditUser)
  const { editingUser, editRole, editPerms, editOutletId, pin, clearPin } = editUser
  const [busy, setBusy] = useState(false)
  const [resetTarget, setResetTarget] = useState<User | null>(null)
  const [resetNotice, setResetNotice] = useState<string | null>(null)

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
      dispatch({ type: 'CLOSE' })
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

      {resetNotice && (
        <div role="status" className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-bold text-green-700">
          <span className="flex-1">{resetNotice}</span>
          <button type="button" aria-label="Tutup pemberitahuan" onClick={() => setResetNotice(null)} className="text-green-600 hover:text-green-800"><X className="w-4 h-4" /></button>
        </div>
      )}

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
                    <>
                      <IconButton aria-label={`Reset kata sandi ${u.displayName}`} title="Reset kata sandi" onClick={() => setResetTarget(u)}><KeyRound className="w-4 h-4" /></IconButton>
                      <IconButton aria-label={`Edit ${u.displayName}`} title="Edit" onClick={() => dispatch({ type: 'OPEN_EDIT', user: u })}><Edit2 className="w-4 h-4" /></IconButton>
                    </>
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
        onClose={() => dispatch({ type: 'CLOSE' })}
        title="Edit Akses"
        subtitle={editingUser?.displayName}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => dispatch({ type: 'CLOSE' })}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={saveUser}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
          </>
        }
      >
        <div className="space-y-5">
          <Field label="Role">
            <div className="grid grid-cols-3 gap-2">
              {(['admin', 'manager', 'cashier'] as Role[]).map((r) => (
                <button type="button" key={r} onClick={() => dispatch({ type: 'SET_ROLE', value: r })} className={`py-2.5 text-sm font-bold rounded-xl border-2 ${editRole === r ? 'border-gold-600 bg-gold-50 text-gold-700' : 'border-gray-200 text-gray-500'}`}>{ROLE_LABEL[r]}</button>
              ))}
            </div>
          </Field>
          <Select
            label="Outlet"
            value={editOutletId}
            onChange={(e) => dispatch({ type: 'SET_OUTLET', value: e.target.value })}
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
              onChange={(e) => dispatch({ type: 'SET_PIN', value: e.target.value.replace(/\D/g, '') })}
              disabled={clearPin}
              className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition disabled:opacity-50"
            />
            <label className="mt-1 flex items-center gap-2 text-sm text-gray-500">
              <input type="checkbox" checked={clearPin} onChange={(e) => dispatch({ type: 'SET_CLEAR_PIN', value: e.target.checked })} />
              Hapus PIN
            </label>
          </Field>
          {editRole !== 'admin' && roles.length > 0 && (
            <Field label="Terapkan Template">
              <div className="flex gap-2 flex-wrap">
                {roles.map((r) => (
                  <Button key={r.id} variant="ghost" size="sm" onClick={() => dispatch({ type: 'SET_PERMS', value: r.permissions })}>{r.name}</Button>
                ))}
              </div>
            </Field>
          )}
          {editRole !== 'admin' && (
            <Field label="Permission">
              <PermissionPicker selected={editPerms} onToggle={(p) => dispatch({ type: 'TOGGLE_PERM', perm: p })} />
            </Field>
          )}
        </div>
      </Modal>

      {resetTarget && (
        <ResetPasswordModal
          key={resetTarget.id}
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={(u) => {
            setResetTarget(null)
            setResetNotice(`Kata sandi ${u.displayName} berhasil direset`)
          }}
        />
      )}

      <AddUserModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        nf={nf}
        setNf={setNf}
        busy={busy}
        outlets={outlets}
        onSave={addUser}
      />

      <RoleModal
        open={roleOpen}
        onClose={() => setRoleOpen(false)}
        editingRole={editingRole}
        roleForm={roleForm}
        setRoleForm={setRoleForm}
        busy={busy}
        onSave={saveRole}
        delRole={delRole}
        onCloseDelete={() => setDelRole(null)}
        onConfirmDelete={async () => { await api.deleteCustomRole(delRole!); setDelRole(null); await rq.refetch() }}
      />
    </div>
  )
}
