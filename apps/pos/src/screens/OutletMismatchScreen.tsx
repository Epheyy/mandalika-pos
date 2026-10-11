/**
 * A cashier/manager whose outlet differs from the one this terminal is bound to (A04).
 * The terminal is never silently rebound: selling, flushing and capture are all off (no outlet
 * is in effect, so actor() refuses) until "Lepas terminal" frees it. That needs nothing waiting to
 * be sent (parked items that carry their owner stamp do not count) and signs this account out.
 */

import { useState } from 'react'
import { getKV } from '@mandalika/sync'
import { useAuth } from '../auth'
import { readBinding, readQueueState, releaseBlockedReason } from '../terminalBinding'

export default function OutletMismatchScreen() {
  const { user, releaseTerminal } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kv = getKV()
  const binding = readBinding(kv)
  const q = readQueueState(kv)
  const blocked = releaseBlockedReason({
    pending: q.pending, parkedUnstamped: q.parkedUnstamped, corrupted: !q.readable, online: true,
  })

  async function release() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await releaseTerminal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal melepas terminal')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 safe-top safe-bottom">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h1 className="text-xl font-black text-gray-900">Outlet akun berbeda dengan terminal</h1>
        <p className="text-sm text-gray-500 mt-2">
          Terminal ini terikat ke outlet {binding?.outletName ?? 'lain'}, sedangkan akun {user?.displayName ?? ''} terdaftar
          di outlet berbeda. Transaksi dinonaktifkan agar tidak tercatat di outlet yang salah. Lepas terminal untuk
          mengikatnya ke outlet akun ini, lalu masuk kembali.
        </p>
        {blocked && (
          <p role="status" className="mt-4 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {blocked}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={blocked !== null || busy}
          onClick={() => void release()}
          className="mt-5 w-full py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40 hover:bg-red-700 transition-colors"
        >
          {busy ? 'Melepas…' : 'Lepas terminal'}
        </button>
      </div>
    </div>
  )
}
