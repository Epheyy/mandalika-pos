// Mirror of the server's customerScope (backend/internal/handlers/customerscope.go, A30).
// Admin, or a non-cashier holding manage_customers, may browse customers by name; everyone else
// (cashiers always) can only find one by a full phone number. The server enforces this; the UI
// only decides which search box to show.

export const CUSTOMER_PHONE_HINT = 'Cari dengan nomor telepon lengkap pelanggan.'

export function isPhoneOnlyCustomerLookup(user: { role: string; permissions?: string[] } | null | undefined): boolean {
  if (!user) return true
  if (user.role === 'admin') return false
  if (user.role === 'cashier') return true
  return !(user.permissions ?? []).includes('manage_customers')
}

/** True when the text looks like a full phone number (same validity as the shared normalizer:
 *  optional leading +, digits only after stripping space - . ( ), at least 8 digits). */
function looksLikePhone(text: string): boolean {
  const s = text.trim().replace(/[ \-.()]/g, '').replace(/^\+/, '')
  return /^[0-9]{8,}$/.test(s)
}

/**
 * What to look up for the discount-code customer box, or '' for nothing. A phone-only lookup spends
 * the shared per-account budget, so it runs only for the text the user explicitly submitted
 * (Enter / Cari); customer readers keep the live typeahead on the trimmed typed text.
 */
export function customerLookupTerm(phoneOnly: boolean, typed: string, submitted: string): string {
  if (!phoneOnly) return typed.trim()
  return looksLikePhone(submitted) ? submitted.trim() : ''
}
