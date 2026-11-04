import { describe, expect, it } from 'vitest'
import { ApiError } from '@mandalika/api'
import { LOOKUP_BUSY_MESSAGE, awaitingSearch, finderHits, lookupFailureMessage, newCustomerProblem, formatPoints, phoneHint, prefillFromSearch } from './customerFinder'

const alice = { id: 'a', name: 'Alice', phone: '0812-3456-7890', points: 3, totalSpent: 0, visitCount: 0, createdAt: '2026-01-01T00:00:00Z' }
const budi = { id: 'b', name: 'Budi', phone: '081200000002', points: 0, totalSpent: 0, visitCount: 0, createdAt: '2026-01-01T00:00:00Z' }

describe('finderHits', () => {
  it('shows nothing for a name or a partial number', () => {
    expect(finderHits('Alice', [alice], [alice], [alice])).toEqual([])
    expect(finderHits('0812', [alice], [alice], [alice])).toEqual([])
    expect(finderHits('', [alice], [alice], [alice])).toEqual([])
  })

  it('matches the full phone in any format against every source and dedupes by id', () => {
    const hits = finderHits('+62 812 3456 7890', [alice], [{ ...alice, points: 9 }], [alice])
    expect(hits.map((c) => c.id)).toEqual(['a'])
    expect(hits[0].points).toBe(9) // the online row is the freshest and wins
  })

  it('drops a stale result that belongs to a previous query', () => {
    expect(finderHits('081200000002', [], [], [alice, budi]).map((c) => c.id)).toEqual(['b'])
  })

  it('shows at most 3 customers (soft duplicates of one phone)', () => {
    const dups = ['1', '2', '3', '4'].map((i) => ({ ...budi, id: `d${i}`, name: `Dup ${i}` }))
    expect(finderHits('081200000002', [], [], dups)).toHaveLength(3)
  })
})

describe('lookupFailureMessage', () => {
  it('turns the 429 into a clear Indonesian message', () => {
    expect(lookupFailureMessage(new ApiError(429, 'x'))).toBe(LOOKUP_BUSY_MESSAGE)
    expect(LOOKUP_BUSY_MESSAGE).toContain('coba lagi sebentar')
  })
  it('stays quiet for other failures (offline or server errors fall back to the tablet memory)', () => {
    expect(lookupFailureMessage(new ApiError(0, 'net', 'network'))).toBeNull()
    expect(lookupFailureMessage(new ApiError(500, 'boom'))).toBeNull()
    expect(lookupFailureMessage(new Error('x'))).toBeNull()
  })
})

describe('phoneHint', () => {
  it('asks for the full number while the input is not a phone yet', () => {
    expect(phoneHint('')).toBeNull()
    expect(phoneHint('Ali')).toContain('nomor telepon')
    expect(phoneHint('0812')).toContain('nomor telepon')
    expect(phoneHint('081234567890')).toBeNull()
  })
})

describe('prefillFromSearch', () => {
  it('prefills the phone only, never a name', () => {
    expect(prefillFromSearch('0812 3456-7890')).toEqual({ name: '', phone: '081234567890', email: '' })
    expect(prefillFromSearch('+62 812 3456 7890').phone).toBe('+6281234567890')
    expect(prefillFromSearch('Alice').name).toBe('')
  })
})

describe('awaitingSearch', () => {
  it('waits for an explicit search online until the typed phone has been submitted', () => {
    expect(awaitingSearch('081299998888', true, null)).toBe(true)
    expect(awaitingSearch('081299998888', true, '081299997777')).toBe(true)
    expect(awaitingSearch('081299998888', true, '+62 812 9999 8888')).toBe(false)
  })
  it('never waits offline or while the text is not a phone', () => {
    expect(awaitingSearch('081299998888', false, null)).toBe(false)
    expect(awaitingSearch('0812', true, null)).toBe(false)
    expect(awaitingSearch('', true, null)).toBe(false)
  })
})

describe('newCustomerProblem', () => {
  const ok = { name: 'Sari', phone: '0812-3456-7890', email: '' }
  it('accepts a valid customer, Indonesian or foreign, with or without email', () => {
    expect(newCustomerProblem(ok)).toBeNull()
    expect(newCustomerProblem({ ...ok, phone: '+65 8123 4567', email: 'a@b.co' })).toBeNull()
  })
  it('names the first problem in Indonesian', () => {
    expect(newCustomerProblem({ ...ok, name: ' ' })).toBe('Nama wajib diisi')
    expect(newCustomerProblem({ ...ok, phone: '' })).toBe('Nomor telepon wajib diisi')
    expect(newCustomerProblem({ ...ok, phone: 'abc123' })).toBe('Nomor telepon tidak valid')
    expect(newCustomerProblem({ ...ok, email: 'bukan-email' })).toBe('Format email tidak valid')
  })
})

describe('formatPoints', () => {
  it('uses id-ID thousands separators', () => {
    expect(formatPoints(0)).toBe('0')
    expect(formatPoints(1250)).toBe('1.250')
    expect(formatPoints(1234567)).toBe('1.234.567')
  })
})
