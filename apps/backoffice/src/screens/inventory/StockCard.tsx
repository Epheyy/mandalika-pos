import { useCallback, useEffect, useRef, useState } from 'react'
import type { MovementSku, StockMovementPage, StockMovementParams, StockMovementRow } from '@mandalika/api'
import { Download, Search, X } from 'lucide-react'
import { api } from '../../api'
import { localDay } from '../../lib/businessDay'
import { downloadCsvText } from '../../lib/csvUtils'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Select, fieldClass } from '../../ui/Field'
import { MOVEMENT_KIND_LABEL, MOVEMENT_KINDS, formatMovementTime, daysAgoDay, isRecordedLate, type MovementKind } from './stockCardFormat'
import { useLocations, type LocationType } from './useLocations'

/** A SKU picked elsewhere (the summary tab) to open straight on its kartu stok. */
export interface StockCardTarget {
  locationKey: string
  productId: string
  variantSize: string
  label: string
  fromDay: string
  toDay: string
}

interface PickedSku {
  productId: string
  variantSize: string
  label: string
}

interface StockCardProps {
  target: StockCardTarget | null
}

const PAGE = 50

function skuLabel(r: Pick<MovementSku, 'productName' | 'variantSize' | 'sku'>): string {
  return `${r.productName} · ${r.variantSize}${r.sku ? ` (${r.sku})` : ''}`
}

export function StockCard({ target }: StockCardProps) {
  const loc = useLocations(target?.locationKey ?? '')
  const [sku, setSku] = useState<PickedSku | null>(
    target ? { productId: target.productId, variantSize: target.variantSize, label: target.label } : null,
  )
  const [fromDay, setFromDay] = useState(target?.fromDay ?? daysAgoDay(30))
  const [toDay, setToDay] = useState(target?.toDay ?? localDay())
  const [kinds, setKinds] = useState<ReadonlySet<MovementKind>>(new Set())
  const [onlyGiveaway, setOnlyGiveaway] = useState(false)
  const [onlyShortage, setOnlyShortage] = useState(false)

  const [rows, setRows] = useState<StockMovementRow[]>([])
  const [summary, setSummary] = useState<StockMovementPage['summary']>(undefined)
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const generation = useRef(0)

  const params = useCallback((): StockMovementParams | null => {
    if (!loc.location) return null
    return {
      locationType: loc.location.type,
      locationId: loc.location.id,
      productId: sku?.productId,
      variantSize: sku?.variantSize,
      kind: kinds.size ? [...kinds] : undefined,
      flag: onlyShortage ? 'shortage' : undefined,
      giveaway: onlyGiveaway ? true : undefined,
      from: fromDay,
      to: toDay,
    }
  }, [loc.location, sku, kinds, onlyShortage, onlyGiveaway, fromDay, toDay])

  const load = useCallback(
    async (cursor?: string) => {
      const base = params()
      if (!base) return
      const mine = ++generation.current
      setLoading(true)
      setError(null)
      try {
        const page = await api.listStockMovements({ ...base, limit: PAGE, cursor })
        if (mine !== generation.current) return
        setRows((prev) => (cursor ? [...prev, ...page.data] : page.data))
        setNextCursor(page.nextCursor)
        if (!cursor) setSummary(page.summary)
      } catch (e) {
        if (mine === generation.current) setError(e instanceof Error ? e.message : 'Gagal memuat kartu stok')
      } finally {
        if (mine === generation.current) setLoading(false)
      }
    },
    [params],
  )

  useEffect(() => {
    void load()
  }, [load])

  const exportCsv = async () => {
    const base = params()
    if (!base) return
    setExporting(true)
    try {
      const text = await api.exportStockMovements(base)
      downloadCsvText(text, `kartu-stok_${fromDay}_${toDay}.csv`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal mengunduh CSV')
    } finally {
      setExporting(false)
    }
  }

  const toggleKind = (k: MovementKind) =>
    setKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[220px]">
          <Select
            label="Lokasi"
            value={loc.locationKey}
            onChange={(e) => {
              loc.setLocationKey(e.target.value)
              setSku(null)
            }}
          >
            <option value="">Pilih lokasi...</option>
            <optgroup label="Outlet">
              {loc.outlets.map((o) => (
                <option key={o.id} value={`outlet:${o.id}`}>{o.name}</option>
              ))}
            </optgroup>
            <optgroup label="Gudang">
              {loc.warehouses.map((w) => (
                <option key={w.id} value={`warehouse:${w.id}`}>{w.name}</option>
              ))}
            </optgroup>
          </Select>
        </div>
        <SkuSearch locationType={loc.location?.type} locationId={loc.location?.id} picked={sku} onPick={setSku} />
        <DayInput id="kartu-from" label="Tanggal tercatat dari" value={fromDay} max={toDay} onChange={setFromDay} />
        <DayInput id="kartu-to" label="Tanggal tercatat sampai" value={toDay} min={fromDay} onChange={setToDay} />
        <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={exporting} onClick={exportCsv} disabled={!loc.location}>
          Unduh CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter jenis">
        {MOVEMENT_KINDS.map((k) => (
          <Chip key={k} active={kinds.has(k)} onClick={() => toggleKind(k)}>{MOVEMENT_KIND_LABEL[k]}</Chip>
        ))}
        <Chip active={onlyGiveaway} onClick={() => setOnlyGiveaway((v) => !v)}>Hadiah</Chip>
        <Chip active={onlyShortage} onClick={() => setOnlyShortage((v) => !v)}>Minus</Chip>
      </div>

      {sku && summary && <SaldoHeader label={sku.label} summary={summary} />}
      {!sku && loc.location && (
        <p className="text-xs text-gray-400">Pilih satu SKU untuk melihat saldo awal, total masuk/keluar, dan saldo akhir.</p>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          error ? null : <EmptyState icon={<Search />} title={loading ? 'Memuat…' : 'Tidak ada pergerakan stok untuk filter ini'} />
        ) : (
          <MovementTable rows={rows} zone={loc.zone} showProduct={!sku} />
        )}
      </Card>

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={loading} onClick={() => void load(nextCursor)}>Muat lebih banyak</Button>
        </div>
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
        active ? 'bg-gold-600 text-white border-gold-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  )
}

interface DayInputProps {
  id: string
  label: string
  value: string
  min?: string
  max?: string
  onChange: (v: string) => void
}

function DayInput({ id, label, value, min, max, onChange }: DayInputProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-bold text-gray-500 uppercase tracking-wider">{label}</label>
      <input id={id} type="date" value={value} min={min} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} className={fieldClass} />
    </div>
  )
}

