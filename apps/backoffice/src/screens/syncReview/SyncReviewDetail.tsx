import { useState } from 'react'
import type { SyncReviewItem } from '@mandalika/api'
import { api } from '../../api'
import { Modal } from '../../ui/Modal'
import { Button } from '../../ui/Button'
import { Badge } from '../../ui/Badge'
import { Textarea } from '../../ui/Field'
import { fmtWib, payloadSummary, reasonLabel, refundReviewLabel, typeLabel } from './reviewLabels'
import { SYNC_REVIEW_CHANGED } from './useSyncReviewCount'

const NOTE_MAX = 500

interface Props {
  item: SyncReviewItem | null
  onClose: () => void
  onResolved: () => void
}

export function SyncReviewDetail({ item, onClose, onResolved }: Props) {
  return (
    <Modal open={item !== null} onClose={onClose} size="lg"
      title={item ? `${typeLabel(item.type)} · ${item.outletName}` : ''}
      subtitle={item ? reasonLabel(item.reviewCode) : undefined}>
      {item && <DetailBody item={item} onResolved={onResolved} />}
    </Modal>
  )
}

function DetailBody({ item, onResolved }: { item: SyncReviewItem; onResolved: () => void }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const payload = (item.payload ?? {}) as Record<string, unknown>
  const trimmed = note.trim()

  const resolve = async () => {
    if (!trimmed || trimmed.length > NOTE_MAX) return
    setSaving(true)
    setError(null)
    try {
      await api.resolveSyncReviewItem(item.idempotencyKey, trimmed)
      window.dispatchEvent(new Event(SYNC_REVIEW_CHANGED))
      onResolved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyelesaikan item')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {item.appliedOnServer && <Badge tone="success">Sudah masuk ke server</Badge>}
      <dl className="grid grid-cols-2 gap-3 text-xs">
        {payloadSummary(item.type, payload).map(([k, v]) => (
          <div key={k}>
            <dt className="text-[10px] font-black text-gray-400 uppercase tracking-wider">{k}</dt>
            <dd className="text-gray-800 font-semibold break-words">{v}</dd>
          </div>
        ))}
        <div>
          <dt className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Dibuat (menurut tablet)</dt>
          <dd className="text-gray-800 font-semibold">{fmtWib(item.clientCreatedAt)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Kasir</dt>
          <dd className="text-gray-800 font-semibold">{item.ownerName ?? '—'}</dd>
        </div>
      </dl>
      <div className="text-xs text-gray-600 space-y-1">
        <p><span className="font-bold">Alasan server:</span> {refundReviewLabel(item.reviewReason) ?? item.reviewReason ?? '—'}</p>
        {item.lastError && item.lastError !== item.reviewReason && <p><span className="font-bold">Error terakhir:</span> {item.lastError}</p>}
      </div>
      <details>
        <summary className="text-xs font-bold text-gray-500 cursor-pointer">Data lengkap</summary>
        <pre className="mt-2 text-[11px] bg-gray-900 text-gray-100 rounded-xl p-3 overflow-x-auto max-h-64">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      </details>
      {item.resolvedAt ? (
        <p className="text-sm text-gray-700">
          Diselesaikan oleh <b>{item.resolvedByName ?? '—'}</b> · {fmtWib(item.resolvedAt)}<br />{item.resolutionNote}
        </p>
      ) : (
        <div className="space-y-2 border-t border-gray-100 pt-4">
          <Textarea label="Catatan penyelesaian" aria-label="Catatan penyelesaian" value={note} maxLength={NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            hint="Item akan dihapus dari tablet saat tablet terhubung berikutnya. Perbaikan (mis. refund manual) dilakukan terpisah."
            error={error ?? undefined} />
          <div className="flex justify-end">
            <Button onClick={() => void resolve()} disabled={!trimmed || saving}>Tandai selesai</Button>
          </div>
        </div>
      )}
    </div>
  )
}
