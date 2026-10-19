import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { Snapshot } from './snapshot'
import { applyCredits } from './pendingCredits'
import { controllableKV } from './testFixtures/controllableKV'

type Bundle = components['schemas']['SyncPullBundle']

// A28: the POS reads the outlet clock from getSnapshot().outletTimezone. The bundle is stored
// whole, so the field must survive replace -> reload from storage -> the credited view.
describe('outletTimezone in the persisted snapshot', () => {
  it('survives a reload from storage', () => {
    const { kv } = controllableKV()
    new Snapshot(kv).replace({ version: 3, outletCode: 'MKS', outletTimezone: 'Asia/Makassar' } as Bundle)
    expect(new Snapshot(kv).get().outletTimezone).toBe('Asia/Makassar')
  })
  it('is absent (not defaulted) for a bundle from an older server', () => {
    const { kv } = controllableKV()
    new Snapshot(kv).replace({ version: 3, outletCode: 'JKT' } as Bundle)
    expect(new Snapshot(kv).get().outletTimezone).toBeUndefined()
  })
  it('is kept by the optimistic-credit view', () => {
    const bundle = { version: 1, outletTimezone: 'Asia/Jayapura', products: [] } as unknown as Bundle
    const view = applyCredits(bundle, [{ lines: [{ productId: 'p', variantSize: 'M', qty: 1 }] } as never])
    expect(view.outletTimezone).toBe('Asia/Jayapura')
  })
})
