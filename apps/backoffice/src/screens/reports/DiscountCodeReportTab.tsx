import { useEffect } from 'react'
import { Tag } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { EmptyState } from '../../ui/EmptyState'
import { Button } from '../../ui/Button'
import { useListState } from '../../lib/router/useListState'
import { PAGE_ONLY_SCHEMA, isAnswerFor, pageOf, pageToClamp } from './reportFilters'
import type { components } from '@mandalika/api'

type Report = components['schemas']['DiscountCodeReport']

const LIMIT = 50

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  aktif: 'success',
  'kuota habis': 'warning',
  kedaluwarsa: 'neutral',
  nonaktif: 'neutral',
}

interface DiscountCodeReportTabProps {
  dateFrom: string
  dateTo: string
  outletId: string
}

/** Backoffice "Kode Diskon" report tab: redemption summary + detail table for
 * discount codes, scoped by the hub's date range (outlet scope rides the
 * request header, not a query param — `outletId` here is a query dep only,
 * so switching outlets still refetches). Reuses `listDiscountCodeReport`
 * (SP-Code-2 grant-reporting-view sibling, Task 4). */
export function DiscountCodeReportTab({ dateFrom, dateTo, outletId }: DiscountCodeReportTabProps) {
  // The page is URL state (#/laporan/kode-diskon?hal=2). The hub sets hal back to 1 when it narrows the set
  // (date range / outlet), else the user can be stranded on a now-empty page while summary cards still total.
  const [state, setState] = useListState(PAGE_ONLY_SCHEMA)
  const page = pageOf(state.hal)

  const rq = usePolledQuery<Report>(
    () => api.listDiscountCodeReport({ dateFrom, dateTo, page, limit: LIMIT }),
    [dateFrom, dateTo, outletId, page],
  )

  const report = rq.data
  const rows = report?.data ?? []
  const summary = report?.summary
  const meta = report?.meta

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
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.totalRedemptions ?? 0)}</p>
          <p className="text-xs text-gray-400">Total Penukaran</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{BRAND.currency.format(summary?.totalValue ?? 0)}</p>
          <p className="text-xs text-gray-400">Total Nilai Diskon</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.distinctCodes ?? 0)}</p>
          <p className="text-xs text-gray-400">Jumlah Kode</p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<Tag />} title="Belum ada penukaran kode pada rentang ini" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Kode', 'Promosi', 'Penukaran', 'Nilai', 'Sisa kuota', 'Status'].map((h) => (
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
                {rows.map((c, i) => (
                  <tr key={`${c.code ?? 'code'}-${i}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-mono font-bold text-gray-900">{c.code}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{c.promotionName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">{c.redemptions ?? 0}</td>
                    <td className="px-4 py-3 text-sm font-black text-gold-600">
                      {BRAND.currency.format(c.valueGiven ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{c.remaining ?? '∞'}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[c.status ?? ''] ?? 'neutral'}>{c.status}</Badge>
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
