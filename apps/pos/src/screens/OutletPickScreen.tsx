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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 safe-top safe-bottom">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h1 className="text-xl font-black text-gray-900">Pilih outlet terminal ini</h1>
        <p className="text-sm text-gray-500 mt-1">
          Akun {user?.displayName ?? ''} tidak terikat ke satu outlet. Outlet yang dipilih dipakai tablet ini untuk
          semua transaksi dan hanya bisa diubah lewat Pengaturan → Lepas terminal.
        </p>

        {loadError && (
          <div role="alert" className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {loadError}
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="ml-2 font-bold underline">
              Coba lagi
            </button>
          </div>
        )}
        {saveError && (
          <p role="alert" className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {saveError}
          </p>
        )}

        <div className="mt-4 space-y-1.5 max-h-[50vh] overflow-y-auto">
          {outlets === null && !loadError && <p className="text-sm text-gray-400">Memuat outlet…</p>}
          {outlets?.length === 0 && <p className="text-sm text-gray-500">Belum ada outlet aktif.</p>}
          {outlets?.map((o) => (
            <button
              type="button"
              key={o.id}
              disabled={busyId !== null}
              onClick={() => void choose(o)}
              className="w-full text-left px-4 py-3 rounded-xl border border-gray-200 hover:border-amber-500 hover:bg-amber-50 transition disabled:opacity-60"
            >
              <p className="text-sm font-bold text-gray-900">{busyId === o.id ? 'Menyimpan…' : o.name}</p>
              {o.address && <p className="text-xs text-gray-400">{o.address}</p>}
            </button>
          ))}
        </div>

        <button type="button" onClick={logout} className="mt-5 text-xs font-semibold text-gray-500 hover:text-gray-700 underline">
          Keluar
        </button>
      </div>
    </div>
  )
}
