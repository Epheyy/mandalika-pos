// A30: the tablet must not keep a browsable customer list, nor which customer a discount code
// belongs to. These helpers drop that from a stored or incoming pull bundle. They keep every other
// field (including discountCodes[].customerId, which the POS wrong_customer rule needs).
// A08: also receiveApprovers, which used to carry receive-PIN hashes; the server now ships none and
// approvers are fetched online, so the stored list is forced empty.
// Tim Sales: users keep only {id, displayName} (owner label); email/role/permissions of other accounts are dropped.

type Loose = Record<string, unknown>

/** True when the bundle carries a customer list, a discount-code holder name or receive approvers (hashes). */
export function hasSnapshotPii(bundle: Loose): boolean {
  if (Array.isArray(bundle.receiveApprovers) && bundle.receiveApprovers.length > 0) return true
  if (Array.isArray(bundle.customers) && bundle.customers.length > 0) return true
  if (Array.isArray(bundle.users) && bundle.users.some(isFatUser)) return true
  return Array.isArray(bundle.discountCodes) && bundle.discountCodes.some((c) => !!c && typeof c === 'object' && 'customerName' in c)
}

/** A users entry carrying anything beyond id and displayName. */
function isFatUser(u: unknown): boolean {
  return !!u && typeof u === 'object' && Object.keys(u).some((k) => k !== 'id' && k !== 'displayName')
}

/** A copy of the bundle with customers [], receiveApprovers [], slim users and no discount-code customerName. */
export function stripSnapshotPii<T extends Loose>(bundle: T): T {
  const out: Loose = { ...bundle, customers: [], receiveApprovers: [] }
  if (Array.isArray(bundle.discountCodes)) {
    out.discountCodes = bundle.discountCodes.map((c) => {
      if (!c || typeof c !== 'object') return c
      const { customerName: _dropped, ...rest } = c as Loose
      void _dropped
      return rest
    })
  }
  if (Array.isArray(bundle.users)) {
    out.users = bundle.users.map((u) => {
      if (!u || typeof u !== 'object') return u
      const { id, displayName } = u as Loose
      return displayName === undefined ? { id } : { id, displayName }
    })
  }
  return out as T
}

/** Same for a stored JSON value; anything unparseable or already clean is returned unchanged. */
export function stripSnapshotPiiJson(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    if (!hasSnapshotPii(parsed as Loose)) return raw
    return JSON.stringify(stripSnapshotPii(parsed as Loose))
  } catch {
    return raw
  }
}
