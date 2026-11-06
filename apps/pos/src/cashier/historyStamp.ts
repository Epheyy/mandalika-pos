/** The one date + time format of Riwayat and Struk di tablet ini (id-ID). */
export function formatHistoryStamp(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
