import type { Outlet, SalesStaff } from '@mandalika/api'
import { Edit2 } from 'lucide-react'
import type { Column } from '../../ui/DataTable'
import { Badge } from '../../ui/Badge'
import { IconButton } from '../../ui/IconButton'

interface SalesStaffColumnOptions {
  outlets: readonly Outlet[]
  onEdit: (s: SalesStaff) => void
}

/** Columns of the Tim Sales list: name, visible outlets (+ a count of hidden ones), linked account, status. */
export function salesStaffColumns({ outlets, onEdit }: SalesStaffColumnOptions): Column<SalesStaff>[] {
  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? '—'
  return [
    { id: 'nama', header: 'Nama', cell: (s) => <span className="text-sm font-bold text-ink-900">{s.name}</span> },
    {
      id: 'outlet',
      header: 'Outlet',
      cell: (s) => (
        <div className="flex flex-wrap items-center gap-1">
          {s.outletIds.map((id) => (
            <Badge key={id} tone="neutral">{outletName(id)}</Badge>
          ))}
          {s.hiddenOutletCount > 0 && <span className="text-xs font-bold text-ink-700">+{s.hiddenOutletCount} outlet lain</span>}
        </div>
      ),
    },
    { id: 'akun', header: 'Akun tertaut', cell: (s) => (s.user ? s.user.displayName : <span className="text-ink-500">—</span>) },
    {
      id: 'status',
      header: 'Status',
      cell: (s) => (s.active ? <Badge tone="success" dot>Aktif</Badge> : <Badge tone="neutral" dot>Nonaktif</Badge>),
    },
    {
      id: 'aksi',
      header: 'Aksi',
      align: 'right',
      hideable: false,
      cell: (s) => (
        <IconButton label={`Ubah ${s.name}`} onClick={() => onEdit(s)}><Edit2 className="h-4 w-4" /></IconButton>
      ),
    },
  ]
}
