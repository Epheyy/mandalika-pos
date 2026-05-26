/**
 * SP4 D3: pure mapper. Takes the completed Transfer snapshot (from the sync
 * ack) + the cashier display name and produces the TandaTerimaData payload
 * the printer consumes.
 */

import type { components } from '@mandalika/api'
import type { TandaTerimaData } from '@mandalika/printer'

type Transfer = components['schemas']['Transfer']

export function buildTandaTerimaData(t: Transfer, receivedByName: string): TandaTerimaData {
  const lh = t.receiverLetterhead
  const head: string[] = []
  head.push(lh?.brandName ?? lh?.locationName ?? t.dest.name ?? '')
  for (const a of lh?.addressLines ?? []) {
    if (a && a.trim()) head.push(a)
  }
  if (lh?.phone) head.push(lh.phone)

  return {
    tandaTerimaNo: t.tandaTerimaNo ?? '',
    transferNo: t.transferNo,
    receivedAt: new Date(t.receivedAt ?? Date.now()),
    receiverHeaderLines: head,
    senderName: t.source.name ?? '',
    items: t.items.map((it) => ({
      productName: it.productName,
      variant: it.variantSize,
      sentQty: it.sentQty,
      receivedQty: it.receivedQty ?? it.sentQty,
      difference: it.difference ?? 0,
    })),
    discrepancyReason:
      t.discrepancyReason && t.discrepancyReason.trim() ? t.discrepancyReason : null,
    receivedByName,
  }
}
