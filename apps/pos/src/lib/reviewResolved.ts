/** Toast after head office resolved review items and they left this tablet. */
export function reviewResolvedMessage(items: readonly { note: string }[]): string {
  return `${items.length} item diselesaikan oleh kantor pusat: ${items[0]?.note ?? ''}`
}
