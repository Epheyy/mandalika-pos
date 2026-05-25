import { useMemo, useState } from 'react'
import {
  verifyPin,
  canAttempt,
  recordFailure,
  resetLockout,
  getKV,
  readJSON,
  writeJSON,
  type Lockout,
} from '@mandalika/sync'
import type { ReceiveApprover } from './receiveTypes'

const LOCKOUT_KEY = 'mandalika.pos.pinLockout'

function loadLockout(): Lockout {
  return readJSON<Lockout>(getKV(), LOCKOUT_KEY, resetLockout())
}

function saveLockout(s: Lockout): void {
  writeJSON(getKV(), LOCKOUT_KEY, s)
}

interface Props {
  approvers: ReceiveApprover[]
  onCancel: () => void
  onApproved: (approverUserId: string, pin: string) => void
}

export function PinStepUpModal({ approvers, onCancel, onApproved }: Props) {
  const [approverId, setApproverId] = useState(approvers[0]?.userId ?? '')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lock, setLock] = useState<Lockout>(loadLockout)

  const approver = useMemo(
    () => approvers.find((a) => a.userId === approverId),
    [approvers, approverId],
  )

  const submit = async () => {
    const gate = canAttempt(lock, Date.now())
    if (!gate.allowed) {
      setErr(`Terkunci. Coba lagi dalam ${Math.ceil(gate.remainingMs / 1000)} detik`)
      return
    }
    if (!approver) {
      setErr('Pilih penyetuju')
      return
    }
    setBusy(true)
    setErr(null)
    const ok = await verifyPin(pin, approver.receivePinHash)
    setBusy(false)
    if (!ok) {
      const next = recordFailure(lock, Date.now())
      setLock(next)
      saveLockout(next)
      setErr('PIN salah')
      setPin('')
      return
    }
    const cleared = resetLockout()
    setLock(cleared)
    saveLockout(cleared)
    onApproved(approver.userId, pin)
  }

  // Empty-approvers state
  if (approvers.length === 0) {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
          <h3 className="font-bold text-gray-900 mb-3">Persetujuan penerimaan</h3>
          <p className="text-sm text-gray-600 mb-5">
            Belum ada penyetuju ber-PIN untuk outlet ini. Hubungi admin.
          </p>
          <button
            onClick={onCancel}
            className="w-full py-2.5 border border-gray-200 rounded-xl font-semibold text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-gray-900">Persetujuan penerimaan</h3>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            aria-label="Tutup"
          >
            ×
          </button>
        </div>

        {/* Approver select */}
        <label className="block text-xs text-gray-700 font-semibold mb-1">
          Penyetuju
        </label>
        <select
          value={approverId}
          onChange={(e) => {
            setApproverId(e.target.value)
            setErr(null)
          }}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 mb-4 bg-white"
        >
          {approvers.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.displayName}
            </option>
          ))}
        </select>

        {/* PIN input */}
        <label className="block text-xs text-gray-700 font-semibold mb-1">
          PIN
        </label>
        <input
          type="password"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, ''))
            setErr(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pin.length >= 4 && !busy) {
              void submit()
            }
          }}
          placeholder="••••"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-1 focus:ring-indigo-400 mb-1"
          autoComplete="one-time-code"
        />

        {/* Error */}
        {err && (
          <p className="text-xs text-red-500 mb-3">{err}</p>
        )}
        {!err && <div className="mb-3" />}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy || pin.length < 4}
            className="flex-1 py-2.5 bg-indigo-600 text-white rounded-xl font-semibold text-sm disabled:opacity-40 hover:bg-indigo-700 transition-colors"
          >
            {busy ? 'Memverifikasi…' : 'Setujui'}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-2.5 border border-gray-200 rounded-xl font-semibold text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Batal
          </button>
        </div>
      </div>
    </div>
  )
}
