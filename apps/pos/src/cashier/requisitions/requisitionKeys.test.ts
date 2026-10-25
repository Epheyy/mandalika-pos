import { describe, expect, it } from 'vitest'
import { controllableKV } from '../../../../../packages/sync/src/testFixtures/controllableKV'
import { createRequisitionKeys, pendingCreateStorageKey } from './requisitionKeys'

const scope = { userId: 'u1', outletId: 'o1' }
const form = { lines: [{ productId: 'p' }], note: 'n' }

describe('requisitionKeys', () => {
  it('create: same signature gives the same key across a new store on the same KV (an app restart)', async () => {
    const { kv } = controllableKV()
    const k1 = await createRequisitionKeys(kv, scope).createKey('sig-a', form)
    const restarted = createRequisitionKeys(kv, scope)
    expect(await restarted.createKey('sig-a', form)).toBe(k1)
    expect(restarted.loadPendingCreate()).toEqual({ sig: 'sig-a', key: k1, form })
  })

  it('create: changed content mints a new key', async () => {
    const { kv } = controllableKV()
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.createKey('sig-a', form)
    const b = await keys.createKey('sig-b', form)
    expect(b).not.toBe(a)
    expect(createRequisitionKeys(kv, scope).loadPendingCreate()?.sig).toBe('sig-b')
  })

  it('create: cleared on success, so the next create is a new document with a new key', async () => {
    const { kv } = controllableKV()
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.createKey('sig-a', form)
    await keys.clearPendingCreate()
    expect(kv.get(pendingCreateStorageKey(scope))).toBeNull()
    expect(createRequisitionKeys(kv, scope).loadPendingCreate()).toBeNull()
    expect(await keys.createKey('sig-a', form)).not.toBe(a)
  })

  it('create: scoped by user and outlet', async () => {
    const { kv } = controllableKV()
    const a = await createRequisitionKeys(kv, scope).createKey('sig', form)
    const otherUser = createRequisitionKeys(kv, { userId: 'u2', outletId: 'o1' })
    const otherOutlet = createRequisitionKeys(kv, { userId: 'u1', outletId: 'o2' })
    expect(otherUser.loadPendingCreate()).toBeNull()
    expect(otherOutlet.loadPendingCreate()).toBeNull()
    expect(await otherUser.createKey('sig', form)).not.toBe(a)
    expect(await otherOutlet.createKey('sig', form)).not.toBe(a)
  })

  it('create: a corrupt persisted value is ignored', async () => {
    const { kv } = controllableKV({ [pendingCreateStorageKey(scope)]: '{not json' })
    const keys = createRequisitionKeys(kv, scope)
    expect(keys.loadPendingCreate()).toBeNull()
    expect(await keys.createKey('s', form)).toBeTruthy()
  })

  it('create: renewCreateKey replaces the key for the same signature (409 key conflict)', async () => {
    const { kv } = controllableKV()
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.createKey('s', form)
    const b = await keys.renewCreateKey('s', form)
    expect(b).not.toBe(a)
    expect(await createRequisitionKeys(kv, scope).createKey('s', form)).toBe(b)
  })

  it('create: a failing durable write does not block; the key is still reused in memory', async () => {
    const { kv, ctl } = controllableKV()
    ctl.mode = 'reject'
    const keys = createRequisitionKeys(kv, scope)
    const a = await keys.createKey('s', form)
    expect(await keys.createKey('s', form)).toBe(a)
  })

  it('update/submit/cancel: stable per (op, doc, signature), new on edit, new after forget, separate per op and doc', () => {
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

  it('update/submit/cancel keys are not persisted (a restart mints fresh ones)', () => {
    const { kv } = controllableKV()
    const a = createRequisitionKeys(kv, scope).keyFor('submit', 'r1', 's')
    expect(createRequisitionKeys(kv, scope).keyFor('submit', 'r1', 's')).not.toBe(a)
  })
})
