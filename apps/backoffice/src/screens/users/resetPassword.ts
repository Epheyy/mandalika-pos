// Pure helpers for the admin "reset password" flow (kept DOM-free for node tests).

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128

/** Counts characters like the backend (runes), not UTF-16 units. */
const length = (s: string) => Array.from(s).length

/** Returns an Indonesian error message, or null when the input is acceptable. */
export function validateResetPassword(password: string, confirm: string): string | null {
  const n = length(password)
  if (n < MIN_PASSWORD_LENGTH) return `Kata sandi minimal ${MIN_PASSWORD_LENGTH} karakter.`
  if (n > MAX_PASSWORD_LENGTH) return `Kata sandi maksimal ${MAX_PASSWORD_LENGTH} karakter.`
  if (password !== confirm) return 'Konfirmasi kata sandi tidak sama.'
  return null
}

/** Maps a failed reset request to a user-facing message (never echoes raw server text). */
export function resetPasswordErrorMessage(status: number | undefined): string {
  switch (status) {
    case 400:
      return 'Kata sandi ditolak server. Pastikan 8-128 karakter.'
    case 403:
      return 'Anda tidak dapat mereset kata sandi akun ini.'
    case 404:
      return 'Pengguna tidak ditemukan. Mungkin sudah dihapus; muat ulang daftar.'
    default:
      return 'Gagal mereset kata sandi. Periksa koneksi lalu coba lagi.'
  }
}
