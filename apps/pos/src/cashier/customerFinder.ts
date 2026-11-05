import { ApiError } from '@mandalika/api'
import type { components } from '@mandalika/api'
import { KnownCustomers, getKV, normalizePhone } from '@mandalika/sync'
import { emailProblem, phoneProblem } from '@mandalika/types'

type Customer = components['schemas']['Customer']

// A30: the cashier finds a customer by full phone number only. This module holds the pure rules
// so the picker and CashierScreen stay thin.

/** At most this many customers are shown (soft duplicates of one phone). */
export const FINDER_MAX_HITS = 3

/** Shown when the server's per-account lookup budget is spent (HTTP 429). */
export const LOOKUP_BUSY_MESSAGE = 'Terlalu banyak pencarian, coba lagi sebentar.'

/**
 * Customers to offer for what the cashier typed: only those whose phone equals the typed phone
 * (any format), so a stale online result for an earlier query can never show. Online rows win
 * over this session's creations, which win over the tablet memory (freshest points first).
 */
export function finderHits(search: string, known: Customer[], online: Customer[], local: Customer[]): Customer[] {
  const norm = normalizePhone(search)
  if (!norm) return []
  const seen = new Set<string>()
  const hits: Customer[] = []
  for (const c of [...online, ...local, ...known]) {
    if (seen.has(c.id) || normalizePhone(c.phone) !== norm) continue
    seen.add(c.id)
    hits.push(c)
  }
  return hits.slice(0, FINDER_MAX_HITS)
}

/** A cashier-facing message for a failed lookup, or null to stay quiet (offline / server error:
 *  the tablet memory and "add new" still work). */
export function lookupFailureMessage(err: unknown): string | null {
  return err instanceof ApiError && err.status === 429 ? LOOKUP_BUSY_MESSAGE : null
}

/** Guidance while what was typed is not yet a full phone number. */
export function phoneHint(search: string): string | null {
  const q = search.trim()
  if (!q || normalizePhone(q)) return null
  return 'Ketik nomor telepon lengkap pelanggan (minimal 8 digit).'
}

/**
 * True while the cashier has typed a full phone but not yet searched for it online. Lookups are
 * explicit (Cari / Enter) so typing never spends the shared budget; until then "add new" is not
 * offered, so an unsearched number cannot become a duplicate. Offline there is nothing to wait for.
 */
export function awaitingSearch(search: string, online: boolean, requested: string | null): boolean {
  const norm = normalizePhone(search)
  if (!online || !norm) return false
  return requested === null || normalizePhone(requested) !== norm
}

/** Add-new prefill from the search box: the phone only, never a name. */
export function prefillFromSearch(q: string): { name: string; phone: string; email: string } {
  const isPhone = /^[+0-9][0-9\s-]*$/.test(q)
  return { name: '', phone: isPhone ? q.replace(/[\s-]/g, '') : '', email: '' }
}

let known: KnownCustomers | null = null
/** The tablet's customer memory, on the same (secure) KV the engine uses. */
export function getKnownCustomers(): KnownCustomers {
  known ??= new KnownCustomers(getKV())
  return known
}

/** Loyalty points with Indonesian thousands separators (12.500), never a raw number. */
const POINTS_FORMAT = new Intl.NumberFormat('id-ID')
export function formatPoints(points: number): string {
  return POINTS_FORMAT.format(points)
}

/** Why the "+ Baru" customer cannot be saved, or null. Same phone/email rules as the backoffice and the server. */
export function newCustomerProblem(form: { name: string; phone: string; email: string }): string | null {
  if (!form.name.trim()) return 'Nama wajib diisi'
  return phoneProblem(form.phone) ?? emailProblem(form.email)
}
