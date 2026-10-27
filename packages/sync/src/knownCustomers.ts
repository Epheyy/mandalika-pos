import type { components } from '@mandalika/api'
import type { KV } from './storage'
import { readJSON, writeJSON } from './storage'
import { normalizePhone } from './phone'

type Customer = components['schemas']['Customer']

export const KNOWN_CUSTOMERS_KEY = 'mandalika.pos.knownCustomers'
/** Least-recently-used customers beyond this many are forgotten (A30, owner decision Q3). */
export const KNOWN_CUSTOMERS_MAX = 300
/** The most customers `recent` ever returns (B3). */
export const RECENT_CUSTOMERS_MAX = 5
/** A customer not used for this long is forgotten (A30, owner decision Q3). */
export const KNOWN_CUSTOMERS_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** What the memory keeps of a customer: just enough to attach one to a sale offline. */
export type KnownCustomerInput = Pick<Customer, 'id' | 'name' | 'phone' | 'points'> & { segment?: Customer['segment'] }

interface Entry {
  id: string
  name: string
  phone: string
  phoneNorm: string
  points: number
  segment?: Customer['segment']
  lastUsedAt: number
}

/**
 * Customers this tablet looked up, selected or created, so a sale to them still works with no
 * connection (A30). It is NOT a customer list: the only way in is `remember`, and the only way
 * out is `findByPhone` with a full phone number (exact normalized match), plus `recent` (B3), which
 * returns at most RECENT_CUSTOMERS_MAX of them for the Pelanggan sheet's "Terakhir dilayani di tablet ini".
 * There is deliberately no method that returns the whole memory. Entries are most-recent-first.
 */
export class KnownCustomers {
  constructor(
    private kv: KV,
    private now: () => number = Date.now,
  ) {}

  #load(): Entry[] {
    const raw = readJSON<unknown>(this.kv, KNOWN_CUSTOMERS_KEY, [])
    if (!Array.isArray(raw)) return []
    const cutoff = this.now() - KNOWN_CUSTOMERS_TTL_MS
    return raw.filter(
      (e): e is Entry =>
        !!e && typeof e.id === 'string' && typeof e.phoneNorm === 'string' && typeof e.lastUsedAt === 'number' && e.lastUsedAt >= cutoff,
    )
  }

  #save(entries: Entry[]): void {
    writeJSON(this.kv, KNOWN_CUSTOMERS_KEY, entries.slice(0, KNOWN_CUSTOMERS_MAX))
  }

  #toEntry(c: KnownCustomerInput, lastUsedAt: number): Entry | null {
    const phoneNorm = normalizePhone(c.phone)
    if (!phoneNorm) return null
    return { id: c.id, name: c.name, phone: c.phone, phoneNorm, points: c.points ?? 0, ...(c.segment ? { segment: c.segment } : {}), lastUsedAt }
  }

  /** Remember (or move to the front) a customer the cashier looked up, selected or created. */
  remember(c: KnownCustomerInput): void {
    const entry = this.#toEntry(c, this.now())
    if (!entry) return
    this.#save([entry, ...this.#load().filter((e) => e.id !== c.id)])
  }

  /** Update name, phone, points and segment of a customer already remembered; never adds one. */
  refresh(c: KnownCustomerInput): void {
    const entries = this.#load()
    const i = entries.findIndex((e) => e.id === c.id)
    if (i < 0) return
    const updated = this.#toEntry(c, entries[i].lastUsedAt)
    if (!updated) return
    entries[i] = updated
    this.#save(entries)
  }

  /** The customers served most recently on this tablet, newest first (B3 "Terakhir dilayani"), never more than
   *  RECENT_CUSTOMERS_MAX whatever `limit` says (the A30 memory is still not listable). */
  recent(limit: number): Customer[] {
    return this.#load()
      .slice(0, Math.max(0, Math.min(limit, RECENT_CUSTOMERS_MAX)))
      .map((e) => ({
        id: e.id,
        name: e.name,
        phone: e.phone,
        points: e.points,
        totalSpent: 0,
        visitCount: 0,
        createdAt: new Date(e.lastUsedAt).toISOString(),
        ...(e.segment ? { segment: e.segment } : {}),
      }))
  }

  /** Remembered customers whose phone equals this one in any format. [] for a non-phone. */
  findByPhone(raw: string): Customer[] {
    const norm = normalizePhone(raw)
    if (!norm) return []
    return this.#load()
      .filter((e) => e.phoneNorm === norm)
      .map((e) => ({
        id: e.id,
        name: e.name,
        phone: e.phone,
        points: e.points,
        totalSpent: 0,
        visitCount: 0,
        createdAt: new Date(e.lastUsedAt).toISOString(),
        ...(e.segment ? { segment: e.segment } : {}),
      }))
  }
}
