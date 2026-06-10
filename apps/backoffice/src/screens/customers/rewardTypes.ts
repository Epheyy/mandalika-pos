// SP-CRM-8: render product-reward grants. Product names aren't on the grant (it
// stores product IDs); show the count + ids until a future slice joins names.
export function rewardGrantSummary(productIds: string[]): string {
  const n = productIds.length
  if (n === 0) return 'Reward produk'
  return `${n} produk gratis`
}
