import type { MovementLedgerSummaryResponse, MovementLedgerSummaryRow } from '@mandalika/api'
import { BarChart2 } from 'lucide-react'
import { api } from '../../api'
import { downloadCsvText } from '../../lib/csvUtils'
import { navigate } from '../../lib/router/navigate'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ExportButton } from '../../ui/ExportButton'
import { FilterBar } from '../../ui/FilterBar'
import { Pagination } from '../../ui/Pagination'
import { StatusBadge } from '../../ui/StatusBadge'
import { BUCKET_COLUMNS, bucketsDiff, formatSigned } from './pergerakanBuckets'
import { kartuStokHash } from './kartuStokUrl'
import { daysAgoDay } from './stockCardFormat'
import { localDay } from '../../lib/businessDay'
import { useLocationParam } from './useLocationParam'

// The ledger summary scans a location's history: refresh it slowly (the inputs refetch at once).
const SUMMARY_REFRESH_MS = 60_000
const DEFAULT_PAGE_SIZE = 25

/** `#/inventori/stok/pergerakan?lokasi=&dari=&sampai=&q=&hal=&per=`. Empty `lokasi`/`dari`/`sampai` are the defaults
 *  (first location, last 30 days to today), so they stay out of the URL until the user changes them. */
const SCHEMA: ListSchema<{ lokasi: string; dari: string; sampai: string; q: string; hal: number; per: number }> = {
  lokasi: { key: 'lokasi', default: '' },
  dari: { key: 'dari', default: '' },
  sampai: { key: 'sampai', default: '' },
  q: { key: 'q', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: DEFAULT_PAGE_SIZE },
}

const rowKey = (r: MovementLedgerSummaryRow) => `${r.productId}|${r.variantSize}`
const skuName = (r: MovementLedgerSummaryRow) => `${r.productName} · ${r.variantSize}${r.sku ? ` (${r.sku})` : ''}`

