import { useRef, useState } from 'react'
import type { WarehouseStockRow, GoodsReceiptInput } from '@mandalika/api'
import { api } from '../../api'
import { newIdempotencyKey } from '../../lib/inventoryApproval'
import { Button } from '../../ui/Button'
import { Input, fieldClass } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { goodsLineErrors, goodsLineKey, goodsReceiptItems, stockWriteError, type GoodsLine } from './stockWrite'
import { useStockWriteGuard } from './useStockWriteGuard'

interface GoodsInSlideOverProps {
  open: boolean
  location: { kind: 'outlet' | 'warehouse'; id: string; name: string }
  rows: WarehouseStockRow[]
  onClose: () => void
  /** Called after a successful goods receipt so the parent can refetch stock. */
  onDone: () => void | Promise<void>
}

/** Barang Masuk: additive receipt of one or more variants. Only lines with qty > 0 are submitted; unit cost is
 *  optional/informational. The form is mounted only while open, so every open starts with empty lines and its own
 *  Idempotency-Key. */
export function GoodsInSlideOver({ open, ...rest }: GoodsInSlideOverProps) {
  if (!open) return null
  return <GoodsInForm {...rest} />
}

function GoodsInForm({ location, rows, onClose, onDone }: Omit<GoodsInSlideOverProps, 'open'>) {
  const [supplier, setSupplier] = useState('')
  const [note, setNote] = useState('')
  const [isWarranty, setIsWarranty] = useState(false)
  const [lines, setLines] = useState<Record<string, GoodsLine>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // One key for this open, never rotated: a retry (or a double click) of an attempt that may already have been
  // applied meets the server's claim and cannot add the stock twice. A new open mounts a new form and a new key.
  const [key] = useState(newIdempotencyKey)
  const inFlight = useRef(false)

  const setLine = (lineKey: string, patch: Partial<GoodsLine>) =>
    setLines((m) => {
      const prev: GoodsLine = m[lineKey] ?? { qty: '', unitCost: '' }
      return { ...m, [lineKey]: { ...prev, ...patch } }
    })

  const dirty =
    supplier !== '' || note !== '' || isWarranty || Object.values(lines).some((l) => l.qty !== '' || l.unitCost !== '')

  useStockWriteGuard(busy, dirty)
  const lineErrors = goodsLineErrors(rows, lines)

  const submit = async () => {
    if (inFlight.current) return
    if (Object.keys(lineErrors).length > 0) {
      setErr('Periksa isian yang bertanda merah.')
      return
    }
    const items = goodsReceiptItems(rows, lines)
    if (items.length === 0) {
      setErr('Isi jumlah (qty) minimal satu baris.')
      return
    }
    inFlight.current = true
    setBusy(true)
    setErr(null)
    try {
      const body: GoodsReceiptInput = {
        supplier: supplier.trim() || null,
        note: note.trim() || null,
        source: isWarranty ? 'warranty' : 'supply',
        items,
      }
      await api.createLocationGoodsReceipt({ kind: location.kind, id: location.id }, body, key)
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(stockWriteError(e, 'Gagal mencatat barang masuk.'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  // No closing mid-flight: a reopen would get a new key while this write may still land.
  const close = () => {
    if (!busy) onClose()
  }

  return (
    <SlideOver
      open
      onClose={close}
      width="lg"
      title="Barang Masuk"
      subtitle={location.name}
      dirty={dirty}
      footer={
        <SlideOver.Footer dirty={dirty}>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Batal
          </Button>
          <Button onClick={submit} loading={busy}>
            {busy ? 'Menyimpan...' : 'Simpan barang masuk'}
          </Button>
        </SlideOver.Footer>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Pemasok"
            type="text"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Opsional"
          />
          <Input
            label="Catatan"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Opsional"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isWarranty} onChange={(e) => setIsWarranty(e.target.checked)} />
          Penggantian garansi (dicatat sebagai Garansi di Pergerakan)
        </label>

        {rows.length === 0 ? (
          <p className="text-sm text-gray-400 py-3">
            Belum ada varian di lokasi ini. Tambahkan produk lebih dulu.
          </p>
        ) : (
          <div>
            <div className="grid grid-cols-12 gap-2 px-1 mb-1">
              <span className="col-span-5 text-[11px] font-bold text-gray-400">Produk</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Ukuran</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Qty Masuk</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Harga Beli</span>
            </div>
            <div className="space-y-2">
              {rows.map((r) => {
                const lineKey = goodsLineKey(r.productId, r.variantSize)
                const l = lines[lineKey]
                const le = lineErrors[lineKey]
                return (
                  <div key={lineKey} className="grid grid-cols-12 gap-2 items-center">
                    <span className="col-span-5 text-xs text-gray-600 truncate">{r.productName}</span>
                    <span className="col-span-2 text-xs text-gray-500">{r.variantSize}</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={l?.qty ?? ''}
                      aria-label={`Qty masuk ${r.productName} ${r.variantSize}`}
                      onChange={(e) => setLine(lineKey, { qty: e.target.value })}
                      placeholder="0"
                      className={`${fieldClass} col-span-2 py-1.5`}
                    />
                    <input
                      type="number"
                      min={0}
                      value={l?.unitCost ?? ''}
                      aria-label={`Harga beli ${r.productName} ${r.variantSize}`}
                      onChange={(e) => setLine(lineKey, { unitCost: e.target.value })}
                      placeholder="—"
                      className={`${fieldClass} col-span-3 py-1.5`}
                    />
                    {le && (
                      <p role="alert" className="col-span-12 text-[11px] text-red-600 -mt-1">
                        {[le.qty, le.unitCost].filter(Boolean).join(' ')}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Hanya baris dengan qty &gt; 0 yang dicatat. Harga beli opsional (informasi).
            </p>
          </div>
        )}

        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
      </div>
    </SlideOver>
  )
}
