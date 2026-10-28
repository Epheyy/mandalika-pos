// C4b: TypeScript twin of the Go allocator (backend/internal/service/allocate.go). It spreads an
// order total over its lines so that every line has the `net` share a returned unit is worth.
// Whole rupiah only. The two implementations are held together by the shared golden vectors in
// backend/internal/service/testdata/allocate_golden.json (see allocateNet.golden.test.ts); change
// them together or not at all. Used ONLY for sales that have not synced: a synced order carries the
// server's own netAmount / lineNo / refundGroup / refundedQty, which always win.

/** One sale line as the allocator sees it. `base` = line subtotal as priced; `lineNo` = 0-based index
 *  in the sale payload items and breaks remainder ties (lower first). */
export interface AllocLine {
  lineNo: number
  base: number
}

/** One order-level discount component. `eligible` = array POSITIONS into `lines` (not lineNo values);
 *  null / absent = every line; [] = no line (a no-op, its amount falls through to the residual). */
export interface AllocComponent {
  amount: number
  eligible?: readonly number[] | null
}

export interface AllocInput {
  lines: readonly AllocLine[]
  components: readonly AllocComponent[]
  /** The order total after tax, surcharge, rounding and redeemed points. */
  total: number
}

/** Spread `total` (>= 0) over `weights` (>= 0): floor(total*w/sum) each, leftover units one each to the
 *  largest fractional remainders, ties to the lower lineNo then lower index. A zero weight gets nothing. */
function spreadLargestRemainder(total: number, weights: readonly number[], lines: readonly AllocLine[]): number[] {
  const n = weights.length
  const out = new Array<number>(n).fill(0)
  const sum = weights.reduce((a, b) => a + b, 0)
  if (total <= 0 || sum <= 0) return out
  const bigTotal = BigInt(total)
  const bigSum = BigInt(sum)
  const rems: bigint[] = new Array<bigint>(n).fill(0n)
  let assigned = 0
  weights.forEach((w, i) => {
    if (w === 0) return
    const num = bigTotal * BigInt(w)
    out[i] = Number(num / bigSum)
    rems[i] = num % bigSum
    assigned += out[i]
  })
  const left = total - assigned
  if (left <= 0) return out
  const order = weights.map((_, i) => i).filter((i) => rems[i] > 0n)
  order.sort((a, b) => {
    if (rems[a] !== rems[b]) return rems[a] > rems[b] ? -1 : 1
    if (lines[a].lineNo !== lines[b].lineNo) return lines[a].lineNo - lines[b].lineNo
    return a - b
  })
  for (let k = 0; k < left && k < order.length; k++) out[order[k]] += 1
  return out
}

const isWhole = (v: number): boolean => Number.isSafeInteger(v)

/** Every net >= 0 and Σ net == total, or null when no valid allocation exists (the caller then offers
 *  whole-order refund only). Steps: each component is spread over its eligible lines in proportion to
 *  their current base and subtracted (clamped to the eligible base); then total - Σ(post-discount base)
 *  (tax + surcharge + rounding - redeemed points) is spread over all lines in proportion to the
 *  post-discount base. A line at 0 stays 0. */
export function allocateNet(input: AllocInput): number[] | null {
  const n = input.lines.length
  if (n === 0 || !isWhole(input.total) || input.total < 0) return null
  const cur: number[] = []
  for (const l of input.lines) {
    if (!isWhole(l.base) || l.base < 0) return null
    cur.push(l.base)
  }
  for (const c of input.components) {
    if (!isWhole(c.amount)) return null
    if (c.amount <= 0) continue
    const w = new Array<number>(n).fill(0)
    if (c.eligible == null) {
      cur.forEach((v, i) => { w[i] = v })
    } else {
      for (const idx of c.eligible) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) return null
        w[idx] = cur[idx]
      }
    }
    const sum = w.reduce((a, b) => a + b, 0)
    const amt = Math.min(c.amount, sum)
    if (amt === 0) continue
    spreadLargestRemainder(amt, w, input.lines).forEach((s, i) => { cur[i] -= s })
  }
  const sum = cur.reduce((a, b) => a + b, 0)
  const resid = input.total - sum
  if (resid !== 0) {
    if (sum === 0) return null // nothing to spread over: every line is free
    const mag = Math.abs(resid)
    if (resid < 0 && mag > sum) return null
    spreadLargestRemainder(mag, cur, input.lines).forEach((s, i) => { cur[i] += resid > 0 ? s : -s })
  }
  let check = 0
  for (const v of cur) {
    if (v < 0) return null
    check += v
  }
  return check === input.total ? cur : null
}

/** Cumulative refund value of the first `n` of `qty` units of a line worth `net`: the last unit
 *  settles the exact remainder, earlier units are floored. */
export function refundCum(net: number, qty: number, n: number): number {
  if (qty <= 0 || n <= 0 || net <= 0) return 0
  if (n >= qty) return net
  return Number((BigInt(net) * BigInt(n)) / BigInt(qty))
}

/** What returning `k` more units is worth when `prior` units of the line were already refunded:
 *  cum(prior + k) - cum(prior). Over any split of the units it sums to `net` exactly. */
export function refundAmountForUnits(net: number, qty: number, prior: number, k: number): number {
  return refundCum(net, qty, prior + k) - refundCum(net, qty, prior)
}
