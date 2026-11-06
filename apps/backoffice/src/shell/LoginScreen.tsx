import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth'
import { BRAND } from '../lib/brand'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Input } from '../ui/Field'

export function LoginScreen() {
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
    <div className="flex min-h-screen items-center justify-center bg-paper-0 p-4">
      <Card className="surface-solid w-full max-w-sm rounded-3xl p-8">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="text-center">
            <img src={BRAND.logoUrl} alt="" className="mx-auto mb-3 h-10 object-contain" />
            <h1 className="text-xl font-black text-ink-900">Mandalika Back Office</h1>
            <p className="text-xs text-ink-700">Masuk dengan akun admin / manajer</p>
          </div>
          {/* Visible labels (not placeholder-only). Deliberately no value/defaultValue: nothing is prefilled. */}
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
          <Input
            label="Kata sandi"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {/* Primary uses brand-strong (white on brand fails AA for small text). */}
          <Button type="submit" loading={busy} className="w-full rounded-2xl">
            {busy ? 'Memproses…' : 'Masuk'}
          </Button>
          {err && (
            <p role="alert" className="text-center text-sm text-danger">
              {err}
            </p>
          )}
        </form>
      </Card>
    </div>
  )
}
