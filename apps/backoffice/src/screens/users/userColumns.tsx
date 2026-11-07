import type { Outlet, User } from '@mandalika/api'
import { Edit2, KeyRound, Store } from 'lucide-react'
import type { Column } from '../../ui/DataTable'
import { IconButton } from '../../ui/IconButton'
import { Badge } from '../../ui/Badge'
import { ROLE } from '../../lib/labels/role'
import { labelOf } from '../../lib/labels/types'

interface UserColumnOptions {
  me: User | null | undefined
  outlets: readonly Outlet[]
  onResetPassword: (u: User) => void
  onEdit: (u: User) => void
}

/** Columns of the Pengguna list. Row actions show only to an admin, never on the admin's own row. */
export function userColumns({ me, outlets, onResetPassword, onEdit }: UserColumnOptions): Column<User>[] {
  const outletNameOf = (id?: string | null) => outlets.find((o) => o.id === id)?.name
  const canAct = (u: User) => me?.role === 'admin' && u.id !== me?.id
  return [
    {
      id: 'nama',
      header: 'Pengguna',
      cell: (u) => (
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-paper-1">
            {u.photoURL ? (
              <img src={u.photoURL} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-sm font-black text-brand-strong">{u.displayName.charAt(0)}</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink-900">
              {u.displayName}
              {u.id === me?.id && <span className="ml-2 text-xs font-bold text-ink-700">(Anda)</span>}
            </p>
            <p className="text-xs text-ink-700">{u.email}</p>
          </div>
        </div>
      ),
    },
    {
      id: 'outlet',
      header: 'Outlet',
      cell: (u) => (
        <span className="inline-flex items-center gap-1 text-xs text-ink-700">
          <Store className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          {outletNameOf(u.outletId) || (u.role === 'admin' ? 'Semua Outlet' : 'Belum diatur')}
        </span>
      ),
    },
    {
      id: 'permission',
      header: 'Izin akses',
      cell: (u) => {
        const n = (u.permissions || []).length
        return u.role !== 'admin' && n > 0 ? <span className="text-xs text-ink-700">{n} izin akses aktif</span> : <span className="text-xs text-ink-500">—</span>
      },
    },
    { id: 'role', header: 'Role', cell: (u) => <Badge tone="neutral">{labelOf(ROLE, u.role).label}</Badge> },
    {
      id: 'aksi',
      header: 'Aksi',
      hideable: false,
      align: 'right',
      cell: (u) =>
        canAct(u) ? (
          <div className="flex items-center justify-end gap-1">
            <IconButton label={`Reset kata sandi ${u.displayName}`} onClick={() => onResetPassword(u)}><KeyRound className="h-4 w-4" /></IconButton>
            <IconButton label={`Edit ${u.displayName}`} onClick={() => onEdit(u)}><Edit2 className="h-4 w-4" /></IconButton>
          </div>
        ) : null,
    },
  ]
}
