import { useEffect, useMemo, useState } from 'react'
import type {
  Outlet,
  Warehouse,
  WarehouseStockRow,
  TransferCreateInput,
} from '@mandalika/api'
import { ArrowLeft, Save } from 'lucide-react'
import { api } from '../../api'
import { Button, Card, Select, Textarea, PageHeader, fieldClass } from '../../ui'

type LocKind = 'outlet' | 'warehouse'
interface LocPick {
  kind: LocKind
  id: string
}
const lineKey = (productId: string, variantSize: string) => `${productId}|${variantSize}`

interface TransferFormProps {
  outlets: Outlet[]
  warehouses: Warehouse[]
  onCancel: () => void
  /** Called with the new transfer id after a successful create. */
  onCreated: (id: string) => void
}

/** Create a draft transfer: pick source + dest (mesh), then qty per source
 *  variant (live on-hand shown so you cannot over-send). */
export function TransferForm({ outlets, warehouses, onCancel, onCreated }: TransferFormProps) {
  const [source, setSource] = useState<LocPick | null>(null)
  const [dest, setDest] = useState<LocPick | null>(null)
  const [note, setNote] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [srcRows, setSrcRows] = useState<WarehouseStockRow[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Options as "kind:id" so a single <select> spans both warehouses + outlets.
  const options = useMemo(
    () => [
      ...warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
      ...outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
    ],
    [warehouses, outlets],
  )

  const parse = (v: string): LocPick | null => {
    if (!v) return null
    const idx = v.indexOf(':')
    return { kind: v.slice(0, idx) as LocKind, id: v.slice(idx + 1) }
  }

  // Load source on-hand whenever the source changes.
  useEffect(() => {
    if (!source) {
      setSrcRows([])
      return
    }
    let alive = true
    api
      .getTransferLocationStock(source.kind, source.id)
      .then((rows) => alive && setSrcRows(rows))
      .catch(() => alive && setSrcRows([]))
    return () => {
      alive = false
    }
  }, [source])

  const onHand = (r: WarehouseStockRow) => r.stock

  const submit = async () => {
    if (!source || !dest) {
      setErr('Pilih sumber dan tujuan.')
      return
    }
    if (source.kind === dest.kind && source.id === dest.id) {
      setErr('Sumber dan tujuan tidak boleh sama.')
      return
    }
    const items = srcRows
      .map((r) => {
        const n = Number(qty[lineKey(r.productId, r.variantSize)] ?? '')
        if (!n || n <= 0) return null
        return { productId: r.productId, variantSize: r.variantSize, qty: n }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (items.length === 0) {
      setErr('Isi qty minimal satu baris.')
      return
    }
    const over = items.find((it) => {
      const row = srcRows.find(
        (r) => r.productId === it.productId && r.variantSize === it.variantSize,
      )
      return row ? it.qty > row.stock : false
    })
    if (over) {
      setErr('Qty melebihi stok sumber.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body: TransferCreateInput = { source, dest, note: note.trim() || null, items }
      const { id } = await api.createTransfer(body)
      onCreated(id)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal membuat transfer.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Transfer Baru"
        subtitle="Pindahkan stok antar gudang / outlet"
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onCancel}>
              Kembali
            </Button>
            <Button icon={<Save className="w-4 h-4" />} onClick={submit} loading={busy}>
              {busy ? 'Menyimpan...' : 'Simpan Draft'}
            </Button>
          </>
        }
      />

      <Card className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Sumber"
            value={source ? `${source.kind}:${source.id}` : ''}
            onChange={(e) => setSource(parse(e.target.value))}
          >
            <option value="">Pilih sumber…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select
            label="Tujuan"
            value={dest ? `${dest.kind}:${dest.id}` : ''}
            onChange={(e) => setDest(parse(e.target.value))}
          >
            <option value="">Pilih tujuan…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <Textarea
          label="Catatan"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Opsional"
        />
      </Card>

      <Card className="p-5">
        {!source ? (
          <p className="text-sm text-gray-400">Pilih sumber untuk melihat stok.</p>
        ) : srcRows.length === 0 ? (
          <p className="text-sm text-gray-400">Tidak ada stok di sumber ini.</p>
        ) : (
          <div>
            <div className="grid grid-cols-12 gap-2 px-1 mb-2">
              <span className="col-span-5 text-[11px] font-bold text-gray-400">Produk</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Ukuran</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Stok</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Qty Kirim</span>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {srcRows.map((r) => {
                const key = lineKey(r.productId, r.variantSize)
                return (
                  <div key={key} className="grid grid-cols-12 gap-2 items-center">
                    <span className="col-span-5 text-xs text-gray-600 truncate">{r.productName}</span>
                    <span className="col-span-2 text-xs text-gray-500">{r.variantSize}</span>
                    <span className="col-span-2 text-xs text-gray-500">{onHand(r)}</span>
                    <input
                      type="number"
                      min={0}
                      max={r.stock}
                      value={qty[key] ?? ''}
                      onChange={(e) => setQty((m) => ({ ...m, [key]: e.target.value }))}
                      placeholder="0"
                      className={`${fieldClass} col-span-3 py-1.5`}
                    />
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Hanya baris dengan qty &gt; 0 yang dikirim. Qty tidak boleh melebihi stok.
            </p>
          </div>
        )}
        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      </Card>
    </div>
  )
}
