import type { components } from '@mandalika/api'
import type { KV } from './storage'
import { readJSON, writeJSON } from './storage'

const SNAP_KEY = 'mandalika.pos.snapshot'
const VERSION_KEY = 'mandalika.pos.contentVersion'

type Bundle = components['schemas']['SyncPullBundle']

const EMPTY: Bundle = {
  version: 0,
  products: [],
  categories: [],
  bundles: [],
  customers: [],
  promotions: [],
  discountCodes: [],
  loyaltyConditions: [],
}

// Read-only local snapshot of reference data needed to sell offline. POS never
// edits this — single-writer (Backoffice) keeps it conflict-free (plan §5a).
export class Snapshot {
  private data: Bundle

  constructor(private kv: KV) {
    const stored = readJSON<Bundle>(kv, SNAP_KEY, EMPTY)
    // A30: tablets must not keep a browsable customer list. One-time purge of a bundle stored
    // by older code: rewrite it with none, and never copy the old list anywhere else.
    if (Array.isArray(stored.customers) && stored.customers.length > 0) {
      this.data = { ...stored, customers: [] }
      writeJSON(kv, SNAP_KEY, this.data)
    } else {
      this.data = stored
    }
  }

  /** Atomically swap the whole snapshot in (Resync) and record its version. Customers are never
   *  stored (A30), even if an older server still sends them. */
  replace(incoming: Bundle): void {
    const bundle: Bundle = { ...incoming, customers: [] }
    this.data = bundle
    writeJSON(this.kv, SNAP_KEY, bundle)
    this.kv.set(VERSION_KEY, String(bundle.version ?? 0))
  }

  get(): Bundle {
    return this.data
  }

  localVersion(): number {
    return Number(this.kv.get(VERSION_KEY) ?? this.data.version ?? 0)
  }
}
