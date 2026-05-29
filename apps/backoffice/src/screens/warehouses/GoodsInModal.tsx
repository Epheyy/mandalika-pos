import { useState } from 'react'
import type { WarehouseStockRow, GoodsReceiptInput } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Input, fieldClass } from '../../ui'

// One editable goods-in line, keyed by `${productId}|${variantSize}`.
type GoodsLine = { qty: string; unitCost: string }
const lineKey = (productId: string, variantSize: string) => `${productId}|${variantSize}`

interface GoodsInModalProps {
  open: boolean
  location: { kind: 'outlet' | 'warehouse'; id: string; name: string }
  rows: WarehouseStockRow[]
  onClose: () => void
  /** Called after a successful goods receipt so the parent can refetch stock. */
  onDone: () => void | Promise<void>
}

/** Goods-in (Barang Masuk): additive receipt of one or more variants. Only
 *  lines with qty > 0 are submitted; unit cost is optional/informational. */
export function GoodsInModal({ open, location, rows, onClose, onDone }: GoodsInModalProps) {
  const [supplier, setSupplier] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<Record<string, GoodsLine>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const setLine = (key: string, patch: Partial<GoodsLine>) =>
    setLines((m) => {
      const prev: GoodsLine = m[key] ?? { qty: '', unitCost: '' }
      return { ...m, [key]: { ...prev, ...patch } }
    })

  const submit = async () => {
    const items = rows
      .map((r) => {
        const l = lines[lineKey(r.productId, r.variantSize)]
        const qty = Number(l?.qty ?? '')
        if (!qty || qty <= 0) return null
        const cost = l?.unitCost?.trim() ? Number(l.unitCost) : null
        return { productId: r.productId, variantSize: r.variantSize, qty, unitCost: cost }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (items.length === 0) {
      setErr('Isi jumlah (qty) minimal satu baris.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body: GoodsReceiptInput = {
        supplier: supplier.trim() || null,
        note: note.trim() || null,
        items,
      }
      await api.createLocationGoodsReceipt({ kind: location.kind, id: location.id }, body)
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal mencatat barang masuk.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Barang Masuk"
      subtitle={location.name}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy}>
            {busy ? 'Menyimpan...' : 'Catat Barang Masuk'}
          </Button>
        </>
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

        {rows.length === 0 ? (
          <p className="text-sm text-gray-400 py-3">
            Belum ada varian di gudang ini. Tambahkan produk lebih dulu.
          </p>
        ) : (
          <div>
            <div className="grid grid-cols-12 gap-2 px-1 mb-1">
              <span className="col-span-5 text-[11px] font-bold text-gray-400">Produk</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Ukuran</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Qty Masuk</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Harga Beli</span>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {rows.map((r) => {
                const key = lineKey(r.productId, r.variantSize)
                const l = lines[key]
                return (
                  <div key={key} className="grid grid-cols-12 gap-2 items-center">
                    <span className="col-span-5 text-xs text-gray-600 truncate">
                      {r.productName}
                    </span>
                    <span className="col-span-2 text-xs text-gray-500">{r.variantSize}</span>
                    <input
                      type="number"
                      min={0}
                      value={l?.qty ?? ''}
                      onChange={(e) => setLine(key, { qty: e.target.value })}
                      placeholder="0"
                      className={`${fieldClass} col-span-2 py-1.5`}
                    />
                    <input
                      type="number"
                      min={0}
                      value={l?.unitCost ?? ''}
                      onChange={(e) => setLine(key, { unitCost: e.target.value })}
                      placeholder="—"
                      className={`${fieldClass} col-span-3 py-1.5`}
                    />
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Hanya baris dengan qty &gt; 0 yang dicatat. Harga beli opsional (informasi).
            </p>
          </div>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
