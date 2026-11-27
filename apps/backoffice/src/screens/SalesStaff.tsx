import { useState } from 'react'
import type { Outlet, PullUser, SalesStaff as SalesStaffRow, SalesStaffInput } from '@mandalika/api'
import { Plus, UserRoundCheck, X } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { coveredOutlets, outletCoverageOf } from '../lib/outletCoverage'
import { Button } from '../ui/Button'
import { DataTable } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { FilterBar } from '../ui/FilterBar'
import { IconButton } from '../ui/IconButton'
import { PageHeader } from '../ui/PageHeader'
import { SalesStaffDialog } from './salesStaff/SalesStaffDialog'
import { salesStaffColumns } from './salesStaff/salesStaffColumns'
import { errorText } from './users/formError'

type StatusFilter = 'active' | 'inactive' | 'all'

const STATUS_OPTIONS = [
  { value: 'all', label: 'Semua' },
  { value: 'active', label: 'Aktif' },
  { value: 'inactive', label: 'Nonaktif' },
] as const

const RELEASED_NOTE = 'Sales dilepas dari outlet Anda.'

interface Editor {
  entry: SalesStaffRow | null
  linkable: PullUser[]
}

/** "Tim Sales": the per-outlet list of people the cashier can pick as Sales. The server enforces every rule. */
export default function SalesStaff() {
  const { user: me } = useAuth()
  const [outletId, setOutletId] = useState('')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const oq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const outlets = coveredOutlets(oq.data ?? [], outletCoverageOf(me), me?.role === 'admin')
  const q = usePolledQuery<SalesStaffRow[]>(
    () => api.listSalesStaff({ outletId: outletId || undefined, active: status === 'all' ? undefined : status === 'active', q: search.trim() || undefined }),
    [outletId, status, search],
  )
  const rows = q.data ?? []

  const openEditor = async (entry: SalesStaffRow | null) => {
    setNote(null)
    setSaveError(null)
    try {
      setEditor({ entry, linkable: await api.listSalesStaffLinkableUsers() })
    } catch (e: unknown) {
      setSaveError(errorText(e, 'Gagal memuat akun yang bisa ditautkan.'))
      setEditor({ entry, linkable: [] })
    }
  }

  const save = async (input: SalesStaffInput, successNote: string | null) => {
    if (!editor || busy) return
    setBusy(true)
    setSaveError(null)
    // One key per submit: a retry of this same click can never create a second person.
    const key = crypto.randomUUID()
    try {
      const saved = editor.entry ? await api.updateSalesStaff(editor.entry.id, input, key) : await api.createSalesStaff(input, key)
      setEditor(null)
      // A manager who removed their own outlets from a shared person no longer sees the row: say so instead of failing.
      setNote(saved.outletIds.length === 0 ? RELEASED_NOTE : successNote)
      await q.refetch()
    } catch (e: unknown) {
      setSaveError(errorText(e, 'Gagal menyimpan. Coba lagi.'))
    } finally {
      setBusy(false)
    }
  }

  const resetFilters = () => {
    setOutletId('')
    setStatus('active')
    setSearch('')
  }
  const activeFilters = (outletId ? 1 : 0) + (status !== 'active' ? 1 : 0) + (search ? 1 : 0)
  const columns = salesStaffColumns({ outlets, onEdit: (s) => void openEditor(s) })

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Tim Sales"
        subtitle="Orang yang bisa dipilih sebagai Sales di kasir, per outlet."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => void openEditor(null)}>Tambah sales</Button>
        }
      />

      {note && (
        <div role="status" className="flex items-center gap-3 rounded-xl border border-paper-2 bg-ok-bg px-4 py-3 text-sm font-bold text-ok">
          <span className="flex-1">{note}</span>
          <IconButton label="Tutup pemberitahuan" onClick={() => setNote(null)}><X className="h-4 w-4" /></IconButton>
        </div>
      )}

      <FilterBar onReset={resetFilters} activeCount={activeFilters}>
        <FilterBar.Select
          label="Outlet"
          value={outletId}
          onChange={setOutletId}
          options={[{ value: '', label: 'Semua' }, ...outlets.map((o) => ({ value: o.id, label: o.name }))]}
        />
        <FilterBar.Select label="Status" value={status} onChange={(v) => setStatus(v as StatusFilter)} options={STATUS_OPTIONS} />
        <FilterBar.Search label="Cari sales" placeholder="Cari nama..." value={search} onChange={setSearch} />
      </FilterBar>

      <DataTable
        caption="Daftar tim sales"
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        loading={q.loading && !q.data}
        error={q.error ? `Gagal memuat tim sales. ${q.error}` : null}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<UserRoundCheck />} title="Belum ada tim sales. Tambahkan sales agar muncul di pilihan Sales di kasir." />}
      />

      {editor && (
        <SalesStaffDialog
          key={editor.entry?.id ?? 'new'}
          entry={editor.entry}
          outlets={outlets}
          linkable={editor.linkable}
          busy={busy}
          error={saveError}
          onSave={(input) => void save(input, editor.entry ? `${input.name} disimpan` : `${input.name} ditambahkan`)}
          onRelease={(input) => void save(input, RELEASED_NOTE)}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  )
}
