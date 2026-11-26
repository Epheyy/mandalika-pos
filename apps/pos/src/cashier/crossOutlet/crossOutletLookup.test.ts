import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupCrossOutlet, lookupQuery } from './crossOutletLookup'

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
