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
