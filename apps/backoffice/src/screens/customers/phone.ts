import type { Customer } from '@mandalika/api'

/**
 * True when another customer (not `excludeId`) already has this phone.
 * Comparison ignores surrounding whitespace; empty phone is never a dupe.
 */
export function isDuplicatePhone(
  customers: ReadonlyArray<Pick<Customer, 'id' | 'phone'>>,
  phone: string,
  excludeId?: string | null,
): boolean {
  const p = phone.trim()
  if (!p) return false
  return customers.some((c) => c.id !== excludeId && c.phone.trim() === p)
}
