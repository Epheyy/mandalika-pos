// Pure helpers for the admin "Buka kunci PIN" action (kept DOM-free for node tests).

export const UNLOCK_PIN_DONE = 'Kunci PIN dibuka.'
export const UNLOCK_PIN_NOTE =
  'Menyetel PIN baru membatalkan persetujuan penerimaan yang belum dipakai dan membuka kunci PIN. "Buka kunci PIN" hanya membuka kunci tanpa mengganti PIN.'

export function unlockPinErrorMessage(status: number | undefined): string {
  switch (status) {
    case 403:
      return 'Anda tidak dapat membuka kunci PIN akun ini.'
    case 404:
      return 'Pengguna tidak ditemukan. Mungkin sudah dihapus; muat ulang daftar.'
    default:
      return 'Gagal membuka kunci PIN. Periksa koneksi lalu coba lagi.'
  }
}

export async function unlockReceivePin(
  api: { clearUserReceivePinLockout: (id: string) => Promise<void> },
  userId: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await api.clearUserReceivePinLockout(userId)
    return { ok: true, message: UNLOCK_PIN_DONE }
  } catch (e) {
    return { ok: false, message: unlockPinErrorMessage((e as { status?: number }).status) }
  }
}