function SaldoHeader({ label, summary }: { label: string; summary: NonNullable<StockMovementPage['summary']> }) {
  const cells: Array<[string, number]> = [
    ['Saldo Awal', summary.opening],
    ['Total Masuk', summary.totalIn],
    ['Total Keluar', summary.totalOut],
    ['Saldo Akhir', summary.closing],
  ]
  return (
    <Card className="p-4">
      <p className="text-sm font-bold text-gray-900 mb-3">{label}</p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cells.map(([name, value]) => (
          <div key={name}>
            <dt className="text-xs font-black text-gray-400 uppercase tracking-wider">{name}</dt>
            <dd className="text-xl font-black text-gray-900">{value.toLocaleString('id-ID')}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function MovementTable({ rows, zone, showProduct }: { rows: StockMovementRow[]; zone: string; showProduct: boolean }) {
  const heads = ['Waktu Kejadian', 'Waktu Tercatat', 'Jenis', ...(showProduct ? ['Produk'] : []), 'Dokumen', 'Masuk', 'Keluar', 'Saldo', 'Oleh', 'Alasan', 'Penyetuju', 'Tanda', 'ERP']
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            {heads.map((h) => (
              <th key={h} className="text-left px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((m) => (
            <MovementTableRow key={m.id} m={m} zone={zone} showProduct={showProduct} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MovementTableRow({ m, zone, showProduct }: { m: StockMovementRow; zone: string; showProduct: boolean }) {
  const cell = 'px-4 py-3 text-sm text-gray-700 whitespace-nowrap'
  return (
    <tr className="hover:bg-gray-50">
      <td className={cell}>{formatMovementTime(m.occurredAt, zone)}</td>
      <td className={`${cell} text-gray-400`}>{formatMovementTime(m.recordedAt, zone)}</td>
      <td className={cell}>{MOVEMENT_KIND_LABEL[m.kind]}</td>
      {showProduct && (
        <td className={cell}>{m.productName ?? '—'} · {m.variantSize}{m.sku ? ` (${m.sku})` : ''}</td>
      )}
      <td className={`${cell} font-mono`}>
        {m.refNumber ?? m.refType}
        {m.requisitionNumber && <span className="block text-xs text-gray-400">dari {m.requisitionNumber}</span>}
      </td>
      <td className={`${cell} text-green-700 font-bold`}>{m.qty > 0 ? m.qty : ''}</td>
      <td className={`${cell} text-red-600 font-bold`}>{m.qty < 0 ? -m.qty : ''}</td>
      <td className={`${cell} font-black text-gray-900`}>{m.qtyAfter}</td>
      <td className={cell}>{m.actorName ?? ''}</td>
      <td className={cell}>{m.reasonText ?? ''}</td>
      <td className={cell}>
        {m.approvedBy ? `Disetujui oleh ${m.approvedBy}` : ''}
        {m.docNumber && <span className="block font-mono text-xs text-gray-400">{m.docNumber}</span>}
      </td>
      <td className={cell}>
        <span className="flex gap-1">
          {m.isGiveaway && <Badge tone="gold">Hadiah</Badge>}
          {m.flags.includes('shortage') && <Badge tone="danger">Minus</Badge>}
          {isRecordedLate(m.occurredAt, m.recordedAt, zone) && <Badge tone="warning">Tercatat terlambat</Badge>}
        </span>
      </td>
      <td className={cell}>{m.erpStatus ?? ''}</td>
    </tr>
  )
}

interface SkuSearchProps {
  locationType: LocationType | undefined
  locationId: string | undefined
  picked: PickedSku | null
  onPick: (s: PickedSku | null) => void
}

/** Search by SKU, barcode or name over the SKUs that have ledger history at the location. */
function SkuSearch({ locationType, locationId, picked, onPick }: SkuSearchProps) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<MovementSku[]>([])

  useEffect(() => {
    const q = text.trim()
    if (!locationType || !locationId || q.length < 2) {
      setResults([])
      return
    }
    let stale = false
    const t = setTimeout(() => {
      api
        .listMovementSkus({ locationType, locationId, q })
        .then((r) => !stale && setResults(r.data))
        .catch(() => !stale && setResults([]))
    }, 300)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [text, locationType, locationId])

  if (picked) {
    return (
      <div className="flex flex-col gap-1 min-w-[260px]">
        <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">SKU</span>
        <div className={`${fieldClass} flex items-center justify-between gap-2`}>
          <span className="truncate">{picked.label}</span>
          <button type="button" aria-label="Hapus pilihan SKU" onClick={() => onPick(null)} className="text-gray-400 hover:text-gray-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="relative flex flex-col gap-1 min-w-[260px]">
      <label htmlFor="kartu-sku" className="text-xs font-bold text-gray-500 uppercase tracking-wider">SKU / barcode / nama</label>
      <input id="kartu-sku" value={text} onChange={(e) => setText(e.target.value)} placeholder="Semua SKU — ketik untuk memilih" className={fieldClass} />
      {results.length > 0 && (
        <ul className="absolute top-full z-10 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg max-h-64 overflow-auto">
          {results.map((r) => (
            <li key={`${r.productId}|${r.variantSize}`}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                onClick={() => {
                  onPick({ productId: r.productId, variantSize: r.variantSize, label: skuLabel(r) })
                  setText('')
                  setResults([])
                }}
              >
                {skuLabel(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
