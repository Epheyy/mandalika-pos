type DiagnosticPlatform = {
  share?: (data: ShareData) => Promise<void>
  clipboard?: { writeText: (text: string) => Promise<void> }
}

export const diagnosticExportMessages = {
  shared: 'Log dibagikan. Transaksi gagal tetap menunggu sinkronisasi.',
  copied: 'Log disalin. Transaksi gagal tetap menunggu sinkronisasi.',
  cancelled: 'Berbagi log dibatalkan. Transaksi gagal tetap tersimpan.',
  failed: 'Log belum dapat dibagikan. Transaksi gagal tetap tersimpan.',
  unavailable: 'Fitur berbagi atau salin tidak tersedia. Transaksi gagal tetap tersimpan.',
} as const

/** Delivery only receives detached text; it has no queue mutation capability. */
export async function shareFailedSyncDiagnostics(
  buildDiagnostics: () => string,
  platform: DiagnosticPlatform = typeof navigator === 'undefined' ? {} : navigator,
): Promise<keyof typeof diagnosticExportMessages> {
  try {
    const text = `Mandalika POS — Sync Log\n${new Date().toISOString()}\n\n${buildDiagnostics()}`
    if (platform.share) {
      await platform.share({ title: 'Mandalika POS Sync Log', text })
      return 'shared'
    }
    if (platform.clipboard) {
      await platform.clipboard.writeText(text)
      return 'copied'
    }
    return 'unavailable'
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}
