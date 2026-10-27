/**
 * A cashier/manager whose outlet differs from the one this terminal is bound to (A04).
 * The terminal is never silently rebound: selling and capture are off (no outlet is in effect, so
 * actor() refuses). A FLUSH-ONLY engine is mounted around this screen so what is already queued
 * (stamped with the terminal's outlet) can replay as already-applied or be parked for review;
 * once nothing is waiting, "Lepas terminal" unlocks (stamped review items stay in the outbox).
 * "Keluar" only ends the session: it deletes neither the queue nor the binding.
 */

import { use, useEffect, useState } from 'react'
import { getKV } from '@mandalika/sync'
import { useAuth } from '../auth'
import { SyncContext } from '../cashier/SyncProvider'
import { readBinding, releaseBlockedReason } from '../terminalBinding'

export default function OutletMismatchScreen() {
  const engine = use(SyncContext)
  const { user, releaseTerminal, logout } = useAuth()
  const [, tick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [])

  const binding = readBinding(getKV())
  const outletName = binding?.outletName ?? 'terminal'
  const summary = engine?.queueSummary()
  const review = (summary?.parkedStamped ?? 0) + (summary?.parkedUnstamped ?? 0)
  const blocked = engine && summary
    ? releaseBlockedReason({
        pending: summary.pending,
        parkedUnstamped: summary.parkedUnstamped,
        corrupted: engine.outboxCorruption() !== null,
        online: engine.isReachable(),
      })
    : 'Mesin sinkronisasi belum siap.'

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
          Terminal ini terikat ke outlet {outletName}, sedangkan akun {user?.displayName ?? ''} terdaftar di outlet
          berbeda. Transaksi dinonaktifkan agar tidak tercatat di outlet yang salah.
        </p>
        <div className="mt-4 bg-gray-50 rounded-xl p-3 text-xs text-gray-600 space-y-1">
          <div className="flex justify-between"><span>Tersimpan di tablet</span><span className="font-semibold text-gray-800">{summary?.pending ?? 0}</span></div>
          <div className="flex justify-between"><span>Perlu ditinjau</span><span className="font-semibold text-gray-800">{review}</span></div>
        </div>
        {(summary?.pending ?? 0) > 0 && (
          <p className="mt-3 text-xs text-gray-600">
            Minta admin mengembalikan outlet akun ke {outletName} sampai antrean terkirim, atau tunggu sampai antrean
            selesai ditinjau. Transaksi tidak dihapus.
          </p>
        )}
        {blocked && (
          <p role="status" className="mt-3 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {blocked}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={blocked !== null || busy}
          onClick={() => void release()}
          className="mt-5 w-full py-2.5 bg-danger-solid text-white rounded-xl text-sm font-semibold disabled:opacity-40 active:opacity-90 transition-colors"
        >
          {busy ? 'Melepas…' : 'Lepas terminal'}
        </button>
        <button type="button" onClick={logout} className="mt-3 w-full text-xs font-semibold text-gray-500 hover:text-gray-700 underline">
          Keluar
        </button>
      </div>
    </div>
  )
}
