import { useMemo, useState } from 'react'
import type { IngredientTransfer, IngredientTransferReceiveInput } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Textarea, fieldClass } from '../../ui'

interface IngredientReceiveModalProps {
  transfer: IngredientTransfer
  onClose: () => void
  onDone: () => void | Promise<void>
}

/** Receive an in-transit ingredient transfer: actual qty per line (defaults to sent).
 *  A discrepancy reason becomes required once any line differs from its sent qty. */
export function IngredientReceiveModal({ transfer, onClose, onDone }: IngredientReceiveModalProps) {
  const [actual, setActual] = useState<Record<string, string>>(() =>
    Object.fromEntries(transfer.items.map((it) => [it.id, String(it.sentQty)])),
  )
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const anyDiff = useMemo(
    () =>
      transfer.items.some((it) => {
        const v = actual[it.id]
        return Number(v ?? it.sentQty) !== it.sentQty
      }),
    [actual, transfer.items],
  )

  const submit = async () => {
    if (anyDiff && !reason.trim()) {
      setErr('Alasan selisih wajib diisi.')
      return
    }
    const items = transfer.items.map((it) => {
      const v = actual[it.id]
      const n = Number(v ?? it.sentQty)
      return {
        itemId: it.id,
        receivedQty: Number.isFinite(n) && n >= 0 ? n : 0,
      }
    })
    setBusy(true)
    setErr(null)
    try {
      const body: IngredientTransferReceiveInput = {
        items,
        discrepancyReason: reason.trim() || null,
      }
      await api.receiveIngredientTransfer(transfer.id, body)
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menerima transfer.')
    } finally {
      setBusy(false)
    }
  }

  const sourceName = transfer.source.name ?? transfer.source.id
  const destName = transfer.dest.name ?? transfer.dest.id

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Terima Transfer Bahan"
      subtitle={`${transfer.transferNo} · ${sourceName} → ${destName}`}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy}>
            {busy ? 'Menyimpan...' : 'Konfirmasi Terima'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-12 gap-2 px-1">
          <span className="col-span-5 text-[11px] font-bold text-gray-400">Bahan</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Satuan</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Dikirim</span>
          <span className="col-span-3 text-[11px] font-bold text-gray-400">Diterima</span>
        </div>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {transfer.items.map((it) => {
            const got = Number(actual[it.id] ?? it.sentQty)
            const diff = got - it.sentQty
            return (
              <div key={it.id} className="grid grid-cols-12 gap-2 items-center">
                <span className="col-span-5 text-xs text-gray-600 truncate">{it.ingredientName}</span>
                <span className="col-span-2 text-xs text-gray-500">{it.ingredientUnit}</span>
                <span className="col-span-2 text-xs text-gray-500">{it.sentQty}</span>
                <div className="col-span-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={actual[it.id] ?? ''}
                    onChange={(e) => setActual((m) => ({ ...m, [it.id]: e.target.value }))}
                    className={`${fieldClass} py-1.5`}
                  />
                  {diff !== 0 && (
                    <span className={`text-[11px] font-bold ${diff < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {diff > 0 ? `+${diff}` : diff}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {anyDiff && (
          <Textarea
            label="Alasan Selisih *"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="mis. 2 unit rusak / hilang di perjalanan"
          />
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
