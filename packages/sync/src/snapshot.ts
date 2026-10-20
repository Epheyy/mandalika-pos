import type { components } from '@mandalika/api'
import type { KV } from './storage'
import { readJSON, writeJSON } from './storage'
import { hasSnapshotPii, stripSnapshotPii } from './snapshotPrivacy'

const SNAP_KEY = 'mandalika.pos.snapshot'
const VERSION_KEY = 'mandalika.pos.contentVersion'
/** A15 phase B: the outlet the stored snapshot (and its stockSeq) was pulled for. Absent = unbound. */
export const PULLED_FOR_OUTLET_KEY = 'mandalika.pos.pulledForOutlet'

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
    // A30: tablets must not keep a browsable customer list or discount-code holder names. One-time
    // purge of a bundle stored by older code: rewrite it clean, and never copy the old list anywhere.
    if (hasSnapshotPii(stored as Record<string, unknown>)) {
      this.data = stripSnapshotPii(stored)
      writeJSON(kv, SNAP_KEY, this.data)
    } else {
      this.data = stored
    }
  }

  /** Atomically swap the whole snapshot in (Resync) and record its version. Customers and
   *  discount-code holder names are never stored (A30), even if an older server still sends them.
   *  `boundOutlet`: the outlet this pull was made for; stored beside the snapshot only when the bundle carries
   *  a stockSeq. The binding is cleared first and set last, so a partial write leaves the seq rules off. */
  replace(incoming: Bundle, boundOutlet?: string): void {
    const bundle: Bundle = stripSnapshotPii(incoming)
    this.kv.remove(PULLED_FOR_OUTLET_KEY)
    this.data = bundle
    writeJSON(this.kv, SNAP_KEY, bundle)
    this.kv.set(VERSION_KEY, String(bundle.version ?? 0))
    if (boundOutlet && typeof bundle.stockSeq === 'number') this.kv.set(PULLED_FOR_OUTLET_KEY, boundOutlet)
  }

  /** The outlet the stored snapshot was pulled for (undefined = unknown, e.g. stored by older code). */
  pulledForOutlet(): string | undefined {
    return this.kv.get(PULLED_FOR_OUTLET_KEY) || undefined
  }

  /** The outlet stock counter the stored snapshot covers; undefined = no signal (never 0 by default). */
  localStockSeq(): number | undefined {
    const n = this.data.stockSeq
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined
  }

  get(): Bundle {
    return this.data
  }

  localVersion(): number {
    return Number(this.kv.get(VERSION_KEY) ?? this.data.version ?? 0)
  }
}
