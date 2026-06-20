import { useMemo, useState } from 'react'
import type { Transfer, TransferReceiveInput } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { api } from '../../api'
import { Button } from '../../ui/Button'
import { Textarea, fieldClass } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

const lineKey = (productId: string, variantSize: string) => `${productId}|${variantSize}`

interface ReceiveModalProps {
  transfer: Transfer
  onClose: () => void
  onDone: () => void | Promise<void>
}

/** Receive an in-transit transfer: actual qty per line (defaults to sent). A
 *  discrepancy reason becomes required once any line differs from its sent qty. */
export function ReceiveModal({ transfer, onClose, onDone }: ReceiveModalProps) {
  const [actual, setActual] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      transfer.items.map((it) => [lineKey(it.productId, it.variantSize), String(it.sentQty)]),
    ),
  )
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const anyDiff = useMemo(
    () =>
      transfer.items.some((it) => {
        const v = actual[lineKey(it.productId, it.variantSize)]
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
      const v = actual[lineKey(it.productId, it.variantSize)]
      const n = Number(v ?? it.sentQty)
      return {
        productId: it.productId,
        variantSize: it.variantSize,
        receivedQty: Number.isFinite(n) && n >= 0 ? n : 0,
      }
    })
    setBusy(true)
    setErr(null)
    try {
      const body: TransferReceiveInput = {
        items,
        discrepancyReason: reason.trim() || null,
      }
      await api.receiveTransfer(transfer.id, body)
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menerima transfer.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Terima Transfer"
      subtitle={`${transfer.transferNo} · ${transfer.source.name} → ${transfer.dest.name}`}
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
        {transfer.dest.kind === 'outlet' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
            Penerimaan paksa (override) — tanpa hitung di POS. Gunakan hanya jika perangkat POS tujuan bermasalah.
          </div>
        )}
        <div className="grid grid-cols-12 gap-2 px-1">
          <span className="col-span-5 text-[11px] font-bold text-gray-400">Produk</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Ukuran</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Dikirim</span>
          <span className="col-span-3 text-[11px] font-bold text-gray-400">Diterima</span>
        </div>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {transfer.items.map((it) => {
            const key = lineKey(it.productId, it.variantSize)
            const got = Number(actual[key] ?? it.sentQty)
            const diff = got - it.sentQty
            return (
              <div key={key} className="grid grid-cols-12 gap-2 items-center">
                <span className="col-span-5 text-xs text-gray-600 truncate">{it.productName}</span>
                <span className="col-span-2 text-xs text-gray-500">{variantLabel(it.variantSize)}</span>
                <span className="col-span-2 text-xs text-gray-500">{it.sentQty}</span>
                <div className="col-span-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={actual[key] ?? ''}
                    aria-label={`Qty diterima ${it.productName} ${variantLabel(it.variantSize)}`}
                    onChange={(e) => setActual((m) => ({ ...m, [key]: e.target.value }))}
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
