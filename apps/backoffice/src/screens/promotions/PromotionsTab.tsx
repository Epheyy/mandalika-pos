import { useCallback, useState, type ReactNode } from 'react'
import type { Promotion } from '@mandalika/api'
import { Plus } from 'lucide-react'
import { api } from '../../api'
import { buildExportName, exportToCSV, exportToXLSX } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { ExportButton, type ExportFormat } from '../../ui/ExportButton'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { useToast } from '../../ui/Toast'
import { DeleteConfirmDialog } from '../products/DeleteConfirmDialog'
import { PromoListFilters } from './PromoListFilters'
import { PromotionEditorHost } from './PromotionEditorHost'
import { PromotionsTable } from './PromotionsTable'
import { promotionExportRows } from './promoDisplay'
import { PROMO_PAGE_SIZES } from './promoListState'
import { wibDay } from './promoStatus'
import { duplicateInput, promotionToInput } from './promotionForm'
import { usePromoList } from './usePromoList'
import { useRowDelete } from './useRowDelete'
import { useStatusToggle, type StatusToggleKind } from './useStatusToggle'

interface PromotionsTabProps {
  /** The Promosi / Kode Diskon tab strip, shown in the header. */
  tabs: ReactNode
}

const fetchPage = api.listPromotionsPage
const removePromotion = (id: string) => api.deletePromotion(id)

// Module-level so its identity never changes between renders. The row sent is always the FRESH one.
const STATUS_KIND: StatusToggleKind<Promotion> = {
  noun: 'promo',
  nameOf: (p) => p.name,
  fetchAll: () => api.listPromotions(),
  save: async (fresh, isActive) => {
    await api.updatePromotion(fresh.id, { ...promotionToInput(fresh), isActive })
  },
}

export function PromotionsTab({ tabs }: PromotionsTabProps) {
  const list = usePromoList<Promotion>('promotions', fetchPage)
  const toast = useToast()
  const del = useRowDelete<Promotion>(removePromotion, list.refetch, 'Gagal menghapus promosi.')
  const status = useStatusToggle(STATUS_KIND, list.refetch)
  const { state, setOverlay } = list
  const today = wibDay()

  // The overlay is URL state: `?ubah=<id>` edits, `?baru=1` creates. The id is only matched against the fetched list.
  const editingId = state.ubah !== '' ? state.ubah : null
  const overlayOpen = editingId !== null || state.baru
  const openEditor = (patch: { ubah?: string; baru?: boolean }) => setOverlay(patch)
  const closeEditor = useCallback(() => setOverlay({ ubah: '', baru: false }, { replace: true }), [setOverlay])

  const [duplicating, setDuplicating] = useState(false)
  const duplicate = async (p: Promotion) => {
    if (duplicating) return
    setDuplicating(true)
    try {
      // Read fresh, like the status switch: the visible row may be a poll old.
      const fresh = (await api.listPromotions()).find((r) => r.id === p.id)
      if (!fresh) {
        toast({ message: 'Promosi tidak ditemukan. Mungkin sudah dihapus.', tone: 'warn' })
        return
      }
      await api.createPromotion(duplicateInput(fresh))
      toast({ message: `Promosi ${p.name} disalin`, tone: 'ok' })
    } catch (e: unknown) {
      toast({ message: e instanceof Error && e.message ? e.message : 'Promosi gagal disalin.', tone: 'warn' })
    }
    await list.refetch()
    setDuplicating(false)
  }

  const exportAll = useCallback(
    async (format: ExportFormat) => {
      const all = await list.fetchEvery()
      if (all.length === 0) return
      const name = buildExportName('promosi', list.filterSummary)
      const rows = promotionExportRows(all, wibDay())
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
        count={list.loaded ? `${list.total} promosi` : undefined}
        subtitle="Promo bertanda Otomatis langsung masuk ke keranjang kasir saat syaratnya terpenuhi; promo lain ditambahkan kasir lewat panel Promo. Perubahan dipakai tablet setelah sinkron berikutnya."
        actions={
          <>
            {tabs}
            <ExportButton formats={['csv', 'xlsx']} rowCount={list.loaded ? list.total : null} filterSummary={list.filterSummary} onExport={exportAll} disabled={list.loaded && list.total === 0} />
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openEditor({ baru: true, ubah: '' })}>
              Tambah Promosi
            </Button>
          </>
        }
      />

      <PromoListFilters kind="promotions" state={state} activeCount={list.activeCount} onChange={list.setFilter} onReset={list.reset} />

      <PromotionsTable
        rows={list.rows}
        today={today}
        loading={list.loading}
        error={list.error ? 'Daftar promosi gagal dimuat.' : null}
        onRetry={() => void list.refetch()}
        selectedId={editingId}
        filtered={list.activeCount > 0}
        busyIds={status.busyIds}
        onToggle={(p, next) => void status.toggle(p, next)}
        onEdit={(p) => openEditor({ ubah: p.id, baru: false })}
        onDuplicate={(p) => void duplicate(p)}
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

      {overlayOpen && <PromotionEditorHost key={editingId ?? 'baru'} promoId={editingId} closeEditor={closeEditor} refetchList={list.refetch} />}

      <DeleteConfirmDialog
        open={del.target !== null}
        subject={del.target ? `promosi "${del.target.name}"` : 'promosi'}
        error={del.error}
        busy={del.busy}
        onConfirm={() => void del.confirm()}
        onCancel={del.cancel}
      />
    </>
  )
}
