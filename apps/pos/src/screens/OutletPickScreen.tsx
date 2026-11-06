/**
 * One-time terminal outlet pick for an outlet-less account (e.g. admin) on a tablet
 * that is not bound to an outlet yet (A04). The choice is stored durably as the
 * terminal's outlet; it changes only through "Lepas terminal" in Pengaturan, never
 * through a switcher in the header.
 */

import { useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'
import { useAuth } from '../auth'

type Outlet = components['schemas']['Outlet']

export default function OutletPickScreen() {
  const { user, pickOutlet, logout } = useAuth()
  const [outlets, setOutlets] = useState<Outlet[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setLoadError(null)
    api
      .request<{ data: Outlet[] }>('GET', '/api/v1/outlets')
      .then((r) => { if (live) setOutlets(r.data.filter((o) => o.isActive)) })
      .catch(() => { if (live) setLoadError('Tidak dapat memuat daftar outlet. Hubungkan internet lalu coba lagi.') })
    return () => { live = false }
  }, [attempt])

  async function choose(o: Outlet) {
    if (busyId) return
    setBusyId(o.id)
    setSaveError(null)
    try {
      await pickOutlet({ id: o.id, name: o.name })
    } catch {
      setSaveError('Pilihan outlet BELUM tersimpan di perangkat. Coba lagi.')
      setBusyId(null)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-0 p-6 safe-top safe-bottom">
      <div className="surface-solid w-full max-w-md rounded-panel p-6">
        <h1 className="text-xl font-bold text-ink-900">Pilih outlet terminal ini</h1>
        <p className="text-sm text-ink-500 mt-1">
          Akun {user?.displayName ?? ''} tidak terikat ke satu outlet. Outlet yang dipilih dipakai tablet ini untuk
          semua transaksi dan hanya bisa diubah lewat Pengaturan → Lepas terminal.
        </p>

        {loadError && (
          <div role="alert" className="mt-4 text-sm text-danger bg-danger-bg rounded-control px-3 py-2">
            {loadError}
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="ml-2 min-h-11 font-bold underline">
              Coba lagi
            </button>
          </div>
        )}
        {saveError && (
          <p role="alert" className="mt-4 text-sm text-danger bg-danger-bg rounded-control px-3 py-2">
            {saveError}
          </p>
        )}

        <div className="mt-4 space-y-1.5 max-h-[50vh] overflow-y-auto">
          {outlets === null && !loadError && <p className="text-sm text-ink-500">Memuat outlet…</p>}
          {outlets?.length === 0 && <p className="text-sm text-ink-500">Belum ada outlet aktif.</p>}
          {outlets?.map((o) => (
            <button
              type="button"
              key={o.id}
              disabled={busyId !== null}
              onClick={() => void choose(o)}
              className="press w-full min-h-14 text-left px-4 py-3 rounded-control surface-card active:bg-paper-1 disabled:opacity-60"
            >
              <p className="text-sm font-bold text-ink-900">{busyId === o.id ? 'Menyimpan…' : o.name}</p>
              {o.address && <p className="text-xs text-ink-500">{o.address}</p>}
            </button>
          ))}
        </div>

        <button type="button" onClick={logout} className="mt-5 min-h-11 text-sm font-semibold text-ink-700 underline">
          Keluar
        </button>
      </div>
    </div>
  )
}
