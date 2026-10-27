import { describe, expect, it } from 'vitest'
import { KNOWN_CUSTOMERS_KEY, KNOWN_CUSTOMERS_MAX, KNOWN_CUSTOMERS_TTL_MS, KnownCustomers, RECENT_CUSTOMERS_MAX } from './knownCustomers'
import { controllableKV } from './testFixtures/controllableKV'

// A30: the tablet remembers only customers this device looked up, selected or created, and can
// only find one again by its full phone number. There is deliberately no way to list them.
const DAY = 24 * 60 * 60 * 1000

function cust(n: number, phone = `0812000${String(n).padStart(5, '0')}`) {
  return { id: `c${n}`, name: `Customer ${n}`, phone, points: n }
}

describe('KnownCustomers', () => {
  it('finds a remembered customer by any format of the same phone, exact match only', () => {
    const { kv } = controllableKV()
    const k = new KnownCustomers(kv, () => 1_000)
    k.remember(cust(1, '0812-3456-7890'))

    expect(k.findByPhone('+62 812 3456 7890').map((c) => c.id)).toEqual(['c1'])
    expect(k.findByPhone('081234567890').map((c) => c.id)).toEqual(['c1'])
    expect(k.findByPhone('08123456789')).toEqual([]) // prefix is not a match
    expect(k.findByPhone('0812')).toEqual([])
    expect(k.findByPhone('Customer 1')).toEqual([])
    expect(k.findByPhone('')).toEqual([])
  })

  it('has no full listing API (only a capped recent list, B3)', () => {
    const { kv } = controllableKV()
    const k = new KnownCustomers(kv)
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(k)).filter((m) => m !== 'constructor')
    expect(methods.sort()).toEqual(['findByPhone', 'recent', 'refresh', 'remember'])
  })

  it('persists across instances and stores only the needed fields', () => {
    const { kv } = controllableKV()
    new KnownCustomers(kv, () => 5).remember({
      ...cust(1),
      email: 'a@example.invalid',
      notes: 'secret',
      birthday: '1990-01-01',
    } as never)
    const raw = kv.get(KNOWN_CUSTOMERS_KEY) ?? ''
    expect(raw).not.toContain('a@example.invalid')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('1990')
    expect(new KnownCustomers(kv, () => 6).findByPhone(cust(1).phone)).toHaveLength(1)
  })

  it('keeps at most 300 customers, dropping the least recently used', () => {
    const { kv } = controllableKV()
    let now = 1
    const k = new KnownCustomers(kv, () => now++)
    for (let i = 0; i < KNOWN_CUSTOMERS_MAX + 5; i++) k.remember(cust(i))
    expect(KNOWN_CUSTOMERS_MAX).toBe(300)
    expect(k.findByPhone(cust(0).phone)).toEqual([]) // oldest dropped
    expect(k.findByPhone(cust(4).phone)).toEqual([])
    expect(k.findByPhone(cust(5).phone)).toHaveLength(1)
    expect(k.findByPhone(cust(KNOWN_CUSTOMERS_MAX + 4).phone)).toHaveLength(1)
  })

  it('re-remembering refreshes recency', () => {
    const { kv } = controllableKV()
    let now = 1
    const k = new KnownCustomers(kv, () => now++)
    for (let i = 0; i < KNOWN_CUSTOMERS_MAX; i++) k.remember(cust(i))
    k.remember(cust(0)) // c0 becomes the most recent
    k.remember(cust(KNOWN_CUSTOMERS_MAX)) // evicts c1, the least recent
    expect(k.findByPhone(cust(0).phone)).toHaveLength(1)
    expect(k.findByPhone(cust(1).phone)).toEqual([])
  })

  it('forgets a customer 30 days after last use', () => {
    const { kv } = controllableKV()
    let now = 0
    const k = new KnownCustomers(kv, () => now)
    k.remember(cust(1))
    expect(KNOWN_CUSTOMERS_TTL_MS).toBe(30 * DAY)
    now = 30 * DAY - 1
    expect(k.findByPhone(cust(1).phone)).toHaveLength(1)
    now = 30 * DAY + 1
    expect(k.findByPhone(cust(1).phone)).toEqual([])
    expect(new KnownCustomers(kv, () => now).findByPhone(cust(1).phone)).toEqual([])
  })

  it('refresh updates points of an already remembered customer but never adds one', () => {
    const { kv } = controllableKV()
    const k = new KnownCustomers(kv, () => 1)
    k.remember(cust(1))
    k.refresh({ ...cust(1), points: 99, name: 'Renamed' })
    k.refresh(cust(2))
    expect(k.findByPhone(cust(1).phone)[0]).toMatchObject({ points: 99, name: 'Renamed' })
    expect(k.findByPhone(cust(2).phone)).toEqual([])
  })

  it('ignores a customer whose phone does not normalize', () => {
    const { kv } = controllableKV()
    const k = new KnownCustomers(kv)
    k.remember({ id: 'x', name: 'Bad', phone: 'abc', points: 0 })
    expect(kv.get(KNOWN_CUSTOMERS_KEY)).toBeNull()
  })

  it('survives a corrupt stored value', () => {
    const { kv } = controllableKV({ [KNOWN_CUSTOMERS_KEY]: '{not json' })
    const k = new KnownCustomers(kv)
    expect(k.findByPhone('081200000001')).toEqual([])
    k.remember(cust(1))
    expect(k.findByPhone(cust(1).phone)).toHaveLength(1)
  })

  it('returns Customer-shaped rows the POS can attach', () => {
    const { kv } = controllableKV()
    const k = new KnownCustomers(kv, () => 1_700_000_000_000)
    k.remember({ ...cust(1), segment: { id: 's', name: 'VIP', color: 'gold' } })
    expect(k.findByPhone(cust(1).phone)[0]).toMatchObject({
      id: 'c1', name: 'Customer 1', phone: cust(1).phone, points: 1, totalSpent: 0, visitCount: 0,
      segment: { id: 's', name: 'VIP', color: 'gold' },
    })
  })

  it('recent returns the newest customers first and never more than the cap', () => {
    const { kv } = controllableKV()
    const k = new KnownCustomers(kv, () => 1_000)
    for (let n = 1; n <= 8; n++) k.remember(cust(n))
    k.remember(cust(2)) // used again: moves to the front
    expect(k.recent(50).map((c) => c.id)).toEqual(['c2', 'c8', 'c7', 'c6', 'c5'])
    expect(k.recent(50)).toHaveLength(RECENT_CUSTOMERS_MAX)
    expect(k.recent(2).map((c) => c.id)).toEqual(['c2', 'c8'])
    expect(k.recent(0)).toEqual([])
  })
})
