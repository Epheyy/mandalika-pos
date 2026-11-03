import { useState } from 'react'
import type { AppSettings, Outlet } from '@mandalika/api'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { localDay } from '../lib/businessDay'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { paymentFilterOptions } from '../lib/paymentOptions'
import { OrdersPanel } from './Orders'
import { ExportTab } from './reports/ExportTab'
import { ShiftsTab } from './reports/ShiftsTab'
import { PromoGrantsTab } from './reports/PromoGrantsTab'
import { DiscountCodeReportTab } from './reports/DiscountCodeReportTab'
import { RefundReportTab } from './reports/RefundReportTab'
import { OversellTab } from './reports/OversellTab'
import { useOversellOpenCount } from './reports/useOversellOpenCount'
import { PAGE_ONLY_SCHEMA, carriedDays, dayOf, dayToQuery, enumOf, pageOf, paymentOf, withCurrent } from './reports/reportFilters'
import { Input, Select } from '../ui/Field'
import { Card } from '../ui/Card'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { buildHash } from '../lib/router/hash'
import { getRouteLocation, navigate } from '../lib/router/navigate'
import { routeById } from '../lib/router/routes'
import { useListState, type ListSchema } from '../lib/router/useListState'
import { useScreenTabs } from '../lib/router/useScreenTabs'
import { useResetPageOnChange } from '../lib/useResetPageOnChange'

type ReportTab = 'orders' | 'export' | 'shifts' | 'grants' | 'codeReport' | 'refund' | 'oversell'

interface HubState {
  dari: string
  sampai: string
  status: string
  bayar: string
  hal: number
  [key: string]: string | number
}

// The hub's own query keys: the date range every tab but Transaksi shares, the Unduh data filters, and hal (which
// the hub resets to 1 whenever it changes the set). Each tab reads its own keys through its own schema.
// dari/sampai default to '' = today, resolved when read: a module constant would go stale past midnight.
const HUB_SCHEMA: ListSchema<HubState> = {
  dari: { key: 'dari', default: '' },
  sampai: { key: 'sampai', default: '' },
  status: { key: 'status', default: '' },
  bayar: { key: 'bayar', default: '' },
  hal: PAGE_ONLY_SCHEMA.hal,
}

const EXPORT_STATUSES = ['completed', 'partially_refunded', 'refunded'] as const

export default function Reports() {
  const { user } = useAuth()
  const { outletId } = useOutlet()

  const isAdmin = user?.role === 'admin'
  const perms = user?.permissions ?? []
  const canViewReports = isAdmin || perms.includes('view_reports')

  const canAcknowledgeOversell = isAdmin || perms.includes('manage_stock_count')
  const oversellOpen = useOversellOpenCount(canViewReports, outletId ?? null)

  // The tab lives in the path (#/laporan/refund); a bare #/laporan is the first tab this user may open.
  const { tabs: routeTabs, tab: routedTab } = useScreenTabs<ReportTab>('reports', user)
  const visibleTabs = routeTabs.map((t) => ({
    id: t.key,
    label: t.key === 'oversell' && oversellOpen > 0 ? `${t.label} (${oversellOpen})` : t.label,
  }))
  const tab: ReportTab = routedTab ?? 'export'

  // Dari/Sampai, status and payment are URL query state. The server reads dateFrom/dateTo as business days (the day
  // in each outlet's own timezone, a shift's sales on its opening day); the default is the local calendar date.
  const [state, setState] = useListState(HUB_SCHEMA)
  // Once per mount: the default must not roll over at midnight under an open screen (it would remount the tabs).
  const [today] = useState(() => localDay())
  const dateFrom = dayOf(state.dari, today)
  const dateTo = dayOf(state.sampai, today)
  const fStatus = enumOf<string>(state.status, EXPORT_STATUSES, '')
  const fPay = paymentOf(state.bayar)

  // An outlet switch can leave a page number that does not exist in the new scope; the tabs that remount on the
  // outlet keep their race protection, this puts hal back to 1 (replace: Back must not return to the old page).
  useResetPageOnChange(outletId ?? null, pageOf(state.hal), () => setState({ hal: 1 }, { replace: true }))

  // Choosing a tab drops the query (it belongs to the tab it was set on), except Dari/Sampai, which the tabs
  // that share them carry along. Transaksi keeps its own 30-day window, so it neither gives nor takes them.
  const selectTab = (next: ReportTab) => {
    const slug = routeTabs.find((t) => t.key === next)?.slug
    if (slug === undefined) return
    const days = carriedDays(getRouteLocation().query, tab, next)
    void navigate(buildHash([routeById('reports')?.path ?? 'laporan', slug], days))
  }

  // Only the lightweight lookups live here; each tab fetches its own data while active.
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const aq = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 60000)
  const payOptions = withCurrent(paymentFilterOptions(aq.data?.paymentMethods), fPay)
  const outlets = ouq.data ?? []

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Laporan"
        subtitle="Unduh data untuk analisis lebih lanjut"
        actions={
          <Tabs
            value={tab}
            onChange={selectTab}
            tabs={visibleTabs}
          />
        }
      />

      {tab === 'orders' && <OrdersPanel key={outletId ?? 'all'} />}

      {tab !== 'orders' && (
      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <Input
          type="date"
          label="Dari"
          value={dateFrom}
          onChange={(e) => setState({ dari: dayToQuery(e.target.value), hal: 1 }, { replace: true })}
          className="w-auto"
        />
        <Input
          type="date"
          label="Sampai"
          value={dateTo}
          onChange={(e) => setState({ sampai: dayToQuery(e.target.value), hal: 1 }, { replace: true })}
          className="w-auto"
        />
        {tab === 'export' && (
          <>
            <Select
              label="Status"
              value={fStatus}
              onChange={(e) => setState({ status: e.target.value, hal: 1 })}
              className="w-auto"
            >
              <option value="">Semua Status</option>
              <option value="completed">Selesai</option>
              <option value="partially_refunded">Sebagian refund</option>
              <option value="refunded">Refund</option>
            </Select>
            <Select
              label="Pembayaran"
              value={fPay}
              onChange={(e) => setState({ bayar: e.target.value, hal: 1 })}
              className="w-auto"
            >
              <option value="">Semua</option>
              {payOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </>
        )}
      </Card>
      )}

      {tab === 'grants' && <PromoGrantsTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId ?? ''} />}

      {tab === 'codeReport' && <DiscountCodeReportTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId ?? ''} />}

      {tab === 'refund' && <RefundReportTab key={`${outletId}|${dateFrom}|${dateTo}`} dateFrom={dateFrom} dateTo={dateTo} outletId={outletId ?? ''} />}

      {tab === 'oversell' && (
        <OversellTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId ?? ''} canAcknowledge={canAcknowledgeOversell} />
      )}

      {tab === 'export' && (
        // Remount on a filter change (it also carries the outlet-switch race protection); hal goes back to 1 in the
        // same patch that changed the filter, so paging restarts at page 1.
        <ExportTab
          key={`${outletId}|${dateFrom}|${dateTo}|${fStatus}|${fPay}`}
          filters={{ dateFrom, dateTo, status: fStatus, payment: fPay, q: '' }}
          outletId={outletId}
          outlets={outlets}
          paymentMethods={aq.data?.paymentMethods}
        />
      )}

      {tab === 'shifts' && <ShiftsTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId} outlets={outlets} />}
    </div>
  )
}
