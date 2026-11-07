import { useReducer, useState } from 'react'
import { fetchAllPages, type User, type CustomRole, type Outlet } from '@mandalika/api'
import { Edit2, Users as UsersIcon, Shield, Plus, Trash2, X } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { exportToCSV } from '../lib/csvUtils'
import { Button } from '../ui/Button'
import { Select, Field } from '../ui/Field'
import { DataTable } from '../ui/DataTable'
import { ExportButton } from '../ui/ExportButton'
import { SlideOver } from '../ui/SlideOver'
import { useToast } from '../ui/Toast'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { useScreenTabs } from '../lib/router/useScreenTabs'
import { PERMS, PermissionPicker } from './users/PermissionPicker'
import { AddUserModal } from './users/AddUserModal'
import { RoleModal } from './users/RoleModal'
import { ResetPasswordModal } from './users/ResetPasswordModal'
import { UNLOCK_PIN_NOTE, unlockReceivePin } from './users/unlockPin'
import { RolePicker } from './users/RolePicker'
import { ROLE_LABEL, roleFormProblem, type Role } from './users/roles'
import { userColumns } from './users/userColumns'
import { errorText } from './users/formError'

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
  const toast = useToast()
  const uq = usePolledQuery<User[]>(() => fetchAllPages((page, limit) => api.listUsers(page, limit)), [])
  const rq = usePolledQuery<CustomRole[]>(() => api.listCustomRoles(), [])
  const oq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const users = uq.data ?? []
  const roles = rq.data ?? []
  const outlets = oq.data ?? []
  const outletNameOf = (id?: string | null) => outlets.find((o) => o.id === id)?.name
  const { strip: tabStrip, tab: routedTab, setTab } = useScreenTabs<'users' | 'roles'>('users', me)
  const tab = routedTab ?? 'users'

  const [editUser, dispatch] = useReducer(editUserReducer, initialEditUser)
  const { editingUser, editRole, editPerms, editOutletId, pin, clearPin } = editUser
  const [busy, setBusy] = useState(false)
  const [resetTarget, setResetTarget] = useState<User | null>(null)
  const [resetNotice, setResetNotice] = useState<string | null>(null)
  const [unlockNote, setUnlockNote] = useState<{ ok: boolean; message: string } | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [nf, setNf] = useState({ displayName: '', email: '', password: '', role: 'cashier' as Role, outletId: '', permissions: [] as string[] })

  const [roleOpen, setRoleOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null)
  const [roleForm, setRoleForm] = useState({ name: '', permissions: [] as string[] })
  const [delRole, setDelRole] = useState<CustomRole | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [roleError, setRoleError] = useState<string | null>(null)

  const saveUser = async () => {
    if (!editingUser) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.updateUser(editingUser.id, { role: editRole, permissions: editPerms, outletId: editOutletId || null })
      if (clearPin) {
        await api.setUserReceivePin(editingUser.id, { clear: true })
      } else if (pin) {
        await api.setUserReceivePin(editingUser.id, { pin })
      }
      dispatch({ type: 'CLOSE' })
      toast({ message: `Akses ${editingUser.displayName} disimpan`, tone: 'ok' })
      await uq.refetch()
    } catch (e: unknown) {
      setSaveError(errorText(e, 'Gagal menyimpan akses. Coba lagi.'))
    } finally {
      setBusy(false)
    }
  }

  const unlockPin = async () => {
    if (!editingUser || unlocking) return
    setUnlocking(true)
    setUnlockNote(null)
    try {
      setUnlockNote(await unlockReceivePin(api, editingUser.id))
    } finally {
      setUnlocking(false)
    }
  }

  const addUser = async () => {
    if (!nf.displayName.trim() || !nf.email.trim() || !nf.password) return
    setBusy(true)
    setAddError(null)
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
      toast({ message: `Pengguna ${nf.displayName.trim()} ditambahkan`, tone: 'ok' })
      setNf({ displayName: '', email: '', password: '', role: 'cashier', outletId: '', permissions: [] })
      await uq.refetch()
    } catch (e: unknown) {
      setAddError(errorText(e, 'Gagal menambah pengguna. Coba lagi.'))
    } finally {
      setBusy(false)
    }
  }

  const saveRole = async () => {
    const problem = roleFormProblem(roleForm)
    if (problem) {
      setRoleError(problem)
      return
    }
    setBusy(true)
    setRoleError(null)
    try {
      if (editingRole) await api.updateCustomRole(editingRole.id, roleForm)
      else await api.createCustomRole(roleForm)
      setRoleOpen(false)
      toast({ message: `Role ${roleForm.name.trim()} disimpan`, tone: 'ok' })
      await rq.refetch()
    } catch (e: unknown) {
      setRoleError(errorText(e, 'Gagal menyimpan role. Coba lagi.'))
    } finally {
      setBusy(false)
    }
  }

  const askDeleteRole = (r: CustomRole) => {
    setDeleteError(null)
    setDelRole(r)
  }

  const deleteRole = async () => {
    if (!delRole || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteCustomRole(delRole.id)
      setDelRole(null)
      await rq.refetch()
    } catch (e: unknown) {
      setDeleteError(errorText(e, 'Gagal menghapus role. Coba lagi.'))
    } finally {
      setDeleting(false)
    }
  }

  const columns = userColumns({
    me,
    outlets,
    onResetPassword: setResetTarget,
    onEdit: (u) => {
      setUnlockNote(null)
      setSaveError(null)
      dispatch({ type: 'OPEN_EDIT', user: u })
    },
  })
  const exportUsers = () =>
    exportToCSV(
      users.map((u) => ({ Nama: u.displayName, Email: u.email, Role: ROLE_LABEL[u.role as Role] ?? u.role, Outlet: outletNameOf(u.outletId) || '', Permissions: (u.permissions || []).join(';'), Terdaftar: u.createdAt?.slice(0, 10) || '' })),
      'pengguna_mandalika',
    )

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
              tabs={tabStrip}
            />
            {tab === 'users' && (
              <>
                <ExportButton rowCount={uq.data ? users.length : null} filterSummary={['semua pengguna']} disabled={!!uq.error || !uq.data} onExport={exportUsers} />
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setAddError(null); setAddOpen(true) }}>
                  Tambah
                </Button>
              </>
            )}
            {tab === 'roles' && (
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setRoleError(null); setEditingRole(null); setRoleForm({ name: '', permissions: [] }); setRoleOpen(true) }}>
                Buat Role
              </Button>
            )}
          </>
        }
      />

      {resetNotice && (
        <div role="status" className="flex items-center gap-3 rounded-xl border border-paper-2 bg-ok-bg px-4 py-3 text-sm font-bold text-ok">
          <span className="flex-1">{resetNotice}</span>
          <IconButton label="Tutup pemberitahuan" onClick={() => setResetNotice(null)}><X className="w-4 h-4" /></IconButton>
        </div>
      )}

      {tab === 'users' && (
        <DataTable
          caption="Daftar pengguna"
          columns={columns}
          rows={users}
          rowKey={(u) => u.id}
          loading={uq.loading && !uq.data}
          error={uq.error ? `Gagal memuat pengguna. ${uq.error}` : null}
          onRetry={() => void uq.refetch()}
          empty={<EmptyState icon={<UsersIcon />} title="Belum ada pengguna" />}
        />
      )}

      {tab === 'roles' && (
        <div className="space-y-3">
          {rq.error && <p role="alert" className="text-sm text-danger">Gagal memuat role kustom. {rq.error}</p>}
          {roles.length === 0 ? (
            <Card>
              <EmptyState icon={<Shield />} title="Belum ada role kustom" />
            </Card>
          ) : (
            <Card className="divide-y divide-paper-2">
              {roles.map((r) => (
                <div key={r.id} className="px-5 py-4 flex items-center gap-3">
                  <div className="flex-1">
                    <p className="font-bold text-ink-900">{r.name}</p>
                    <p className="text-xs text-ink-500 mt-0.5">{r.permissions.length} izin akses aktif</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {r.permissions.slice(0, 4).map((p) => (
                        <Badge key={p} tone="neutral">{PERMS[p]?.label || p}</Badge>
                      ))}
                      {r.permissions.length > 4 && <span className="text-xs text-ink-500 font-bold">+{r.permissions.length - 4} lagi</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <IconButton label={`Edit role ${r.name}`} onClick={() => { setRoleError(null); setEditingRole(r); setRoleForm({ name: r.name, permissions: [...r.permissions] }); setRoleOpen(true) }}><Edit2 className="w-4 h-4" /></IconButton>
                    <IconButton tone="danger" label={`Hapus role ${r.name}`} onClick={() => askDeleteRole(r)}><Trash2 className="w-4 h-4" /></IconButton>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      <SlideOver
        open={!!editingUser}
        onClose={() => dispatch({ type: 'CLOSE' })}
        title="Edit Akses"
        subtitle={editingUser?.displayName}
        footer={
          <SlideOver.Footer>
            <Button variant="secondary" onClick={() => dispatch({ type: 'CLOSE' })}>Batal</Button>
            <Button loading={busy} onClick={saveUser}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
          </SlideOver.Footer>
        }
      >
        <div className="space-y-5">
          {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
          <Field label="Role">
            <RolePicker value={editRole} onChange={(r) => dispatch({ type: 'SET_ROLE', value: r })} />
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
            <p className="text-[11px] text-warn-strong -mt-3">Kasir sebaiknya ditempatkan di satu outlet agar POS dibatasi pada outlet tersebut.</p>
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
              className="w-full px-3 py-2.5 bg-paper-1 border border-paper-2 rounded-xl text-sm text-ink-900 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-brand-strong/40 focus:border-brand-strong transition disabled:opacity-50"
            />
            <label className="mt-1 flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" checked={clearPin} onChange={(e) => dispatch({ type: 'SET_CLEAR_PIN', value: e.target.checked })} />
              Hapus PIN
            </label>
            <div className="mt-2 flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void unlockPin()} disabled={unlocking}>
                {unlocking ? 'Membuka…' : 'Buka kunci PIN'}
              </Button>
              {unlockNote && (
                <span role="status" className={`text-xs ${unlockNote.ok ? 'text-ok' : 'text-danger'}`}>{unlockNote.message}</span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-700">{UNLOCK_PIN_NOTE}</p>
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
            <Field label="Izin akses">
              <PermissionPicker selected={editPerms} onToggle={(p) => dispatch({ type: 'TOGGLE_PERM', perm: p })} />
            </Field>
          )}
        </div>
      </SlideOver>

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
        error={addError}
        onSave={addUser}
      />

      <RoleModal
        open={roleOpen}
        onClose={() => setRoleOpen(false)}
        editingRole={editingRole}
        roleForm={roleForm}
        setRoleForm={setRoleForm}
        busy={busy}
        error={roleError}
        onSave={saveRole}
        delRole={delRole}
        deleteError={deleteError}
        deleting={deleting}
        onCloseDelete={() => setDelRole(null)}
        onConfirmDelete={() => void deleteRole()}
      />
    </div>
  )
}
