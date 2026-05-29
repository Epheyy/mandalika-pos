import { useState } from 'react'
import type { WarehouseStockRow } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Input } from '../../ui'

interface AdjustModalProps {
  location: { kind: 'outlet' | 'warehouse'; id: string; name: string }
  /** The stock row being corrected. The modal is shown while this is set. */
  row: WarehouseStockRow
  onClose: () => void
  /** Called after a successful adjust so the parent can refetch stock. */
  onDone: () => void | Promise<void>
}

/** Koreksi Stok: sets an absolute new on-hand qty (not additive) and requires a
 *  reason. Mounted only while a row is selected so its form starts fresh. */
export function AdjustModal({ location, row, onClose, onDone }: AdjustModalProps) {
  const [newQty, setNewQty] = useState(String(row.stock))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const qty = Number(newQty)
  const valid = newQty.trim() !== '' && !Number.isNaN(qty) && qty >= 0 && !!reason.trim()

  const submit = async () => {
    if (newQty.trim() === '' || Number.isNaN(qty) || qty < 0) {
      setErr('Jumlah baru wajib diisi (≥ 0).')
      return
    }
    if (!reason.trim()) {
      setErr('Alasan koreksi wajib diisi.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await api.adjustLocationStock({ kind: location.kind, id: location.id }, {
        productId: row.productId,
        variantSize: row.variantSize,
        newQty: qty,
        reason: reason.trim(),
      })
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal koreksi stok.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Koreksi Stok"
      subtitle={`${row.productName} · ${row.variantSize}`}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy} disabled={!valid}>
            {busy ? 'Menyimpan...' : 'Simpan Koreksi'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Stok Saat Ini" type="number" value={String(row.stock)} readOnly disabled />
        <Input
          label="Jumlah Baru *"
          type="number"
          min={0}
          value={newQty}
          onChange={(e) => setNewQty(e.target.value)}
          placeholder="0"
        />
        <Input
          label="Alasan *"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="mis. opname, rusak, koreksi"
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
