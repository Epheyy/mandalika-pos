/**
 * "Lepas terminal" (A04): the only way to change the terminal's outlet or hand the
 * tablet to another account. Allowed only online with nothing waiting to be sent and no
 * parked item without an owner stamp (stamped review items stay in the outbox, labelled
 * with their owner), so a release can never strand or reassign unsent transactions. It clears the terminal
 * binding and signs out; the next sign-in binds the terminal again.
 */

import { use, useEffect, useState } from 'react'
import { getKV } from '@mandalika/sync'
import { useAuth } from '../auth'
import { SyncContext } from '../cashier/SyncProvider'
import { readBinding, releaseBlockedReason } from '../terminalBinding'

export function TerminalSection() {
  const engine = use(SyncContext)
  const { user, releaseTerminal } = useAuth()
  const [, tick] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reachability and queue size change underneath us; re-evaluate every couple of seconds.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [])

  const binding = readBinding(getKV())
  const summary = engine?.queueSummary()
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
      await releaseTerminal() // signs out on success; this screen unmounts
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal melepas terminal')
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-600 space-y-1">
        <div className="flex justify-between">
          <span>Outlet terminal</span>
          <span className="font-semibold text-gray-800">{engine?.getSnapshot().outletName || binding?.outletName || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span>Akun</span>
          <span className="font-semibold text-gray-800">{user?.displayName ?? '—'}</span>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Outlet tablet ini tetap dan tidak bisa diganti dari layar kasir. Melepas terminal mengeluarkan akun dan
        mengosongkan pilihan outlet; hanya bisa saat online dan tidak ada transaksi yang belum terkirim.
      </p>
      {blocked && (
        <p role="status" className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {blocked}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
      {!confirming ? (
        <button
          type="button"
          disabled={blocked !== null || busy}
          onClick={() => setConfirming(true)}
          className="w-full py-2 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40 hover:bg-red-700 transition-colors"
        >
          Lepas terminal
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-bold text-gray-800">Yakin melepas terminal ini dan keluar?</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={blocked !== null || busy}
              onClick={() => void release()}
              className="flex-1 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40"
            >
              {busy ? 'Melepas…' : 'Ya, lepas'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="flex-1 py-2 border border-gray-200 rounded-xl text-sm font-semibold text-gray-600"
            >
              Batal
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
