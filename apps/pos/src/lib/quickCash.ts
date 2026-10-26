const STEPS = [50_000, 100_000, 500_000] as const
const ONE_MILLION = 1_000_000
const MAX_CHIPS = 5

/** Quick-cash tender chips: the exact total first ("Uang Pas"), then the next multiples of 50k, 100k and 500k
 *  strictly above it, then 1 000 000 when above the total. De-duplicated, at most five. */
export function quickCashAmounts(total: number): number[] {
  const out = [total, ...STEPS.map((m) => (Math.floor(total / m) + 1) * m)]
  if (ONE_MILLION > total) out.push(ONE_MILLION)
  return out.filter((v, i, a) => a.indexOf(v) === i).slice(0, MAX_CHIPS)
}
