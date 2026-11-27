import { ApiError, type Api, type ReceiptLink } from '@mandalika/api'
import { waDigits } from '@mandalika/types'

export const WA_OFFLINE = 'Butuh internet'
export const WA_NOT_SYNCED = 'Order belum tersinkron, coba lagi sebentar'
export const WA_PHONE_BAD = 'Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890'
export const WA_PHONE_REQUIRED = 'Isi nomor WhatsApp pelanggan'

/** Which sale the link is for: this tablet's own sale (client uuid) or a server order from Riwayat (server id). */
export type WaTarget = { orderUuid: string } | { orderId: string }

/** Why a link cannot be made right now, or null when it can. Offline sends nothing; a blank phone is only fine
 *  when the order has a customer (the server then uses the stored number). */
export function waBlockReason(o: { isOnline: boolean; phone: string; allowEmptyPhone: boolean }): string | null {
  if (!o.isOnline) return WA_OFFLINE
  const phone = o.phone.trim()
  if (!phone) return o.allowEmptyPhone ? null : WA_PHONE_REQUIRED
  return waDigits(phone) ? null : WA_PHONE_BAD
}

/** Asks the server for a NEW link (earlier links stay valid). Online only: blocked calls return the reason instead. */
export async function createWaLink(
  api: Pick<Api, 'createReceiptLink'>,
  target: WaTarget,
  o: { isOnline: boolean; phone: string; allowEmptyPhone: boolean; deviceId?: string },
): Promise<{ ok: true; link: ReceiptLink } | { ok: false; error: string; notSynced: boolean }> {
  const blocked = waBlockReason(o)
  if (blocked) return { ok: false, error: blocked, notSynced: false }
  const phone = o.phone.trim()
  try {
    const link = await api.createReceiptLink({ ...target, ...(phone ? { phone } : {}), ...(o.deviceId ? { deviceId: o.deviceId } : {}) })
    return { ok: true, link }
  } catch (e) {
    return { ok: false, error: waErrorMessage(e), notSynced: e instanceof ApiError && e.status === 409 }
  }
}

/** What the cashier sees when the link fails. 409 = the server has not seen the sale yet; 429 waits per Retry-After. */
export function waErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return WA_NOT_SYNCED
    if (e.status === 429) {
      if (!e.retryAfterMs) return 'Terlalu banyak permintaan. Coba lagi nanti.'
      return `Terlalu banyak permintaan. Coba lagi dalam ${Math.max(1, Math.ceil(e.retryAfterMs / 1000))} detik.`
    }
    if (e.status === 0) return WA_OFFLINE
  }
  return e instanceof Error && e.message ? e.message : 'Gagal membuat pesan WhatsApp'
}

/** Opens WhatsApp. Call it synchronously inside the click handler of its own button, never after an await. */
export function openWhatsApp(link: Pick<ReceiptLink, 'waUrl'>, open: (url: string, target: string) => unknown = (u, t) => window.open(u, t)): void {
  open(link.waUrl, '_system')
}
