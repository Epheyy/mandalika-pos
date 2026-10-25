import { useRef, useState } from 'react'
import { approveErrorMessage, isValidPin, newIdempotencyKey } from '../../lib/inventoryApproval'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface PinModalProps {
  title: string
  /** Performs the approve call; the idempotency key stays the same across retries of this confirmation. */
  onApprove: (pin: string, note: string, idemKey: string) => Promise<void>
  onClose: () => void
}

/** Approver step-up: the logged-in user re-enters their own receive PIN (4-8 digits). */
export function PinModal({ title, onApprove, onClose }: PinModalProps) {
  const [pin, setPin] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const keyRef = useRef(newIdempotencyKey())

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      await onApprove(pin, note.trim(), keyRef.current)
    } catch (e: unknown) {
      setErr(approveErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={title}
      subtitle="Masukkan PIN Anda untuk menyetujui."
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button className="flex-1" onClick={submit} loading={busy} disabled={!isValidPin(pin)}>Setujui</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="PIN *"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="4-8 digit"
        />
        <Input label="Catatan" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
