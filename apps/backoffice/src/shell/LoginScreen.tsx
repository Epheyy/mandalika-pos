import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth'
import { BRAND } from '../lib/brand'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Input } from '../ui/Field'

export function LoginScreen() {
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="shadow-xl p-8 w-full max-w-sm">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="text-center">
            <img src={BRAND.logoUrl} alt="" className="h-10 mx-auto mb-3 object-contain" />
            <h1 className="text-xl font-black text-gray-900">Mandalika Back Office</h1>
            <p className="text-xs text-gray-400">Masuk dengan akun admin / manajer</p>
          </div>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            aria-label="Email"
            autoComplete="username"
          />
          <Input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Kata sandi"
            aria-label="Kata sandi"
            autoComplete="current-password"
          />
          <Button type="submit" loading={busy} className="w-full py-3 rounded-2xl">
            {busy ? 'Memproses…' : 'Masuk'}
          </Button>
          {err && <p className="text-sm text-center text-red-600">{err}</p>}
        </form>
      </Card>
    </div>
  )
}
