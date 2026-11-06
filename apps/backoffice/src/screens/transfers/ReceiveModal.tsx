import { useMemo, useState } from 'react'
import type { Transfer, TransferReceiveInput } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { api } from '../../api'
import { Button } from '../../ui/Button'
import { Textarea, fieldClass } from '../../ui/Field'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { SlideOver } from '../../ui/SlideOver'
import { useToast } from '../../ui/Toast'

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
  const [confirming, setConfirming] = useState(false)
  const toast = useToast()
  // An outlet destination is received here without counting on the POS: a forced receipt (D-107).
  const forced = transfer.dest.kind === 'outlet'

  const anyDiff = useMemo(
    () =>
      transfer.items.some((it) => {
        const v = actual[lineKey(it.productId, it.variantSize)]
        return Number(v ?? it.sentQty) !== it.sentQty
      }),
    [actual, transfer.items],
  )

  const submit = () => {
    if (anyDiff && !reason.trim()) {
      setErr('Alasan selisih wajib diisi.')
      return
    }
    setErr(null)
    if (forced) setConfirming(true)
    else void write()
  }

  const write = async () => {
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
      setConfirming(false)
      toast({ message: `${transfer.transferNo} diterima`, tone: 'ok' })
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menerima transfer.')
    } finally {
      setBusy(false)
    }
  }

  const totalReceived = transfer.items.reduce((n, it) => {
    const v = Number(actual[lineKey(it.productId, it.variantSize)] ?? it.sentQty)
    return n + (Number.isFinite(v) && v >= 0 ? v : 0)
  }, 0)
  const totalSent = transfer.items.reduce((n, it) => n + it.sentQty, 0)

  return (
    <SlideOver
      open
      onClose={busy ? () => {} : onClose}
      width="lg"
      title={forced ? 'Terima Paksa' : 'Terima Transfer'}
      subtitle={`${transfer.transferNo} · ${transfer.source.name} → ${transfer.dest.name}`}
      footer={
        <SlideOver.Footer>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button variant={forced ? 'secondary' : 'primary'} onClick={submit} loading={busy}>
            {busy ? 'Menyimpan...' : 'Konfirmasi Terima'}
          </Button>
        </SlideOver.Footer>
      }
    >
      <div className="space-y-4">
        {transfer.dest.kind === 'outlet' && (
          <div className="rounded-xl border border-warn/30 bg-warn-bg p-3 text-xs text-warn-strong">
            Penerimaan paksa (override) — tanpa hitung di POS. Gunakan hanya jika perangkat POS tujuan bermasalah.
          </div>
        )}
        <div className="grid grid-cols-12 gap-2 px-1">
          <span className="col-span-5 text-[11px] font-bold text-gray-400">Produk</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Ukuran</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Dikirim</span>
          <span className="col-span-3 text-[11px] font-bold text-gray-400">Diterima</span>
        </div>
        <div className="space-y-2">
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
                    <span className={`text-[11px] font-bold ${diff < 0 ? 'text-danger' : 'text-warn-strong'}`}>
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
        {err && !confirming && <p role="alert" className="text-sm text-danger">{err}</p>}
      </div>
      <ConfirmDialog
        open={confirming}
        title={`Terima paksa ${transfer.transferNo}?`}
        consequence={`Stok ${totalReceived} unit (dikirim ${totalSent}) masuk ke ${transfer.dest.name} sekarang, tanpa hitung di POS.`}
        confirmLabel="Terima paksa"
        busy={busy}
        error={err}
        onConfirm={() => void write()}
        onCancel={() => setConfirming(false)}
      />
    </SlideOver>
  )
}
