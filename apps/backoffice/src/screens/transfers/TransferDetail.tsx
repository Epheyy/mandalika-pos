import { useRef, useState } from 'react'
import type { Transfer } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { ArrowLeft, Send, Ban, PackageCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { newIdempotencyKey } from '../../lib/inventoryApproval'
import { TRANSFER_STATUS } from '../../lib/labels/transfer'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { ReceiveModal } from './ReceiveModal'
import { SuratJalanPanel } from './SuratJalanPanel'
import { isIdempotencyConflict, transferActionError, transferConfirmCopy, type TransferAction } from './transferAction'

interface TransferDetailProps {
  id: string
  onBack: () => void
}

export function TransferDetail({ id, onBack }: TransferDetailProps) {
  const q = usePolledQuery<Transfer>(() => api.getTransfer(id), [id])
  const t = q.data
  const [receiving, setReceiving] = useState(false)
  const [asking, setAsking] = useState<TransferAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  // One Idempotency-Key per dialog open: a retry inside the same dialog replays the write, a new open is a new action.
  const keyRef = useRef<string | null>(null)
  // Set synchronously so a fast double-click cannot start a second call before `busy` re-renders.
  const inFlight = useRef(false)

  const ask = (action: TransferAction) => {
    keyRef.current = newIdempotencyKey()
    setDialogError(null)
    setAsking(action)
  }
  const dismiss = () => {
    if (inFlight.current) return
    keyRef.current = null
    setAsking(null)
    setDialogError(null)
  }
  const confirm = async () => {
    const key = keyRef.current
    if (inFlight.current || !asking || !t || !key) return
    inFlight.current = true
    setBusy(true)
    setDialogError(null)
    try {
      if (asking === 'send') await api.sendTransfer(t.id, key)
      else await api.cancelTransfer(t.id, key)
      keyRef.current = null
      setAsking(null)
      await q.refetch()
    } catch (e: unknown) {
      setDialogError(transferActionError(e))
      // The write is already recorded: show the current state behind the dialog.
      if (isIdempotencyConflict(e)) void q.refetch()
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!t) {
    return (
      <div className="space-y-5">
        <PageHeader title="Transfer" actions={<Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>Kembali</Button>} />
        <Card className="p-8"><TableSkeleton /></Card>
      </div>
    )
  }
  const copy = asking ? transferConfirmCopy(asking, t) : null

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.transferNo}
        subtitle={`${t.source.name} → ${t.dest.name}`}
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>
              Kembali
            </Button>
            {t.status === 'draft' && (
              <Button icon={<Send className="w-4 h-4" />} onClick={() => ask('send')}>
                Kirim
              </Button>
            )}
            {t.status === 'in_transit' && (
              <Button icon={<PackageCheck className="w-4 h-4" />} onClick={() => setReceiving(true)}>
                Terima
              </Button>
            )}
            {(t.status === 'draft' || t.status === 'in_transit') && (
              <Button variant="danger" icon={<Ban className="w-4 h-4" />} onClick={() => ask('cancel')}>
                Batalkan
              </Button>
            )}
          </>
        }
      />

      {t.suratJalanNo && <SuratJalanPanel transfer={t} />}

      <Card className="p-5">
        <div className="flex items-center gap-3 mb-4">
          <StatusBadge map={TRANSFER_STATUS} value={t.status} />
          {t.note && <span className="text-sm text-gray-500">{t.note}</span>}
        </div>
        {t.discrepancyReason && (
          <p className="text-sm text-amber-700 mb-3">Selisih: {t.discrepancyReason}</p>
        )}
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Produk', 'Ukuran', 'Dikirim', 'Diterima', 'Selisih'].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {t.items.map((it) => (
              <tr key={`${it.productId}|${it.variantSize}`}>
                <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.productName}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{variantLabel(it.variantSize)}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.sentQty}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.receivedQty ?? '—'}</td>
                <td className="px-4 py-2 text-sm">
                  {it.difference == null ? (
                    '—'
                  ) : (
                    <span className={it.difference < 0 ? 'text-red-600' : it.difference > 0 ? 'text-green-600' : 'text-gray-400'}>
                      {it.difference > 0 ? `+${it.difference}` : it.difference}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {receiving && (
        <ReceiveModal
          transfer={t}
          onClose={() => setReceiving(false)}
          onDone={() => q.refetch()}
        />
      )}

      <ConfirmDialog
        open={copy !== null}
        title={copy?.title ?? ''}
        consequence={copy?.consequence ?? ''}
        confirmLabel={copy?.confirmLabel ?? ''}
        cancelLabel={copy?.cancelLabel}
        tone={copy?.tone}
        busy={busy}
        error={dialogError}
        onConfirm={() => void confirm()}
        onCancel={dismiss}
      />
    </div>
  )
}
