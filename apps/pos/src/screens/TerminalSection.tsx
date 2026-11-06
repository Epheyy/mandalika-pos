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
import { QueueGuardLine } from '../components/QueueGuardLine'
import { queueBlockReason } from '../lib/queueGuard'

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
      <div className="bg-paper-1 rounded-control p-3 text-sm text-ink-700 space-y-1">
        <div className="flex justify-between">
          <span>Outlet terminal</span>
          <span className="font-semibold text-ink-900">{engine?.getSnapshot().outletName || binding?.outletName || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span>Akun</span>
          <span className="font-semibold text-ink-900">{user?.displayName ?? '—'}</span>
        </div>
      </div>
      <p className="text-sm text-ink-500">
        Outlet tablet ini tetap dan tidak bisa diganti dari layar kasir. Melepas terminal mengeluarkan akun dan
        mengosongkan pilihan outlet; hanya bisa saat online dan tidak ada transaksi yang belum terkirim.
      </p>
      {summary && (
        <QueueGuardLine
          pending={summary.pending}
          parked={summary.parkedStamped + summary.parkedUnstamped}
          reason={blocked ? queueBlockReason(
            { pending: summary.pending, parked: summary.parkedStamped + summary.parkedUnstamped, parkedUnstamped: summary.parkedUnstamped },
            { needsOnline: true, online: engine?.isReachable() },
          ) : null}
        />
      )}
      {blocked && (
        <p role="status" className="text-sm font-semibold text-warn-strong bg-warn-bg rounded-control px-3 py-2">
          {blocked}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-danger bg-danger-bg rounded-control px-3 py-2">
          {error}
        </p>
      )}
      {!confirming ? (
        <button
          type="button"
          disabled={blocked !== null || busy}
          onClick={() => setConfirming(true)}
          className="press w-full min-h-12 bg-danger-solid text-white rounded-control text-sm font-semibold disabled:opacity-40 active:opacity-90"
        >
          Lepas terminal
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-bold text-ink-900">Yakin melepas terminal ini dan keluar?</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={blocked !== null || busy}
              onClick={() => void release()}
              className="press flex-1 min-h-12 bg-danger-solid text-white rounded-control text-sm font-semibold disabled:opacity-40"
            >
              {busy ? 'Melepas…' : 'Ya, lepas'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="press flex-1 min-h-12 surface-card rounded-control text-sm font-semibold text-ink-700"
            >
              Batal
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
