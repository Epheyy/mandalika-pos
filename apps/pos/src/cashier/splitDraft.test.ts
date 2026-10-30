import { describe, expect, it } from 'vitest'
import type { KV } from '@mandalika/sync'
import { CASHIER_INITIAL_STATE, cashierReducer } from './state/cashierReducer'
import { cashPredicate } from './tenderSplit'
import { formatRupiah } from './pricing'
import {
  draftChargedSummary, draftIsAlreadyASale, SPLIT_DRAFT_NAME, SPLIT_DRAFT_TTL_MS, splitDraftFromState, SplitDraftStore, splitDraftKey,
} from './splitDraft'

const memKV = (): KV => {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k),
    setDurable: async (k, v) => void m.set(k, v), removeDurable: async (k) => void m.delete(k),
  }
}
const NOW = Date.parse('2026-10-30T10:00:00Z')
const isCash = cashPredicate([])
const label = (m: string) => ({ tunai: 'Tunai', qris: 'QRIS' })[m] ?? m

const splitState = (tenders: { method: string; amount: number; reference?: string }[], keepUuid = true) => {
  let s = cashierReducer(CASHIER_INITIAL_STATE, {
    type: 'CART_ADD_ITEM',
    item: { productId: 'p1', productName: 'Parfum', variantSize: '30ml', price: 1_251_000, quantity: 1, subtotal: 1_251_000 } as never,
  })
  s = cashierReducer(s, { type: 'SPLIT_START', orderUuid: 'u-1' })
  s = cashierReducer(s, { type: 'SPLIT_RESTORE', orderUuid: 'u-1', tenders })
  return keepUuid ? s : { ...s, splitOrderUuid: null }
}

describe('splitDraftFromState', () => {
  it('exists only once a NON-CASH line is entered', () => {
    expect(splitDraftFromState(splitState([{ method: 'tunai', amount: 100 }]), 1_251_000, isCash, NOW)).toBeNull()
    expect(splitDraftFromState(splitState([]), 1_251_000, isCash, NOW)).toBeNull()
    const d = splitDraftFromState(splitState([{ method: 'qris', amount: 751_000 }]), 1_251_000, isCash, NOW)
    expect(d).toMatchObject({ v: 1, orderUuid: 'u-1', total: 1_251_000, tenders: [{ method: 'qris', amount: 751_000 }] })
    expect(d?.held.name).toBe(SPLIT_DRAFT_NAME)
    expect(d?.held.lines).toHaveLength(1)
  })
  it('needs the sale uuid minted when split mode started', () => {
    expect(splitDraftFromState(splitState([{ method: 'qris', amount: 1 }], false), 1, isCash, NOW)).toBeNull()
  })
  it('is not a draft outside split mode', () => {
    expect(splitDraftFromState({ ...splitState([{ method: 'qris', amount: 1 }]), splitMode: false }, 1, isCash, NOW)).toBeNull()
  })
})

describe('SplitDraftStore', () => {
  const draft = () => splitDraftFromState(splitState([{ method: 'qris', amount: 751_000, reference: '8812345' }]), 1_251_000, isCash, NOW)!
  it('round-trips through the kv and clears', async () => {
    const kv = memKV()
    const store = new SplitDraftStore(kv, splitDraftKey('outlet-1'), () => NOW)
    await store.save(draft())
    expect(new SplitDraftStore(kv, splitDraftKey('outlet-1'), () => NOW).read()?.tenders[0]?.reference).toBe('8812345')
    await store.clear()
    expect(store.read()).toBeNull()
  })
  it('lives in the app KV under its own key, never a journal-facade key', () => {
    expect(splitDraftKey('o')).toBe('mandalika.pos.splitDraft.o')
    expect(splitDraftKey('')).toBe('mandalika.pos.splitDraft.unbound')
  })
  it('reads malformed or expired content as no draft', async () => {
    const kv = memKV()
    const key = splitDraftKey('o')
    kv.set(key, '{"v":2}')
    expect(new SplitDraftStore(kv, key, () => NOW).read()).toBeNull()
    await new SplitDraftStore(kv, key, () => NOW).save(draft())
    expect(new SplitDraftStore(kv, key, () => NOW + SPLIT_DRAFT_TTL_MS + 1).read()).toBeNull()
    kv.set(key, JSON.stringify({ ...draft(), tenders: [{ method: '', amount: 1 }] }))
    expect(new SplitDraftStore(kv, key, () => NOW).read()).toBeNull()
  })
})

describe('restore rules', () => {
  const d = splitDraftFromState(splitState([{ method: 'qris', amount: 751_000 }, { method: 'tunai', amount: 100_000 }]), 1_251_000, isCash, NOW)!
  it('names only the charged (non-cash) lines in the banner', () => {
    expect(draftChargedSummary(d, isCash, label)).toBe(`QRIS ${formatRupiah(751_000)}`)
  })
  it('a draft whose uuid is already queued or archived is dropped without a prompt', () => {
    expect(draftIsAlreadyASale(d, new Set(['u-1']))).toBe(true)
    expect(draftIsAlreadyASale(d, new Set(['other']))).toBe(false)
  })
})
