import { useEffect, useRef, useState } from 'react'
import type { ReceiveApprover } from './receiveTypes'
import { createSubmitGate, notSavedMessage } from '../../lib/durableSubmit'
import {
  OFFLINE_MESSAGE,
  formatCountdown,
  requestReceiveGrant,
  type ReceiveGrantInput,
} from './receiveApprovalFlow'
import { Sheet } from '../../components/ui/Sheet'

interface Props {
  /** The receipt key created up front; reused on every retry so a lost response never double-receives. */
  receiptKey: string
  transferId: string
  items: ReceiveGrantInput['items']
  reason: string
  isOnline?: () => boolean
  listApprovers: () => Promise<ReceiveApprover[]>
  requestApproval: (input: ReceiveGrantInput) => Promise<{ approvalGrantId: string }>
  onCancel: () => void
  /** Resolve once the receive is durably queued; reject if it could not be stored. Runs ONLY after a grant. */
  onApproved: (approvalGrantId: string) => void | Promise<void>
}

const defaultOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)

// A08: the approver PIN is verified on the server (with its own lockout); nothing about it is kept
// here. The PIN only travels in the one request, is cleared from state afterwards, and never reaches
// the outbox: the queued receive carries the single-use grant id instead.
export function ReceiveApprovalModal({
  receiptKey, transferId, items, reason, isOnline = defaultOnline, listApprovers, requestApproval, onCancel, onApproved,
}: Props) {
  const [offline] = useState(() => !isOnline())
  const [approvers, setApprovers] = useState<ReceiveApprover[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [approverId, setApproverId] = useState('')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lockUntil, setLockUntil] = useState<number | null>(null)
  const [hardLocked, setHardLocked] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const submitGate = useRef(createSubmitGate())
  // A grant already minted whose enqueue failed: retry the enqueue without asking for the PIN again.
  const grantRef = useRef<string | null>(null)
  // The parent passes fresh lambdas each render; the list is fetched once per open.
  const listRef = useRef(listApprovers)
  listRef.current = listApprovers

  useEffect(() => {
    if (offline) return
    let ignore = false
    listRef.current().then(
      (rows) => {
        if (ignore) return
        setApprovers(rows)
        setApproverId(rows[0]?.userId ?? '')
      },
      () => { if (!ignore) setLoadError('Tidak bisa memuat daftar penyetuju. Periksa koneksi lalu coba lagi.') },
    )
    return () => { ignore = true }
  }, [offline])

  useEffect(() => {
    if (lockUntil == null) return
    const t = setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (n >= lockUntil) setLockUntil(null)
    }, 1000)
    return () => clearInterval(t)
  }, [lockUntil])

  const remaining = lockUntil == null ? 0 : Math.max(0, Math.ceil((lockUntil - now) / 1000))
  const locked = hardLocked || remaining > 0

  const submit = async () => {
    if (locked || busy || submitGate.current.isBusy()) return
    if (!grantRef.current && !approverId) {
      setErr('Pilih penyetuju')
      return
    }
    setBusy(true)
    setErr(null)
    const outcome = await submitGate.current.run(async () => {
      if (!grantRef.current) {
        const r = await requestReceiveGrant(
          { isOnline, request: requestApproval },
          { idempotencyKey: receiptKey, transferId, items, discrepancyReason: reason, approverUserId: approverId, pin },
        )
        setPin('') // never keep the PIN after the one request
        if (r.kind !== 'granted') return r
        grantRef.current = r.grantId
      }
      await onApproved(grantRef.current)
      return null
    })
    setBusy(false)
    if (outcome.status === 'busy') return
    if (outcome.status === 'failed') {
      // Granted but not stored on the device: stay open; the retry re-queues with the same grant.
      setErr(notSavedMessage('Penerimaan'))
      return
    }
    const r = outcome.value
    if (!r) return // queued; the parent closes the modal
    if (r.kind === 'locked') {
      setHardLocked(r.hard)
      if (!r.hard) {
        setNow(Date.now())
        setLockUntil(Date.now() + r.retryAfterSeconds * 1000)
      }
      setErr(r.hard ? 'Terkunci, hubungi admin' : null)
      return
    }
    setErr(r.message)
  }

  const shell = (children: React.ReactNode) => (
    <Sheet open variant="center" maxWidth="max-w-sm" panelClassName="p-5">{children}</Sheet>
  )
  const closeOnly = (text: string) =>
    shell(
      <>
        <h3 className="font-bold text-gray-900 mb-3">Persetujuan penerimaan</h3>
        <p className="text-sm text-gray-600 mb-5" role="alert">{text}</p>
        <button type="button" onClick={onCancel}
          className="w-full py-2.5 border border-gray-200 rounded-xl font-semibold text-sm text-gray-700 hover:bg-gray-50 transition-colors">
          Tutup
        </button>
      </>,
    )

  if (offline) return closeOnly(OFFLINE_MESSAGE)
  if (loadError) return closeOnly(loadError)
  if (approvers == null) return closeOnly('Memuat penyetuju…')
  if (approvers.length === 0) return closeOnly('Belum ada penyetuju ber-PIN untuk outlet ini. Hubungi admin.')

  return shell(
    <>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-gray-900">Persetujuan penerimaan</h3>
        <button type="button" onClick={onCancel} disabled={busy}
          className="text-gray-400 hover:text-gray-600 text-lg leading-none" aria-label="Tutup">×</button>
      </div>

      <label htmlFor="receive-approval-approver" className="block text-xs text-gray-700 font-semibold mb-1">Penyetuju</label>
      <select id="receive-approval-approver" value={approverId}
        onChange={(e) => { setApproverId(e.target.value); setErr(null) }}
        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 mb-4 bg-white">
        {approvers.map((a) => <option key={a.userId} value={a.userId}>{a.displayName}</option>)}
      </select>

      <label htmlFor="receive-approval-pin" className="block text-xs text-gray-700 font-semibold mb-1">PIN</label>
      <input id="receive-approval-pin" type="password" inputMode="numeric" maxLength={8} value={pin}
        onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setErr(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 4 && !busy && !locked) void submit() }}
        placeholder="••••" disabled={locked}
        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-1 focus:ring-indigo-400 mb-1"
        autoComplete="one-time-code" />

      {remaining > 0 && (
        <p className="text-xs text-red-500 mb-3" role="alert">Terkunci. Coba lagi dalam {formatCountdown(remaining)}</p>
      )}
      {err && <p className="text-xs text-red-500 mb-3" role="alert">{err}</p>}
      {!err && remaining === 0 && <div className="mb-3" />}

      <div className="flex gap-2">
        <button type="button" onClick={() => void submit()}
          disabled={busy || locked || (!grantRef.current && pin.length < 4)}
          className="flex-1 py-2.5 bg-indigo-600 text-white rounded-xl font-semibold text-sm disabled:opacity-40 hover:bg-indigo-700 transition-colors">
          {busy ? 'Memverifikasi…' : 'Setujui'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}
          className="flex-1 py-2.5 border border-gray-200 rounded-xl font-semibold text-sm text-gray-700 hover:bg-gray-50 transition-colors">
          Batal
        </button>
      </div>
    </>,
  )
}
