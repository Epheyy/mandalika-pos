// Customer-field rules shared by the backoffice form and the POS "+ Baru" form. Twin of
// backend/internal/custrules (the server enforces the same rules). Messages are shown as is.
import { normalizePhone } from './phone'

export const PHONE_REQUIRED_MESSAGE = 'Nomor telepon wajib diisi'
export const PHONE_INVALID_MESSAGE = 'Nomor telepon tidak valid'
export const EMAIL_INVALID_MESSAGE = 'Format email tidak valid'

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const EMAIL_MAX_LENGTH = 254

/** Why the phone cannot be saved, or null. Indonesian and international numbers are both fine. */
export function phoneProblem(raw: string): string | null {
  if (raw.trim() === '') return PHONE_REQUIRED_MESSAGE
  return normalizePhone(raw) === '' ? PHONE_INVALID_MESSAGE : null
}

/** Why the email cannot be saved, or null. Empty is fine (email is optional). */
export function emailProblem(raw: string): string | null {
  const s = raw.trim()
  if (s === '') return null
  return s.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(s) ? EMAIL_INVALID_MESSAGE : null
}
