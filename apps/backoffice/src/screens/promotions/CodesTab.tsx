import { useCallback, useState, type ReactNode } from 'react'
import type { DiscountCode, DiscountCodeBatchInput, Promotion } from '@mandalika/api'
import { Layers, Plus } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { buildExportName, exportToCSV, exportToXLSX } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { ExportButton, type ExportFormat } from '../../ui/ExportButton'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { useToast } from '../../ui/Toast'
import { DeleteConfirmDialog } from '../products/DeleteConfirmDialog'
import { CodeEditorHost } from './CodeEditorHost'
import { CodesTable } from './CodesTable'
import { DiscountCodeBatchModal } from './DiscountCodeBatchModal'
import { PromoListFilters } from './PromoListFilters'
import { EMPTY_BATCH, codeToInput } from './discountCodeForm'
import { codeExportRows } from './promoDisplay'
import { PROMO_PAGE_SIZES } from './promoListState'
import { wibDay } from './promoStatus'
import { usePromoList } from './usePromoList'
import { useRowDelete } from './useRowDelete'
import { useStatusToggle, type StatusToggleKind } from './useStatusToggle'

interface CodesTabProps {
  /** The Promosi / Kode Diskon tab strip, shown in the header. */
  tabs: ReactNode
}

const fetchPage = api.listDiscountCodesPage
const removeCode = (id: string) => api.deleteDiscountCode(id)
const fetchAllPromotions = () => api.listPromotions()

const STATUS_KIND: StatusToggleKind<DiscountCode> = {
  noun: 'kode',
  nameOf: (c) => c.code,
  fetchAll: () => api.listDiscountCodes(),
  save: async (fresh, isActive) => {
    await api.updateDiscountCode(fresh.id, { ...codeToInput(fresh), isActive })
  },
}

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback)

export function CodesTab({ tabs }: CodesTabProps) {
  const list = usePromoList<DiscountCode>('codes', fetchPage)
  const toast = useToast()
  const del = useRowDelete<DiscountCode>(removeCode, list.refetch, 'Gagal menghapus kode diskon.')
  const status = useStatusToggle(STATUS_KIND, list.refetch)
  // Names for "Tertaut: …" and the batch picker. The code list is paged, the promotions are not.
  const promos = usePolledQuery<Promotion[]>(fetchAllPromotions, [], 60_000)
  const promotions = promos.data ?? []
  const { state, setOverlay } = list
  const today = wibDay()

  const editingId = state.ubah !== '' ? state.ubah : null
  const overlayOpen = editingId !== null || state.baru
  const openEditor = (patch: { ubah?: string; baru?: boolean }) => setOverlay(patch)
  const closeEditor = useCallback(() => setOverlay({ ubah: '', baru: false }, { replace: true }), [setOverlay])

  const [batchOpen, setBatchOpen] = useState(false)
  const [batchForm, setBatchForm] = useState<DiscountCodeBatchInput>(EMPTY_BATCH)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)

  const openBatch = () => {
    setBatchForm({ ...EMPTY_BATCH })
    setBatchError(null)
    setBatchOpen(true)
  }
  const closeBatch = () => {
    if (!batchBusy) setBatchOpen(false)
  }
  const generateBatch = async () => {
    setBatchBusy(true)
    setBatchError(null)
    try {
      const created = await api.createDiscountCodeBatch({ ...batchForm, prefix: (batchForm.prefix || '').toUpperCase() })
      await list.refetch()
      setBatchOpen(false)
      if (created.length) {
        exportToCSV(created.map((c) => ({ Kode: c.code, Tipe: c.type, Nilai: c.value, Kuota: c.usageLimit ?? 0 })), 'kode-diskon-batch')
        toast({ message: `${created.length} kode dibuat. Daftar kode sudah diunduh.`, tone: 'ok' })
      }
    } catch (e: unknown) {
      setBatchError(messageOf(e, 'Kode massal gagal dibuat.'))
    } finally {
      setBatchBusy(false)
    }
  }

  const copy = async (c: DiscountCode) => {
    try {
      await navigator.clipboard.writeText(c.code)
      toast({ message: `Kode ${c.code} disalin`, tone: 'ok' })
    } catch {
      toast({ message: 'Kode gagal disalin. Salin manual dari tabel.', tone: 'warn' })
    }
  }

  const exportAll = useCallback(
    async (format: ExportFormat) => {
      const all = await list.fetchEvery()
      if (all.length === 0) return
      const name = buildExportName('kode-diskon', list.filterSummary)
      const rows = codeExportRows(all, wibDay())
      if (format === 'xlsx') exportToXLSX(rows, name)
      else exportToCSV(rows, name)
    },
    [list],
  )

  const totalPages = Math.max(1, Math.ceil(list.total / state.per))

  return (
    <>
      <PageHeader
        title="Promosi"
        count={list.loaded ? `${list.total} kode diskon` : undefined}
        subtitle="Kode yang dimasukkan kasir. Perubahan dipakai tablet setelah sinkron berikutnya."
        actions={
          <>
            {tabs}
            <ExportButton formats={['csv', 'xlsx']} rowCount={list.loaded ? list.total : null} filterSummary={list.filterSummary} onExport={exportAll} disabled={list.loaded && list.total === 0} />
            <Button variant="secondary" icon={<Layers className="h-4 w-4" />} onClick={openBatch}>Buat Massal</Button>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openEditor({ baru: true, ubah: '' })}>Tambah Kode</Button>
          </>
        }
      />

      <PromoListFilters kind="codes" state={state} activeCount={list.activeCount} onChange={list.setFilter} onReset={list.reset} />

      <CodesTable
        rows={list.rows}
        promotions={promotions}
        today={today}
        loading={list.loading}
        error={list.error ? 'Daftar kode diskon gagal dimuat.' : null}
        onRetry={() => void list.refetch()}
        selectedId={editingId}
        filtered={list.activeCount > 0}
        busyIds={status.busyIds}
        onToggle={(c, next) => void status.toggle(c, next)}
        onEdit={(c) => openEditor({ ubah: c.id, baru: false })}
        onCopy={(c) => void copy(c)}
        onDelete={del.ask}
        footer={
          <Pagination
            page={state.hal}
            totalPages={totalPages}
            total={list.total}
            onChange={list.setPage}
            pageSize={state.per}
            onPageSizeChange={list.setPageSize}
            pageSizes={[...PROMO_PAGE_SIZES]}
          />
        }
      />

      {overlayOpen && <CodeEditorHost key={editingId ?? 'baru'} codeId={editingId} closeEditor={closeEditor} refetchList={list.refetch} />}

      <DiscountCodeBatchModal
        open={batchOpen}
        busy={batchBusy}
        error={batchError}
        form={batchForm}
        setForm={setBatchForm}
        promotions={promotions}
        onGenerate={() => void generateBatch()}
        onClose={closeBatch}
      />

      <DeleteConfirmDialog
        open={del.target !== null}
        subject={del.target ? `kode "${del.target.code}"` : 'kode diskon'}
        error={del.error}
        busy={del.busy}
        onConfirm={() => void del.confirm()}
        onCancel={del.cancel}
      />
    </>
  )
}
