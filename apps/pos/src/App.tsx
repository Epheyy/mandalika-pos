import { useState, type FormEvent } from 'react'
import { useAuth } from './auth'
import { SyncProvider } from './cashier/SyncProvider'
import CashierScreen from './cashier/CashierScreen'

function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await login(email, password)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 320, margin: '4rem auto', fontFamily: 'system-ui' }}>
      <h1 style={{ marginBottom: 24, fontWeight: 900, fontSize: 22 }}>Mandalika POS</h1>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        autoComplete="username"
        type="email"
        style={{ display: 'block', width: '100%', marginBottom: 8, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, boxSizing: 'border-box' }}
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="Password"
        autoComplete="current-password"
        style={{ display: 'block', width: '100%', marginBottom: 12, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, boxSizing: 'border-box' }}
      />
      <button
        disabled={busy}
        type="submit"
        style={{ width: '100%', padding: '10px 0', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1 }}
      >
        {busy ? 'Masuk…' : 'Masuk'}
      </button>
      {err && <p style={{ color: 'crimson', fontSize: 13, marginTop: 8 }}>{err}</p>}
    </form>
  )
}

export default function App() {
  const { user, ready } = useAuth()
  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui', color: '#6b7280' }}>
        Memuat…
      </div>
    )
  }
  if (!user) return <LoginScreen />
  // Phase C: offline-first CashierScreen wrapped in SyncProvider
  return (
    <SyncProvider>
      <CashierScreen />
    </SyncProvider>
  )
}
