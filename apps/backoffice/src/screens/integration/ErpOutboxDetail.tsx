import { useRef, useState } from 'react'
import { ApiError, type ErpOutboxItem } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { ERP_STATUS } from '../../lib/labels/erp'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Modal } from '../../ui/Modal'
import { Button } from '../../ui/Button'
import { StatusBadge } from '../../ui/StatusBadge'
import { canRetry, humanReason, kindLabel, locationText, refText, retryConsequence, showsNextAttempt } from './erpOutboxFormat'
import { fmtTime } from './fmtTime'

interface Props {
  item: ErpOutboxItem | null
  onClose: () => void
  onChanged: () => void
}

export function ErpOutboxDetail({ item, onClose, onChanged }: Props) {
  if (!item) return null
  return <DetailView item={item} onClose={onClose} onChanged={onChanged} />
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-black text-ink-500 uppercase tracking-wider">{label}</p>
      <p className="text-ink-900 font-semibold break-words text-xs">{value}</p>
    </div>
  )
}

function Json({ title, value }: { title: string; value: unknown }) {
  if (value == null) return null
  return (
    <div>
      <p className="text-xs font-black text-ink-500 uppercase tracking-widest mb-2">{title}</p>
      <pre className="text-[11px] bg-ink-900 text-paper-0 rounded-xl p-3 overflow-auto max-h-64">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function retryError(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return 'Dokumen sedang antre atau dikirim'
  return e instanceof Error ? e.message : 'Gagal mengirim ulang'
}

function DetailView({ item, onClose, onChanged }: { item: ErpOutboxItem; onClose: () => void; onChanged: () => void }) {
  const q = usePolledQuery(() => api.getErpOutbox(item.id), [item.id], 30000)
  const d = q.data ?? item
  // The ref is set before the await: a fast double click on the confirm must not queue a second retry.
  const inFlight = useRef(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const confirmRetry = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await api.retryErpOutbox(item.id)
      setAsking(false)
      setMsg('Dokumen dijadwalkan ulang.')
      await q.refetch()
      onChanged()
    } catch (e: unknown) {
      setError(retryError(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="2xl"
        title={`${kindLabel(item.kind)} · ${refText(item)}`}
        subtitle={`Dokumen ${item.documentId}`}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3"><StatusBadge map={ERP_STATUS} value={d.status} /></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Lokasi" value={locationText(d)} />
            <Field label="Dibuat" value={fmtTime(d.createdAt)} />
            <Field label="Diperbarui" value={fmtTime(d.updatedAt)} />
            <Field label="Percobaan berikut" value={showsNextAttempt(d.status) ? fmtTime(d.nextAttemptAt) : '—'} />
            <Field label="Terkirim" value={fmtTime(d.deliveredAt)} />
            <Field label="Percobaan" value={String(d.attempts)} />
            <Field label="HTTP terakhir" value={d.lastHttpStatus != null ? String(d.lastHttpStatus) : '—'} />
          </div>
          {humanReason(d) && <p className="text-sm font-bold text-ink-900">{humanReason(d)}</p>}
          <details className="text-xs">
            <summary className="cursor-pointer font-bold text-ink-700">Detail teknis</summary>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Alasan ditahan" value={d.holdReason || '—'} />
              <Field label="Error terakhir" value={d.lastError || '—'} />
            </div>
          </details>
          {q.error && <p role="alert" className="text-xs text-danger">{q.error}</p>}
          <Json title="Payload" value={q.data?.payload} />
          <Json title="Respons ERP" value={q.data?.erpResponse} />
          {canRetry(d.status) && (
            <div>
              <Button onClick={() => { setError(null); setAsking(true) }}>Kirim ulang</Button>
            </div>
          )}
          {msg && <p role="status" className="text-xs font-semibold text-ink-700">{msg}</p>}
        </div>
      </Modal>
      <ConfirmDialog
        open={asking}
        title={`Kirim ulang ${refText(item)}?`}
        consequence={retryConsequence(d)}
        confirmLabel="Kirim ulang"
        busy={busy}
        error={error}
        onConfirm={confirmRetry}
        onCancel={() => { if (!inFlight.current) setAsking(false) }}
      />
    </>
  )
}
