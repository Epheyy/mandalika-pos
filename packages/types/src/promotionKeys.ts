/** Exact, case-sensitive composite keys: pid covers all variants; pid|size one.
 * No catalog lookup, trimming or normalization: captured key spelling is retained.
 * Go's internal/promotionkeys uses the same checked-in contract vectors.
 */
export function promotionKeysOverlap(a: string, b: string): boolean {
  const ai = a.indexOf('|'), bi = b.indexOf('|')
  const ap = ai < 0 ? a : a.slice(0, ai), bp = bi < 0 ? b : b.slice(0, bi)
  return ap === bp && (ai < 0 || bi < 0 || a === b)
}

export function promotionKeySetsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some(x => b.some(y => promotionKeysOverlap(x, y)))
}

/** Alternatives within a group are a union; only different groups must be disjoint. */
export function promotionKeyGroupsOverlap(groups: readonly (readonly string[])[]): boolean {
  return groups.some((group, i) => groups.slice(i + 1).some(other => promotionKeySetsOverlap(group, other)))
}

export function promotionHasKeyOverlap(p: {
  type: string
  bundleConfig?: { slots: { productKeys: string[] }[] } | null
  bxgyConfig?: { buyProductIds?: string[] | null; getProductIds?: string[] | null } | null
}): boolean {
  if (p.type === 'bundle') return promotionKeyGroupsOverlap((p.bundleConfig?.slots ?? []).map(s => s.productKeys))
  // Empty get = same-set; empty buy = complement of the get set. Both stay valid.
  if (p.type === 'buy_x_get_y') return promotionKeySetsOverlap(p.bxgyConfig?.buyProductIds ?? [], p.bxgyConfig?.getProductIds ?? [])
  return false
}
