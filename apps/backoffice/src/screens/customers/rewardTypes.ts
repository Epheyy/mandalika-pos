// SP-CRM-8: render product-reward grants. Product names aren't on the grant (it
// stores product ids); SP-CRM-9b entries may be "pid|size" — show the size.
export function rewardGrantSummary(productIds: string[]): string {
  const n = productIds.length
  if (n === 0) return 'Reward produk'
  const sizes = productIds
    .map((e) => e.split('|')[1])
    .filter((s): s is string => !!s)
  if (sizes.length > 0) return `${n} produk gratis (${sizes.join(', ')})`
  return `${n} produk gratis`
}
