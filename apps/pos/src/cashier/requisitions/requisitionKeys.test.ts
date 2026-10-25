import { describe, expect, it } from 'vitest'
import type { StockRequisitionInput } from '@mandalika/api'
import { controllableKV } from '../../../../../packages/sync/src/testFixtures/controllableKV'
import { createRequisitionKeys, pendingCreateStorageKey } from './requisitionKeys'

const scope = { userId: 'u1', outletId: 'o1' }
const form = { lines: [{ productId: 'p' }], note: 'n' }
const input = (qty: number): StockRequisitionInput => ({ items: [{ productId: 'p', variantSize: 'M', requestedQty: qty }] })

describe('requisitionKeys: pending create', () => {
  it('same signature gives the same key across a new store on the same KV (an app restart), and the record is unconfirmed', async () => {
    const { kv } = controllableKV()
    const k1 = await createRequisitionKeys(kv, scope).beginCreate('sig-a', input(1), form)
    const restarted = createRequisitionKeys(kv, scope)
    expect(restarted.loadPendingCreate()).toEqual({ sig: 'sig-a', key: k1, input: input(1), form, sent: true })
    expect(await restarted.beginCreate('sig-a', input(1), form)).toBe(k1)
  })

  it('changed content mints a new key and replaces the record', async () => {
    const { kv } = controllableKV()
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.beginCreate('sig-a', input(1), form)
    const b = await keys.beginCreate('sig-b', input(2), form)
    expect(b).not.toBe(a)
    expect(createRequisitionKeys(kv, scope).loadPendingCreate()).toMatchObject({ sig: 'sig-b', input: input(2) })
  })

  it('cleared on success: nothing survives a restart and the next create gets a new key', async () => {
    const { kv } = controllableKV()
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.beginCreate('sig-a', input(1), form)
    await keys.clearPendingCreate()
    expect(kv.get(pendingCreateStorageKey(scope))).toBeNull()
    expect(keys.loadPendingCreate()).toBeNull()
    expect(createRequisitionKeys(kv, scope).loadPendingCreate()).toBeNull()
    expect(await keys.beginCreate('sig-a', input(1), form)).not.toBe(a)
  })

  it('markCreateUnsent keeps the form and key but drops the "may exist" flag, also across a restart', async () => {
    const { kv } = controllableKV()
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.beginCreate('sig-a', input(1), form)
    await keys.markCreateUnsent()
    expect(keys.loadPendingCreate()).toMatchObject({ key: a, sent: false, form })
    expect(createRequisitionKeys(kv, scope).loadPendingCreate()).toMatchObject({ key: a, sent: false })
  })

  it('scoped by user and outlet', async () => {
    const { kv } = controllableKV()
    const a = await createRequisitionKeys(kv, scope).beginCreate('sig', input(1), form)
    const otherUser = createRequisitionKeys(kv, { userId: 'u2', outletId: 'o1' })
    const otherOutlet = createRequisitionKeys(kv, { userId: 'u1', outletId: 'o2' })
    expect(otherUser.loadPendingCreate()).toBeNull()
    expect(otherOutlet.loadPendingCreate()).toBeNull()
    expect(await otherUser.beginCreate('sig', input(1), form)).not.toBe(a)
    expect(await otherOutlet.beginCreate('sig', input(1), form)).not.toBe(a)
  })

  it('a corrupt or old-shape persisted value is ignored', async () => {
    for (const raw of ['{not json', JSON.stringify({ sig: 's', key: 'k' })]) {
      const { kv } = controllableKV({ [pendingCreateStorageKey(scope)]: raw })
      const keys = createRequisitionKeys(kv, scope)
      expect(keys.loadPendingCreate()).toBeNull()
      expect(await keys.beginCreate('s', input(1), form)).toBeTruthy()
    }
  })

  it('a failing durable write does not block; the record and key are still held in memory', async () => {
    const { kv, ctl } = controllableKV()
    ctl.mode = 'reject'
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.beginCreate('s', input(1), form)
    expect(keys.loadPendingCreate()).toMatchObject({ key: a, sent: true })
    expect(await keys.beginCreate('s', input(1), form)).toBe(a)
  })
})

describe('requisitionKeys: update / submit / cancel', () => {
  it('stable per (op, doc, signature), new on edit, new after forget, separate per op and doc', () => {
    const { kv } = controllableKV()
    const keys = createRequisitionKeys(kv, scope)
    const a = keys.keyFor('submit', 'r1', 's')
    expect(keys.keyFor('submit', 'r1', 's')).toBe(a)
    expect(keys.keyFor('submit', 'r1', 's2')).not.toBe(a)
    expect(keys.keyFor('cancel', 'r1', 's')).not.toBe(a)
    expect(keys.keyFor('submit', 'r2', 's')).not.toBe(a)
    const b = keys.keyFor('update', 'r1', 'x')
    keys.forget('update', 'r1')
    expect(keys.keyFor('update', 'r1', 'x')).not.toBe(b)
  })

  it('are not persisted (a restart mints fresh ones)', () => {
    const { kv } = controllableKV()
    const a = createRequisitionKeys(kv, scope).keyFor('submit', 'r1', 's')
    expect(createRequisitionKeys(kv, scope).keyFor('submit', 'r1', 's')).not.toBe(a)
  })
})