/** Ringkasan pergerakan per SKU, built on the stock ledger (saldo awal, masuk, keluar, saldo akhir). */
export function MovementSummary() {
  const [state, setState] = useListState(SCHEMA)
  const loc = useLocationParam(state.lokasi)
  const fromDay = state.dari || daysAgoDay(30)
  const toDay = state.sampai || localDay()
  const page = Math.max(1, state.hal)
  const pageSize = state.per

  const where = loc.location
  const q = usePolledQuery<MovementLedgerSummaryResponse>(
    () =>
      where
        ? api.getMovementLedgerSummary({
            locationType: where.type,
            locationId: where.id,
            from: fromDay,
            to: toDay,
            q: state.q.trim() || undefined,
            page,
            limit: pageSize,
          })
        : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: pageSize } }),
    [where?.type, where?.id, fromDay, toDay, state.q, page, pageSize],
    SUMMARY_REFRESH_MS,
  )

  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const exportCsv = async () => {
    if (!where) return
    const text = await api.exportMovementLedgerSummary({
      locationType: where.type,
      locationId: where.id,
      from: fromDay,
      to: toDay,
      q: state.q.trim() || undefined,
    })
    downloadCsvText(text, `pergerakan-stok_${fromDay}_${toDay}.csv`)
  }

  const open = (r: MovementLedgerSummaryRow) =>
    void navigate(
      kartuStokHash({
        sku: { productId: r.productId, variantSize: r.variantSize },
        locationKey: loc.locationKey,
        fromDay,
        toDay,
        label: skuName(r),
      }),
    )

  const columns: Column<MovementLedgerSummaryRow>[] = [
    { id: 'produk', header: 'Produk', cell: (r) => <span className="font-bold">{r.productName}</span> },
    { id: 'ukuran', header: 'Ukuran', cell: (r) => r.variantSize },
    { id: 'sku', header: 'SKU', cell: (r) => <span className="font-mono">{r.sku || '—'}</span> },
    { id: 'awal', header: 'Saldo Awal', align: 'right', cell: (r) => r.opening },
    ...BUCKET_COLUMNS.map(
      (c): Column<MovementLedgerSummaryRow> => ({
        id: c.key,
        header: c.label,
        align: 'right',
        cell: (r) => (
          <span
            className={r.buckets[c.key] < 0 ? 'text-danger' : r.buckets[c.key] > 0 ? 'text-ok' : 'text-ink-500'}
            title={c.key === 'masuk' && r.masukGaransi !== 0 ? `${c.hint}. Di antaranya Garansi: ${r.masukGaransi}` : c.hint}
          >
            {formatSigned(r.buckets[c.key])}
          </span>
        ),
      }),
    ),
    { id: 'akhir', header: 'Saldo Akhir', align: 'right', cell: (r) => <span className="font-black">{r.closing}</span> },
    {
      id: 'cek',
      header: 'Cek saldo',
      cell: (r) => {
        const diff = bucketsDiff(r)
        return diff === 0 ? (
          <StatusBadge tone="ok" label="Sesuai" hint="Saldo Awal + kolom pergerakan = Saldo Akhir" />
        ) : (
          <StatusBadge tone="danger" label={`Selisih ${formatSigned(diff)} unit`} hint="Saldo Awal + kolom pergerakan tidak sama dengan Saldo Akhir" />
        )
      },
    },
  ]

  const activeCount = [state.lokasi, state.dari, state.sampai, state.q].filter((v) => v !== '').length

  return (
    <div className="space-y-4">
      <FilterBar
        onReset={() => setState({ lokasi: '', dari: '', sampai: '', q: '', hal: 1 })}
        activeCount={activeCount}
        actions={
          <ExportButton
            rowCount={q.data ? total : null}
            filterSummary={[`Rentang ${fromDay} s/d ${toDay}`, ...(state.q.trim() ? [`Cari "${state.q.trim()}"`] : [])]}
            disabled={!where}
            onExport={exportCsv}
          />
        }
      >
        <FilterBar.Select
          label="Lokasi"
          value={loc.locationKey}
          onChange={(key) => setState({ lokasi: key, hal: 1 })}
          options={[
            { value: '', label: 'Pilih lokasi...' },
            ...loc.outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
            ...loc.warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
          ]}
        />
        <FilterBar.DateRange
          from={fromDay}
          to={toDay}
          presets={['hari-ini', '7-hari', '30-hari', 'bulan-ini']}
          onChange={(r) => {
            if (r.from && r.to) setState({ dari: r.from, sampai: r.to, hal: 1 })
          }}
        />
        <FilterBar.Search
          label="Cari produk, SKU, atau barcode"
          placeholder="Nama, SKU, atau barcode"
          value={state.q}
          onChange={(v) => setState({ q: v, hal: 1 }, { replace: true })}
        />
      </FilterBar>

      <p className="text-xs text-ink-700">
        Rentang tanggal mengikuti waktu tercatat, bukan waktu kejadian. Penjualan offline yang baru tersinkron tercatat di hari sinkronnya.
      </p>

      <dl aria-label="Arti kolom pergerakan" className="grid gap-x-6 gap-y-2 rounded-2xl bg-paper-1 p-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {BUCKET_COLUMNS.map((c) => (
          <div key={c.key}>
            <dt className="font-black text-ink-700">{c.label}</dt>
            <dd className="text-ink-700">{c.hint}</dd>
          </div>
        ))}
        <div>
          <dt className="font-black text-ink-700">Cek saldo</dt>
          <dd className="text-ink-700">Saldo Awal ditambah keenam kolom harus sama dengan Saldo Akhir.</dd>
        </div>
      </dl>

      <DataTable
        caption="Pergerakan stok per SKU"
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        loading={q.loading && rows.length === 0}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<BarChart2 />} title="Tidak ada pergerakan stok dalam rentang waktu ini" />}
        onRowClick={open}
        footer={
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onChange={(p) => setState({ hal: p })}
            pageSize={pageSize}
            onPageSizeChange={(s) => setState({ per: s, hal: 1 })}
          />
        }
      />
    </div>
  )
}
