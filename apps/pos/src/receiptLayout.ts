// Which receipt layout this tablet prints, and the extras a designer layout reads.
//
// The pull ships the outlet's template (or none). With none, or one this build cannot trust, the tablet
// prints Standar built from `appSettings.receipt`, which is byte-identical to the receipt before the designer.

import type { components } from '@mandalika/api'
import { layoutFromApi, standarLayout, type PaperWidth, type ReceiptData, type ReceiptLayout } from '@mandalika/printer'

type ReceiptSettings = components['schemas']['ReceiptSettings']
type Bundle = components['schemas']['SyncPullBundle']

/** Every tablet assumes a 58mm printer until Phase 4 adds the per-device setting. A wider template reflows to it. */
export const DEVICE_PAPER_WIDTH_DEFAULT: PaperWidth = 58

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
