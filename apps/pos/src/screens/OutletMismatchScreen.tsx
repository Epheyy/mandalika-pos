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
    <div className="min-h-screen flex items-center justify-center bg-paper-0 p-6 safe-top safe-bottom">
      <div className="surface-solid w-full max-w-md rounded-panel p-6">
        <h1 className="text-xl font-bold text-ink-900">Outlet akun berbeda dengan terminal</h1>
        <p className="text-sm text-ink-500 mt-2">
          Terminal ini terikat ke outlet {outletName}, sedangkan akun {user?.displayName ?? ''} terdaftar di outlet
          berbeda. Transaksi dinonaktifkan agar tidak tercatat di outlet yang salah.
        </p>
        <div className="mt-4 bg-paper-1 rounded-control p-3 text-sm text-ink-700 space-y-1">
          <div className="flex justify-between"><span>Tersimpan di tablet</span><span className="font-semibold text-ink-900">{summary?.pending ?? 0}</span></div>
          <div className="flex justify-between"><span>Perlu ditinjau</span><span className="font-semibold text-ink-900">{review}</span></div>
        </div>
        {(summary?.pending ?? 0) > 0 && (
          <p className="mt-3 text-sm text-ink-700">
            Minta admin mengembalikan outlet akun ke {outletName} sampai antrean terkirim, atau tunggu sampai antrean
            selesai ditinjau. Transaksi tidak dihapus.
          </p>
        )}
        {blocked && (
          <p role="status" className="mt-3 text-sm font-semibold text-warn-strong bg-warn-bg rounded-control px-3 py-2">
            {blocked}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm font-semibold text-danger bg-danger-bg rounded-control px-3 py-2">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={blocked !== null || busy}
          onClick={() => void release()}
          className="press mt-5 w-full min-h-12 bg-danger-solid text-white rounded-control text-sm font-semibold disabled:opacity-40 active:opacity-90"
        >
          {busy ? 'Melepas…' : 'Lepas terminal'}
        </button>
        <button type="button" onClick={logout} className="mt-3 w-full min-h-11 text-sm font-semibold text-ink-700 underline">
          Keluar
        </button>
      </div>
    </div>
  )
}
