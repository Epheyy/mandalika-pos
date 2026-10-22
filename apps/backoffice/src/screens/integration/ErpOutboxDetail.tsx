import { useState } from 'react'
import { ApiError, type ErpOutboxItem } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Modal } from '../../ui/Modal'
import { Button } from '../../ui/Button'
import { canRetry, kindLabel, refText, showsNextAttempt } from './erpOutboxFormat'
import { fmtTime } from './fmtTime'
import { StatusBadge } from './ErpOutboxTable'

interface Props {
  item: ErpOutboxItem | null
  onClose: () => void
  onChanged: () => void
}

export function ErpOutboxDetail({ item, onClose, onChanged }: Props) {
  return (
    <Modal open={item !== null} onClose={onClose} size="2xl"
      title={item ? `${kindLabel(item.kind)} · ${refText(item)}` : ''}
      subtitle={item ? `Dokumen ${item.documentId}` : undefined}>
      {item && <DetailBody item={item} onChanged={onChanged} />}
    </Modal>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-gray-800 font-semibold break-words text-xs">{value}</p>
    </div>
  )
}

function Json({ title, value }: { title: string; value: unknown }) {
  if (value == null) return null
  return (
    <div>
      <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{title}</p>
      <pre className="text-[11px] bg-gray-900 text-gray-100 rounded-xl p-3 overflow-auto max-h-64">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function DetailBody({ item, onChanged }: { item: ErpOutboxItem; onChanged: () => void }) {
  const q = usePolledQuery(() => api.getErpOutbox(item.id), [item.id], 30000)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const d = q.data ?? item

  const retry = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.retryErpOutbox(item.id)
      setMsg('Dokumen dijadwalkan ulang.')
      await q.refetch()
      onChanged()
    } catch (e: unknown) {
      setMsg(e instanceof ApiError && e.status === 409
        ? 'Dokumen sedang antre atau dikirim'
        : e instanceof Error ? e.message : 'Gagal mengirim ulang')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3"><StatusBadge status={d.status} /></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Dibuat" value={fmtTime(d.createdAt)} />
        <Field label="Diperbarui" value={fmtTime(d.updatedAt)} />
        <Field label="Percobaan berikut" value={showsNextAttempt(d.status) ? fmtTime(d.nextAttemptAt) : '—'} />
        <Field label="Terkirim" value={fmtTime(d.deliveredAt)} />
        <Field label="Percobaan" value={String(d.attempts)} />
        <Field label="HTTP terakhir" value={d.lastHttpStatus != null ? String(d.lastHttpStatus) : '—'} />
        <Field label="Alasan ditahan" value={d.holdReason || '—'} />
        <Field label="Error terakhir" value={d.lastError || '—'} />
      </div>
      {q.error && <p role="alert" className="text-xs text-red-600">{q.error}</p>}
      <Json title="Payload" value={q.data?.payload} />
      <Json title="Respons ERP" value={q.data?.erpResponse} />
      {canRetry(d.status) && (
        <div className="space-y-2">
          <Button onClick={() => void retry()} loading={busy}>Kirim ulang</Button>
          <p className="text-xs text-gray-400">
            Setelah 400/422 dokumen dibangun ulang dari pemetaan terkini; selain itu isi yang sama dikirim ulang.
          </p>
        </div>
      )}
      {msg && <p role="status" className="text-xs font-semibold text-gray-700">{msg}</p>}
    </div>
  )
}
