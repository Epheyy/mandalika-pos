import { useEffect } from 'react'
import { Gift } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { FilterBar } from '../../ui/FilterBar'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { PAGE_ONLY_SCHEMA, isAnswerFor, pageOf, pageToClamp, totalPagesOf, uuidOf } from './reportFilters'
import { ReportPager } from './ReportPager'
import type { components } from '@mandalika/api'
import { useCachedList } from '../../hooks/useCachedList'
import { productCatalogue } from '../../lib/productCatalogue'

type Report = components['schemas']['PromoRewardGrantReport']
type Promotion = components['schemas']['Promotion']
/** A grant row with its position: the report has no row id and two grants can match on every field. */
type Grant = Report['data'][number] & { rowIndex: number }

const LIMIT = 50

interface GrantsListState {
  promo: string
  produk: string
  hal: number
  [key: string]: string | number
}

const GRANTS_SCHEMA: ListSchema<GrantsListState> = {
  promo: { key: 'promo', default: '' },
  produk: { key: 'produk', default: '' },
  hal: PAGE_ONLY_SCHEMA.hal,
}

const GRANT_COLUMNS: Column<Grant>[] = [
  { id: 'tanggal', header: 'Tanggal', cell: (g) => <span className="whitespace-nowrap text-xs">{g.createdAt ? new Date(g.createdAt).toLocaleDateString('id-ID') : '-'}</span> },
  { id: 'order', header: 'No. Order', cell: (g) => <span className="font-bold">{g.orderNumber ?? '-'}</span> },
  { id: 'promosi', header: 'Promosi', cell: (g) => g.promotionName ?? '-' },
  { id: 'produk', header: 'Produk', cell: (g) => `${g.productName ?? '-'}${g.variantSize ? ` · ${g.variantSize}` : ''}` },
  { id: 'qty', header: 'Qty', align: 'right', cell: (g) => g.quantity ?? 0 },
  { id: 'nilai', header: 'Nilai', align: 'right', cell: (g) => <span className="font-black">{BRAND.currency.format(g.valueGivenAway ?? 0)}</span> },
]

interface BreakdownRow {
  key: string
  label: string
  value: number
  items: number
}

interface PromoGrantsTabProps {
  dateFrom: string
  dateTo: string
  outletId: string
}

/** Backoffice "Hadiah Promo" report tab: summary + per-promotion/per-product
 * breakdowns + a grouped detail list, scoped by the hub's date range/outlet
 * and filterable by promotion/product. Reuses `listPromoRewardGrants`
 * (SP-Promo grant-reporting-view, Task 4). */
export function PromoGrantsTab({ dateFrom, dateTo, outletId }: PromoGrantsTabProps) {
  // Filters and page are URL state (#/laporan/hadiah-promo?promo=<id>&produk=<id>&hal=2). The hub sets hal back
  // to 1 when it narrows the set (date range / outlet), else the user can be stranded on a now-empty page.
  const [state, setState] = useListState(GRANTS_SCHEMA)
  const promotionId = uuidOf(state.promo)
  const productId = uuidOf(state.produk)
  const page = pageOf(state.hal)

  const pq = usePolledQuery<Promotion[]>(() => api.listPromotions(), [])
  const prq = useCachedList(productCatalogue)
  const rq = usePolledQuery<Report>(
    () =>
      api.listPromoRewardGrants({
        dateFrom,
        dateTo,
        outletId,
        promotionId,
        productId,
        page,
        limit: LIMIT,
      }),
    [dateFrom, dateTo, outletId, promotionId, productId, page],
  )

  const promotions = pq.data ?? []
  const products = prq.data ?? []
  const report = rq.data
  const rows: Grant[] = (report?.data ?? []).map((g, rowIndex) => ({ ...g, rowIndex }))
  const summary = report?.summary
  const meta = report?.meta

  const byPromotionRows: BreakdownRow[] = (summary?.byPromotion ?? []).map((b, i) => ({
    key: b.promotionId ?? `${b.promotionName ?? 'promo'}-${i}`,
    label: b.promotionName ?? '—',
    value: b.value ?? 0,
    items: b.items ?? 0,
  }))
  const byProductRows: BreakdownRow[] = (summary?.byProduct ?? []).map((b, i) => ({
    key: `${b.productId ?? 'produk'}-${b.variantSize ?? ''}-${i}`,
    label: `${b.productName ?? '—'}${b.variantSize ? ` · ${b.variantSize}` : ''}`,
    value: b.value ?? 0,
    items: b.items ?? 0,
  }))

  // A page past the end (a stale link) moves to the last page.
  useEffect(() => {
    if (rq.loading || rq.error || !isAnswerFor(meta, page)) return
    if (!meta) return
    const target = pageToClamp(page, meta.total, meta.limit || LIMIT)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [rq.loading, rq.error, meta, page, setState])

  return (
    <div className="space-y-5">
      <FilterBar onReset={() => setState({ promo: '', produk: '', hal: 1 })} activeCount={(promotionId ? 1 : 0) + (productId ? 1 : 0)}>
        <FilterBar.Select
          label="Promosi"
          value={promotionId}
          onChange={(v) => setState({ promo: v, hal: 1 })}
          options={[{ value: '', label: 'Semua promosi' }, ...promotions.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <FilterBar.Select
          label="Produk"
          value={productId}
          onChange={(v) => setState({ produk: v, hal: 1 })}
          options={[{ value: '', label: 'Semua produk' }, ...products.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </FilterBar>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{BRAND.currency.format(summary?.totalValue ?? 0)}</p>
          <p className="text-xs text-gray-400">Total Nilai Hadiah</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.totalItems ?? 0)}</p>
          <p className="text-xs text-gray-400">Jumlah Item</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.totalOrders ?? 0)}</p>
          <p className="text-xs text-gray-400">Jumlah Transaksi</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownTable title="Per Promosi" rows={byPromotionRows} />
        <BreakdownTable title="Per Produk" rows={byProductRows} />
      </div>

      <DataTable
        caption="Hadiah promo yang diberikan"
        columns={GRANT_COLUMNS}
        rows={rows}
        rowKey={(g) => `${g.orderId ?? ''}-${g.productId ?? ''}-${g.variantSize ?? ''}-${g.rowIndex}`}
        loading={rq.loading && !rq.data}
        error={rq.error ? `Gagal memuat hadiah promo. ${rq.error}` : null}
        onRetry={() => void rq.refetch()}
        empty={<EmptyState icon={<Gift />} title="Belum ada hadiah promo pada rentang ini" />}
        footer={meta && totalPagesOf(meta.total, meta.limit || LIMIT) > 1 ? <ReportPager page={page} total={meta.total} limit={meta.limit || LIMIT} onChange={(p) => setState({ hal: p })} /> : undefined}
      />
    </div>
  )
}

function BreakdownTable({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  return (
    <Card className="p-4">
      <h3 className="font-black text-gray-900 mb-3">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400">Belum ada data</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between text-sm gap-3">
              <span className="text-gray-600 truncate">{r.label}</span>
              <span className="flex items-center gap-3 flex-shrink-0">
                <span className="text-gray-400 text-xs">{r.items}x</span>
                <span className="font-bold text-gray-900">{BRAND.currency.format(r.value)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
