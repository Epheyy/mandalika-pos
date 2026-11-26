import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@mandalika/api'
import { lookupCrossOutlet, lookupErrorMessage, lookupQuery } from './crossOutletLookup'

describe('lookupQuery', () => {
  it('reads digits and phone punctuation as a phone', () => {
    expect(lookupQuery('0812-3456 789')).toEqual({ phone: '0812-3456 789' })
    expect(lookupQuery(' +62 (812) 345 ')).toEqual({ phone: '+62 (812) 345' })
  })
  it('reads anything else as an order number', () => {
    expect(lookupQuery('LWB-0042')).toEqual({ orderNumber: 'LWB-0042' })
    expect(lookupQuery('ord 12')).toEqual({ orderNumber: 'ord 12' })
  })
  it('returns null for blank input and for punctuation without digits', () => {
    expect(lookupQuery('   ')).toBeNull()
    expect(lookupQuery('---')).toEqual({ orderNumber: '---' })
  })
})

describe('lookupCrossOutlet', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the explicit param and never writes a cache key (A30)', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: vi.fn() })
    const crossOutletLookup = vi.fn().mockResolvedValue([])
    await lookupCrossOutlet({ crossOutletLookup }, '08123456')
    await lookupCrossOutlet({ crossOutletLookup }, 'BSD-1')
    expect(crossOutletLookup.mock.calls).toEqual([[{ phone: '08123456' }], [{ orderNumber: 'BSD-1' }]])
    expect(setItem).not.toHaveBeenCalled()
  })

  it('does not call the server for blank input', async () => {
    const crossOutletLookup = vi.fn()
    expect(await lookupCrossOutlet({ crossOutletLookup }, '  ')).toEqual([])
    expect(crossOutletLookup).not.toHaveBeenCalled()
  })
})

describe('lookupCrossOutlet deviceId', () => {
  it('sends the tablet id only when given', async () => {
    const crossOutletLookup = vi.fn().mockResolvedValue([])
    await lookupCrossOutlet({ crossOutletLookup }, 'BSD-1', 'tab-1')
    expect(crossOutletLookup).toHaveBeenCalledWith({ orderNumber: 'BSD-1', deviceId: 'tab-1' })
  })
})

describe('lookupErrorMessage (A18 per-user limit)', () => {
  it('a 429 says how many minutes to wait, from Retry-After, rounded up', () => {
    expect(lookupErrorMessage(new ApiError(429, 'x', 'http', undefined, 420_000))).toBe('Terlalu banyak pencarian. Coba lagi dalam 7 menit.')
    expect(lookupErrorMessage(new ApiError(429, 'x', 'http', undefined, 61_000))).toBe('Terlalu banyak pencarian. Coba lagi dalam 2 menit.')
    expect(lookupErrorMessage(new ApiError(429, 'x', 'http', undefined, 5_000))).toBe('Terlalu banyak pencarian. Coba lagi dalam 1 menit.')
  })
  it('a 429 without Retry-After still says too many searches', () => {
    expect(lookupErrorMessage(new ApiError(429, 'x'))).toBe('Terlalu banyak pencarian. Coba lagi nanti.')
  })
  it('other errors keep their own message', () => {
    expect(lookupErrorMessage(new ApiError(503, 'Server sibuk'))).toBe('Server sibuk')
    expect(lookupErrorMessage('boom')).toBe('Gagal mencari transaksi')
  })
})
