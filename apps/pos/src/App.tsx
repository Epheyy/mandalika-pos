import { useState, useEffect, type FormEvent } from 'react'
import { useAuth } from './auth'
import { hideSplash, otaNotifyReady } from './native'
import { SyncProvider } from './cashier/SyncProvider'
import CashierScreen from './cashier/CashierScreen'
import OutletPickScreen from './screens/OutletPickScreen'
import OutletMismatchScreen from './screens/OutletMismatchScreen'
import { brand } from './brand'

function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await login(email, password)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Masuk gagal. Periksa email dan kata sandi.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-white safe-top safe-bottom">
      {/* Brand panel — lg+ only. Dark luxury, gold glow accents. */}
      <div className="hidden lg:flex lg:w-[44%] relative overflow-hidden bg-[#1a1008] text-white flex-col justify-between p-12">
        <div className="absolute -top-28 -right-28 w-96 h-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="absolute -bottom-28 -left-28 w-96 h-96 rounded-full bg-brand/10 blur-3xl" />
        <img src={brand.logo} alt={brand.displayName} className="relative h-12 w-auto object-contain self-start" />
        <div className="relative space-y-3">
          <h1 className="text-4xl font-black leading-tight tracking-tight">Point of Sale</h1>
          <p className="text-white/70 text-sm max-w-xs leading-relaxed">
            Kelola penjualan, pelanggan, dan stok dalam satu aplikasi — online maupun offline.
          </p>
          <div className="flex gap-8 pt-5">
            <div>
              <p className="text-2xl font-black text-white">30+</p>
              <p className="text-[11px] text-white/50">Outlet aktif</p>
            </div>
            <div>
              <p className="text-2xl font-black text-white">Offline</p>
              <p className="text-[11px] text-white/50">Siap pakai</p>
            </div>
          </div>
        </div>
        <p className="relative text-[11px] text-white/40">© {brand.displayName}{brand.tagline ? ` · ${brand.tagline}` : ''}</p>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          <div className="lg:hidden flex flex-col items-center mb-8">
            <img src={brand.logo} alt={brand.displayName} className="h-14 w-auto object-contain" />
          </div>

          <div className="mb-7">
            <h2 className="text-2xl font-black text-gray-900">Selamat datang</h2>
            <p className="text-sm text-gray-500 mt-1">Masuk untuk memulai shift Anda.</p>
          </div>

          <label htmlFor="login-email" className="block text-xs font-bold text-gray-500 mb-1.5">Email</label>
          <div className="relative mb-4">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 5L2 7" /></svg>
            </span>
            <input
              id="login-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nama@mandalika.com"
              autoComplete="username"
              type="email"
              className="w-full pl-10 pr-3 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none transition"
            />
          </div>

          <label htmlFor="login-password" className="block text-xs font-bold text-gray-500 mb-1.5">Kata Sandi</label>
          <div className="relative mb-2">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            </span>
            <input
              id="login-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••"
              autoComplete="current-password"
              className="w-full pl-10 pr-11 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none transition"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
              className="absolute top-1/2 right-2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded-lg"
            >
              {showPassword ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              )}
            </button>
          </div>

          {err && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{err}</p>
          )}

          <button
            disabled={busy}
            type="submit"
            className="w-full mt-5 py-3 bg-amber-700 hover:bg-amber-800 active:bg-amber-900 text-white font-bold rounded-xl shadow-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Masuk…' : 'Masuk'}
          </button>

          <p className="text-center text-[11px] text-gray-400 mt-6">
            Powered by <span className="font-bold text-gray-500">Mandalika</span>
          </p>
        </form>
      </div>
    </div>
  )
}

/** A non-admin account without an outlet cannot sell: the server only attributes it to its own
 *  stored outlet, so a chosen outlet would never sync. Tell the cashier instead of letting them sell. */
function OutletUnassignedScreen() {
  const { user, logout } = useAuth()
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 safe-top safe-bottom">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h1 className="text-xl font-black text-gray-900">Akun belum terikat ke outlet</h1>
        <p className="text-sm text-gray-500 mt-2">
          Akun {user?.displayName ?? ''} belum memiliki outlet, jadi tidak bisa dipakai untuk transaksi di kasir.
          Hubungi admin untuk menetapkan outlet pada akun ini, lalu masuk kembali.
        </p>
        <button type="button" onClick={logout} className="mt-5 text-sm font-semibold text-amber-700 hover:text-amber-800 underline">
          Keluar
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const { user, ready, terminalState } = useAuth()
  // The native launch splash has launchAutoHide:false. SyncProvider hides it
  // post-login, but the pre-login screen never mounts SyncProvider — so on a
  // fresh/logged-out app the splash covered the WebView forever (blank app).
  // Hide it as soon as React shows anything; SplashScreen.hide() is idempotent.
  // Also confirm the OTA bundle booted HERE (A35). main.tsx mounts App only after
  // bootStorage() (secure KV + journal open/migration) succeeded, so reaching this
  // effect already means the journal booted; a BootError never gets here and stays
  // unconfirmed (Capgo rolls it back). Never gate this on network, login or sync
  // (offline/logged-out tablets would be rolled back). It fires on App's FIRST commit
  // (the "Memuat…" frame, auth starts ready=false), so a crash in a later screen
  // (Login/Cashier) is NOT auto-reverted: roll forward. Keep it in this effect, not
  // main.tsx, so a crash while App itself first renders stays unconfirmed. Locked by
  // App.otaReady.test.tsx + bootStorage.wiring.test.ts.
  useEffect(() => {
    void hideSplash()
    void otaNotifyReady()
  }, [])
  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui', color: '#6b7280' }}>
        Memuat…
      </div>
    )
  }
  if (!user) return <LoginScreen />
  // An outlet-less account on an unbound terminal picks the outlet once (A04).
  if (terminalState === 'unassigned') return <OutletUnassignedScreen />
  // A mismatch still mounts a FLUSH-ONLY engine: the queued items (stamped with the terminal's
  // outlet) must be able to replay or be parked for review, otherwise Lepas terminal could
  // never unlock. Capture stays refused (no outlet in effect, so actor() is null).
  if (terminalState === 'mismatch') return <SyncProvider flushOnly><OutletMismatchScreen /></SyncProvider>
  if (terminalState === 'pick') return <OutletPickScreen />
  // Phase C: offline-first CashierScreen wrapped in SyncProvider
  return (
    <SyncProvider>
      <CashierScreen />
    </SyncProvider>
  )
}
