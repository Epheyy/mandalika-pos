import type { ChangeEvent } from 'react'
import { useEffect } from 'react'
import { Gift } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { Select } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Button } from '../../ui/Button'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { PAGE_ONLY_SCHEMA, isAnswerFor, pageOf, pageToClamp, uuidOf } from './reportFilters'
import { fetchAllPages, type components } from '@mandalika/api'

type Report = components['schemas']['PromoRewardGrantReport']
type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']

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
  const prq = usePolledQuery<Product[]>(() => fetchAllPages((page, limit) => api.listProducts(page, limit)), [outletId])
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
  const rows = report?.data ?? []
  const summary = report?.summary
  const meta = report?.meta

  const handlePromotionChange = (e: ChangeEvent<HTMLSelectElement>) => setState({ promo: e.target.value, hal: 1 })
  const handleProductChange = (e: ChangeEvent<HTMLSelectElement>) => setState({ produk: e.target.value, hal: 1 })

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

  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / (meta.limit || LIMIT))) : 1
  // A page past the end (a stale link) moves to the last page.
  useEffect(() => {
    if (rq.loading || rq.error || !isAnswerFor(meta, page)) return
    if (!meta) return
    const target = pageToClamp(page, meta.total, meta.limit || LIMIT)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [rq.loading, rq.error, meta, page, setState])

  return (
    <div className="space-y-5">
      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <Select label="Promosi" value={promotionId} onChange={handlePromotionChange} className="w-auto">
          <option value="">Semua promosi</option>
          {promotions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select label="Produk" value={productId} onChange={handleProductChange} className="w-auto">
          <option value="">Semua produk</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Card>

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

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<Gift />} title="Belum ada hadiah promo pada rentang ini" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Tanggal', 'No. Order', 'Promosi', 'Produk', 'Qty', 'Nilai'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((g, i) => (
                  <tr key={`${g.orderId ?? ''}-${g.productId ?? ''}-${g.variantSize ?? ''}-${i}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {g.createdAt ? new Date(g.createdAt).toLocaleDateString('id-ID') : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm font-bold text-gray-900">{g.orderNumber ?? '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{g.promotionName ?? '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {g.productName ?? '-'}
                      {g.variantSize ? ` · ${g.variantSize}` : ''}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">{g.quantity ?? 0}</td>
                    <td className="px-4 py-3 text-sm font-black text-gold-600">
                      {BRAND.currency.format(g.valueGivenAway ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {meta && meta.total > LIMIT && (
        <div className="flex items-center justify-between px-1">
          <p className="text-xs text-gray-400">
            Halaman {meta.page} dari {totalPages} · {meta.total} baris
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setState({ hal: Math.max(1, page - 1) })}>
              Sebelumnya
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setState({ hal: page + 1 })}
            >
              Berikutnya
            </Button>
          </div>
        </div>
      )}
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
