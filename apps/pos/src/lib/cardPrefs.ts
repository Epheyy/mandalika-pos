/** Read a product-card display preference. A missing key (or unreadable storage) means `defaultOn`; an explicit '1' is on and anything else stored (the toggle writes '0') is off. */
export function readCardPref(key: string, defaultOn: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return defaultOn
    return raw === '1'
  } catch {
    return defaultOn
  }
}
