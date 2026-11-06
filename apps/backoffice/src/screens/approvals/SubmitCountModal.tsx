import { useRef, useState } from 'react'
import type { InventoryReasonCode, StockCountSubmitInput } from '@mandalika/api'
import {
  REASON_OPTIONS,
  buildSubmitLines,
  lineKey,
  type LineReason,
  type VarianceLine,
  newIdempotencyKey,
  reasonTextRequired,
  signed,
  validateReason,
} from '../../lib/inventoryApproval'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface SubmitCountModalProps {
  countName: string
  lines: VarianceLine[]
  /** Sends the submission; resolves when done. The key is stable across retries of the same form. */
  onSubmit: (input: StockCountSubmitInput, idemKey: string) => Promise<void>
  onClose: () => void
}

/** "Ajukan Persetujuan": a count-level reason plus an optional reason per variance line. */
export function SubmitCountModal({ countName, lines, onSubmit, onClose }: SubmitCountModalProps) {
  const [code, setCode] = useState<InventoryReasonCode | ''>('')
  const [text, setText] = useState('')
  const [reasons, setReasons] = useState<Record<string, LineReason>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const keyRef = useRef(newIdempotencyKey())

  // Any edit is a different action, so it gets a new idempotency key.
  const touch = () => { keyRef.current = newIdempotencyKey() }
  const setLine = (k: string, patch: Partial<LineReason>) => {
    touch()
    setReasons((prev) => ({ ...prev, [k]: { ...(prev[k] ?? { code: '', text: '' }), ...patch } }))
  }

  const lineProblem = lines.some(({ item }) => {
    const r = reasons[lineKey(item)]
    return !!r && validateReason(r.code, r.text) !== null && (r.code !== '' || r.text.trim() !== '')
  })
  const headProblem = validateReason(code, text)

  const submit = async () => {
    if (headProblem || !code) return setErr(headProblem)
    if (lineProblem) return setErr('Alasan per baris belum lengkap (Lainnya wajib keterangan).')
    setBusy(true)
    setErr(null)
    try {
      await onSubmit({ reasonCode: code, reasonText: text.trim() || undefined, lines: buildSubmitLines(lines, reasons) }, keyRef.current)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal mengajukan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Ajukan Persetujuan"
      subtitle={countName}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button className="flex-1" onClick={submit} loading={busy} disabled={!!headProblem}>Ajukan</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-700">
          {lines.length === 0
            ? 'Tidak ada selisih, stock count akan langsung diselesaikan.'
            : `${lines.length} baris berselisih akan diterapkan setelah disetujui.`}
        </p>
        <Select label="Alasan opname *" value={code} onChange={(e) => { touch(); setCode(e.target.value as InventoryReasonCode | '') }}>
          <option value="">Pilih alasan...</option>
          {REASON_OPTIONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </Select>
        <Input
          label={reasonTextRequired(code) ? 'Keterangan *' : 'Keterangan'}
          type="text"
          value={text}
          onChange={(e) => { touch(); setText(e.target.value) }}
        />
        {lines.length > 0 && (
          <div className="max-h-72 overflow-y-auto divide-y divide-paper-2 border border-paper-2 rounded-xl">
            {lines.map(({ item, diff }) => {
              const k = lineKey(item)
              const r = reasons[k]
              return (
                <div key={k} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="flex-1 min-w-40 text-sm font-bold text-ink-900">
                    {item.productName} <span className="text-xs text-ink-500">{item.variantSize}</span>
                  </span>
                  <span className={`text-sm font-black ${diff > 0 ? 'text-ok' : 'text-danger'}`}>{signed(diff)}</span>
                  <select
                    aria-label={`Alasan ${item.productName} ${item.variantSize}`}
                    className="px-2 py-1 border border-paper-2 rounded-lg text-xs"
                    value={r?.code ?? ''}
                    onChange={(e) => setLine(k, { code: e.target.value as InventoryReasonCode | '' })}
                  >
                    <option value="">Alasan (opsional)</option>
                    {REASON_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                  </select>
                  {r?.code === 'other' && (
                    <input
                      aria-label={`Keterangan ${item.productName} ${item.variantSize}`}
                      className="px-2 py-1 border border-paper-2 rounded-lg text-xs"
                      placeholder="Keterangan *"
                      value={r.text}
                      onChange={(e) => setLine(k, { text: e.target.value })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      </div>
    </Modal>
  )
}
