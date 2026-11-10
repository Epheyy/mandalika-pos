// Maps print failures (native plugin codes, BLE plugin text) to Indonesian
// copy. Every message starts with "Gagal" so Settings colours it red.

const COPY = {
  timeout:
    'Gagal mencetak: printer tidak menjawab. Pastikan printer menyala, ada kertas, dan dekat dengan tablet.',
  connectFailed:
    'Gagal mencetak: tidak bisa tersambung ke printer. Matikan lalu nyalakan printer, lalu coba lagi.',
  dropped: 'Gagal mencetak: sambungan ke printer terputus. Coba cetak ulang.',
  btOff: 'Gagal mencetak: Bluetooth tablet mati. Nyalakan Bluetooth lalu coba lagi.',
  permission:
    'Gagal mencetak: izin Bluetooth ditolak. Izinkan "Perangkat di sekitar" untuk aplikasi POS di Pengaturan Android.',
  notBonded: 'Gagal mencetak: printer belum dipasangkan di Pengaturan Bluetooth tablet.',
  generic: 'Gagal mencetak',
}

const BY_CODE: Record<string, string> = {
  CONNECT_TIMEOUT: COPY.timeout,
  CONNECT_FAILED: COPY.connectFailed,
  WRITE_FAILED: COPY.dropped,
  NOT_CONNECTED: COPY.dropped,
  BT_OFF: COPY.btOff,
  PERMISSION_DENIED: COPY.permission,
  NOT_BONDED: COPY.notBonded,
}

export function printerErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && BY_CODE[code]) return BY_CODE[code]
  const message = (err as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message.length > 0) {
    if (message.startsWith('Gagal')) return message
    if (/timeout/i.test(message)) return COPY.timeout
    return `Gagal mencetak: ${message}`
  }
  return COPY.generic
}
