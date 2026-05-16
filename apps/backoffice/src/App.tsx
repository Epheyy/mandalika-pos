import { useState, type FormEvent } from 'react'
import { useAuth } from './auth'
import ProductsScreen from './screens/ProductsScreen'

function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('admin@mandalika.local')
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
    <form onSubmit={onSubmit} style={{ maxWidth: 320, margin: '4rem auto' }}>
      <h1>Mandalika Backoffice</h1>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="email"
        autoComplete="username"
        style={{ display: 'block', width: '100%', marginBottom: 8 }}
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="password"
        autoComplete="current-password"
        style={{ display: 'block', width: '100%', marginBottom: 8 }}
      />
      <button disabled={busy} type="submit">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </form>
  )
}

export default function App() {
  const { user, ready, logout } = useAuth()
  if (!ready) return <p>Loading…</p>
  if (!user) return <LoginScreen />
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong>
          {user.displayName} · {user.role}
        </strong>
        <button onClick={logout}>Sign out</button>
      </header>
      <ProductsScreen />
    </main>
  )
}
