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
import { Input, Select } from '../ui/Field'
import { Card } from '../ui/Card'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { useScreenTabs } from '../lib/router/useScreenTabs'

type ReportTab = 'orders' | 'export' | 'shifts' | 'grants' | 'codeReport' | 'refund' | 'oversell'

export default function Reports() {
  const { user } = useAuth()
  const { outletId } = useOutlet()

  const isAdmin = user?.role === 'admin'
  const perms = user?.permissions ?? []
  const canViewReports = isAdmin || perms.includes('view_reports')

  const canAcknowledgeOversell = isAdmin || perms.includes('manage_stock_count')
  const oversellOpen = useOversellOpenCount(canViewReports, outletId ?? null)

  // The tab lives in the path (#/laporan/refund); a bare #/laporan is the first tab this user may open.
  const { tabs: routeTabs, tab: routedTab, setTab } = useScreenTabs<ReportTab>('reports', user)
  const visibleTabs = routeTabs.map((t) => ({
    id: t.key,
    label: t.key === 'oversell' && oversellOpen > 0 ? `${t.label} (${oversellOpen})` : t.label,
  }))
  const tab: ReportTab = routedTab ?? 'export'
  // Local calendar date; the server reads dateFrom/dateTo as business days (the day in each
  // outlet's own timezone, a shift's sales on its opening day).
  const [dateFrom, setDateFrom] = useState(() => localDay())
  const [dateTo, setDateTo] = useState(() => localDay())
  const [fStatus, setFStatus] = useState('')
  const [fPay, setFPay] = useState('')

  // Only the lightweight lookups live here; each tab fetches its own data while active.
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const aq = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 60000)
  const payOptions = paymentFilterOptions(aq.data?.paymentMethods)
  const outlets = ouq.data ?? []

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Laporan"
        subtitle="Ekspor data untuk analisis lebih lanjut"
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
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
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-auto"
        />
        <Input
          type="date"
          label="Sampai"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-auto"
        />
        {tab === 'export' && (
          <>
            <Select
              label="Status"
              value={fStatus}
              onChange={(e) => setFStatus(e.target.value)}
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
              onChange={(e) => setFPay(e.target.value)}
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
        // Remount on a filter change so paging restarts at page 1.
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
