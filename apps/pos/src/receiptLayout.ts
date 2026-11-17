// Which receipt layout this tablet prints, and the extras a designer layout reads.
//
// The pull ships the outlet's template (or none). With none, or one this build cannot trust, the tablet
// prints Standar built from `appSettings.receipt`, which is byte-identical to the receipt before the designer.

import type { components } from '@mandalika/api'
import { layoutFromApi, standarLayout, type PaperWidth, type ReceiptData, type ReceiptLayout } from '@mandalika/printer'
import { getKV, type KV } from '@mandalika/sync'

type ReceiptSettings = components['schemas']['ReceiptSettings']
type Bundle = components['schemas']['SyncPullBundle']

/** A tablet assumes a 58mm printer until its `Lebar kertas` setting says otherwise. A wider template reflows to it. */
export const DEVICE_PAPER_WIDTH_DEFAULT: PaperWidth = 58

export const PAPER_WIDTH_KEY = 'mandalika.pos.printerPaperWidth'
export const GRAPHICS_KEY = 'mandalika.pos.printerGraphics'

/** This tablet's printer paper width (`Lebar kertas`): '80' means 80mm, anything else 58mm. */
export function devicePaperWidth(kv: Pick<KV, 'get'> = getKV()): PaperWidth {
  return kv.get(PAPER_WIDTH_KEY) === '80' ? 80 : DEVICE_PAPER_WIDTH_DEFAULT
}

/** Whether this tablet's printer takes raster images and QR codes (`Cetak logo & QR`). On unless switched off:
 *  raster and QR support cannot be detected over Bluetooth, so the cashier decides after a test print. */
export function deviceGraphics(kv: Pick<KV, 'get'> = getKV()): boolean {
  return kv.get(GRAPHICS_KEY) !== 'off'
}

export function setDevicePaperWidth(width: PaperWidth, kv: Pick<KV, 'set'> = getKV()): void {
  kv.set(PAPER_WIDTH_KEY, String(width))
}

export function setDeviceGraphics(on: boolean, kv: Pick<KV, 'set'> = getKV()): void {
  kv.set(GRAPHICS_KEY, on ? 'on' : 'off')
}

/** What one Tes Cetak tap prints: the draft the Backoffice sent to this outlet (online, within 60 minutes), else the
 *  outlet's own layout. A draft is used for that one print only: never stored, never used for a sale, so a newer
 *  saved template always wins at the till. */
export async function chooseTestPrintLayout(
  getDraft: () => Promise<Bundle['receiptTemplate'] | null>,
  template: Bundle['receiptTemplate'],
  receipt: ReceiptSettings,
): Promise<{ layout: ReceiptLayout; fromDraft: boolean }> {
  let draft: Bundle['receiptTemplate'] | null = null
  try {
    draft = await getDraft()
  } catch {
    draft = null // offline or the server is older: print the outlet's layout
  }
  const layout = (draft ? layoutFromApi(draft) : null) ?? resolveReceiptLayout(template, receipt)
  // Every Tes Cetak slip says so at the top, so the sample sale can never pass for a real paid receipt.
  const banner = { id: 'cetak-tes', type: 'text' as const, enabled: true, text: '*** CETAK TES ***', align: 'center' as const, bold: true, size: 'normal' as const }
  return { layout: { ...layout, blocks: [banner, ...layout.blocks] }, fromDraft: draft !== null && layoutFromApi(draft) !== null }
}

/** The pulled template as a layout, or Standar when there is none or it fails the locked-block rules. */
export function resolveReceiptLayout(template: Bundle['receiptTemplate'], receipt: ReceiptSettings): ReceiptLayout {
  return layoutFromApi(template) ?? standarLayout(receipt)
}

/** The outlet details the header block prints, from the last pull. */
export function receiptOutlet(snapshot: Pick<Bundle, 'outletName' | 'outletAddress' | 'outletPhone'>): NonNullable<ReceiptData['outlet']> {
  return { name: snapshot.outletName ?? '', address: snapshot.outletAddress ?? null, phone: snapshot.outletPhone ?? null }
}

/** Estimated member points for the LIVE sale only: loyalty on and a customer attached. The server grants the
 *  real points, so the block words these as estimates. A reprint never carries them. */
export function receiptPoints(
  loyaltyEnabled: boolean,
  customerPoints: number | null | undefined,
  derived: { earnedPoints: number; redeemedPoints: number },
): ReceiptData['points'] | undefined {
  if (!loyaltyEnabled || customerPoints === undefined || customerPoints === null) return undefined
  return { earned: derived.earnedPoints, balance: customerPoints - derived.redeemedPoints + derived.earnedPoints }
}
