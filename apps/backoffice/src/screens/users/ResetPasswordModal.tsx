import { useState } from 'react'
import { ApiError, type User } from '@mandalika/api'
import { api } from '../../api'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { resetPasswordErrorMessage, validateResetPassword } from './resetPassword'

interface ResetPasswordModalProps {
  user: User
  onClose: () => void
  /** Called after a successful reset (the parent unmounts the modal). */
  onDone: (user: User) => void
}

/** Admin sets a new password for another user. Mount only while open (state resets per user). */
export function ResetPasswordModal({ user, onClose, onDone }: ResetPasswordModalProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const validationError = validateResetPassword(password, confirm)
  const shownError = serverError ?? (touched ? validationError : null)

  const submit = async () => {
    setTouched(true)
    if (validationError || busy) return
    setBusy(true)
    setServerError(null)
    try {
      await api.resetUserPassword(user.id, { password })
      onDone(user)
    } catch (e) {
      setServerError(resetPasswordErrorMessage(e instanceof ApiError ? e.status : undefined))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Reset Kata Sandi"
      subtitle={user.displayName}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>Batal</Button>
          <Button className="flex-1" loading={busy} onClick={submit}>{busy ? 'Mereset...' : 'Reset Kata Sandi'}</Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p className="text-sm text-warn-strong bg-warn-bg border border-paper-2 rounded-xl px-3 py-2.5">
          Sesi {user.displayName} akan berakhir dan harus login ulang dengan kata sandi baru. Tablet POS yang memakai akun ini
          akan keluar otomatis dalam ±15 menit bila online (tablet offline keluar saat tersambung lagi). Penjualan yang belum
          tersinkron tetap tersimpan di tablet dan dikirim setelah ada yang login kembali. Sampaikan kata sandi baru langsung
          kepada yang bersangkutan.
        </p>
        <Input
          label="Kata sandi baru"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setServerError(null) }}
          hint="8-128 karakter"
        />
        <Input
          label="Ulangi kata sandi baru"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setServerError(null) }}
          error={shownError}
        />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}
