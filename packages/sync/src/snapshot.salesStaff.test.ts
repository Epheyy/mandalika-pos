import { describe, expect, it } from 'vitest'
import { Snapshot } from './snapshot'
import { stripSnapshotPii, stripSnapshotPiiJson, hasSnapshotPii } from './snapshotPrivacy'
import { controllableKV } from './testFixtures/controllableKV'

const SNAP_KEY = 'mandalika.pos.snapshot'
const fatUsers = [{ id: 'u1', displayName: 'Admin', email: 'a@example.invalid', role: 'owner', permissions: ['x'] }]

describe('snapshot salesStaff and slim users', () => {
  it('salesStaff survives replace and reload', () => {
    const { kv } = controllableKV()
    new Snapshot(kv).replace({ version: 2, products: [], categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [], salesStaff: [{ id: 's1', name: 'Rina' }] })
    expect(new Snapshot(kv).get().salesStaff).toEqual([{ id: 's1', name: 'Rina' }])
  })
  it('stripSnapshotPii keeps only id and displayName of users', () => {
    expect(stripSnapshotPii({ users: fatUsers }).users).toEqual([{ id: 'u1', displayName: 'Admin' }])
  })
  it('hasSnapshotPii flags fat users but not slim ones', () => {
    expect(hasSnapshotPii({ users: fatUsers })).toBe(true)
    expect(hasSnapshotPii({ users: [{ id: 'u1', displayName: 'Admin' }] })).toBe(false)
  })
  it('a user without a displayName keeps just its id', () => {
    expect(stripSnapshotPii({ users: [{ id: 'u2', email: 'b@example.invalid' }] }).users).toEqual([{ id: 'u2' }])
  })
  it('stripSnapshotPiiJson rewrites a stored fat users value', () => {
    const out = stripSnapshotPiiJson(JSON.stringify({ version: 1, users: fatUsers }))
    expect(out).not.toContain('example.invalid')
    expect(JSON.parse(out).users).toEqual([{ id: 'u1', displayName: 'Admin' }])
  })
  it('a snapshot stored with fat users is cleaned on load', () => {
    const { kv } = controllableKV({ [SNAP_KEY]: JSON.stringify({ version: 1, users: fatUsers }) })
    expect(new Snapshot(kv).get().users).toEqual([{ id: 'u1', displayName: 'Admin' }])
    expect(kv.get(SNAP_KEY)).not.toContain('permissions')
    expect(kv.get(SNAP_KEY)).not.toContain('email')
    expect(kv.get(SNAP_KEY)).not.toContain('role')
  })
})
