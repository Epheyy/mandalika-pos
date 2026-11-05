import { describe, expect, it, vi } from 'vitest'
import type { DiscountCode, Promotion } from '@mandalika/api'
import { EMPTY_BATCH, codeToInput } from './discountCodeForm'
import { promotionToInput } from './promotionForm'
import {
  batchNeedsConfirm, confirmActivation, confirmBatchActivation, needsActivationConfirm, wasActiveNow, toggleStatus,
  type StatusToggleDeps, type StatusToggleKind,
} from './useStatusToggle'

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: 'promo-1', name: 'Diskon Akhir Tahun', type: 'percentage', value: 10, isActive: true, createdAt: '2026-10-01T00:00:00Z',
  autoApply: true, applicableVariantSizes: ['50 ml'], combinableWith: ['other'], outletIds: ['o1', 'gone'], minPurchase: null,
  ...over,
})

function setup(initial: Promotion) {
  // The "server": one row that other people can change between our calls.
  const server = { row: initial }
  const puts: Array<{ id: string; body: unknown }> = []
  const kind: StatusToggleKind<Promotion> = {
    noun: 'promo',
    nameOf: (p) => p.name,
    fetchAll: async () => [server.row],
    save: async (fresh, isActive) => {
      puts.push({ id: fresh.id, body: { ...promotionToInput(fresh), isActive } })
      server.row = { ...server.row, ...promotionToInput(fresh), id: fresh.id, createdAt: fresh.createdAt, isActive } as Promotion
    },
  }
  const toasts: Array<Parameters<StatusToggleDeps['toast']>[0]> = []
  const deps: StatusToggleDeps & { confirm: ReturnType<typeof vi.fn> } = {
    confirm: vi.fn(async () => ({ confirmed: true })),
    toast: (t) => toasts.push(t),
    refetch: vi.fn(async () => {}),
    setBusy: vi.fn(),
  }
  return { server, puts, kind, toasts, deps }
}

describe('toggleStatus: turning ON', () => {
  it('asks first, in the words of D-79, and writes nothing when declined', async () => {
    const t = setup(promo({ isActive: false }))
    t.deps.confirm.mockResolvedValueOnce({ confirmed: false })
    await toggleStatus(t.kind, t.server.row, true, t.deps)
    expect(t.deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Aktifkan promo Diskon Akhir Tahun?', consequence: 'Tablet memakainya setelah sinkron berikutnya.' }))
    expect(t.puts).toHaveLength(0)
  })

  it('saves the fresh row with only the status changed once confirmed', async () => {
    const t = setup(promo({ isActive: false }))
    await toggleStatus(t.kind, t.server.row, true, t.deps)
    expect(t.puts).toEqual([{ id: 'promo-1', body: { ...promotionToInput(promo({ isActive: false })), isActive: true } }])
    expect(t.deps.refetch).toHaveBeenCalled()
  })
})

describe('toggleStatus: busy marker', () => {
  it('marks the row busy for the whole change and clears it only after the list was refetched', async () => {
    const t = setup(promo())
    const order: string[] = []
    t.deps.setBusy = (id, busy) => order.push(`${busy ? 'busy' : 'free'}:${id}`)
    t.deps.refetch = async () => { order.push('refetch') }
    await toggleStatus(t.kind, t.server.row, false, t.deps)
    expect(order).toEqual(['busy:promo-1', 'refetch', 'free:promo-1'])
  })
})

describe('toggleStatus: turning OFF', () => {
  it('saves at once, without a question, and offers Urungkan', async () => {
    const t = setup(promo())
    await toggleStatus(t.kind, t.server.row, false, t.deps)
    expect(t.deps.confirm).not.toHaveBeenCalled()
    expect(t.puts).toHaveLength(1)
    const toast = t.toasts.at(-1)!
    expect(toast.message).toBe('Promo Diskon Akhir Tahun dinonaktifkan')
    expect(toast.action?.label).toBe('Urungkan')
  })

  it('undo re-reads the row and sends the FRESH one, not the copy from before', async () => {
    const t = setup(promo())
    await toggleStatus(t.kind, t.server.row, false, t.deps)
    // Meanwhile somebody renames the promotion and changes its value.
    t.server.row = { ...t.server.row, name: 'Diskon Dibenahi', value: 25 }
    t.toasts.at(-1)!.action!.onClick()
    await vi.waitFor(() => expect(t.puts).toHaveLength(2))
    const undo = t.puts[1].body as { name: string; value: number; isActive: boolean; autoApply: boolean; applicableVariantSizes: string[]; combinableWith: string[]; outletIds: string[] }
    expect(undo.name).toBe('Diskon Dibenahi')
    expect(undo.value).toBe(25)
    expect(undo.isActive).toBe(true)
    // and nothing the form has no control for is lost
    expect(undo.autoApply).toBe(true)
    expect(undo.applicableVariantSizes).toEqual(['50 ml'])
    expect(undo.combinableWith).toEqual(['other'])
    expect(undo.outletIds).toEqual(['o1', 'gone'])
  })

  it('says so, writes nothing and offers no undo when the row is gone', async () => {
    const t = setup(promo())
    const row = t.server.row
    t.kind.fetchAll = async () => []
    await toggleStatus(t.kind, row, false, t.deps)
    expect(t.puts).toHaveLength(0)
    expect(t.toasts).toHaveLength(1)
    expect(t.toasts[0]).toMatchObject({ message: 'Promo tidak ditemukan. Mungkin sudah dihapus.', tone: 'warn' })
    expect(t.toasts[0].action).toBeUndefined()
  })

  it('shows the server refusal and offers no undo when the save fails', async () => {
    const t = setup(promo())
    t.kind.save = async () => {
      throw new Error('Server menolak')
    }
    await toggleStatus(t.kind, t.server.row, false, t.deps)
    expect(t.toasts).toEqual([{ message: 'Server menolak', tone: 'warn' }])
    expect(t.deps.refetch).toHaveBeenCalled()
  })
})

describe('toggleStatus for a discount code', () => {
  it('sends the whole fresh code: case, quota, per-customer cap and holder untouched', async () => {
    const code: DiscountCode = {
      id: 'code-1', code: 'Raw-Mixed', type: 'fixed', value: 5000, usageCount: 3, usageLimit: null, perCustomerLimit: 2,
      customerId: 'cust-1', customerName: 'Synthetic', promotionId: 'promo-1', combinable: true, isActive: true,
      createdAt: '2026-10-01T00:00:00Z',
    }
    const sent: unknown[] = []
    const kind: StatusToggleKind<DiscountCode> = {
      noun: 'kode', nameOf: (c) => c.code, fetchAll: async () => [code],
      save: async (fresh, isActive) => { sent.push({ ...codeToInput(fresh), isActive }) },
    }
    const toasts: Array<{ message: string }> = []
    await toggleStatus(kind, code, false, { confirm: vi.fn(), toast: (t) => toasts.push(t), refetch: async () => {}, setBusy: () => {} })
    expect(sent).toEqual([{ ...codeToInput(code), isActive: false }])
    expect(sent[0]).toMatchObject({ code: 'Raw-Mixed', usageLimit: null, perCustomerLimit: 2, customerId: 'cust-1', promotionId: 'promo-1', combinable: true })
    expect(toasts[0].message).toBe('Kode Raw-Mixed dinonaktifkan')
  })
})

describe('needsActivationConfirm: does this editor save make the item live?', () => {
  it('asks for a new item saved active', () => expect(needsActivationConfirm(null, true)).toBe(true))
  it('asks when an inactive item is saved active', () => expect(needsActivationConfirm(false, true)).toBe(true))
  it('does not ask when an active item is saved again active', () => expect(needsActivationConfirm(true, true)).toBe(false))
  it.each([null, false, true])('never asks when saving inactive (was %s)', (was) => expect(needsActivationConfirm(was, false)).toBe(false))
})

describe('confirmActivation', () => {
  it('uses the D-79 words for promos and for codes, and returns the answer', async () => {
    const confirm = vi.fn(async () => ({ confirmed: false }))
    expect(await confirmActivation(confirm, 'kode', 'HEMAT10')).toBe(false)
    expect(confirm).toHaveBeenCalledWith({ title: 'Aktifkan kode HEMAT10?', consequence: 'Tablet memakainya setelah sinkron berikutnya.', confirmLabel: 'Aktifkan', initialFocus: 'cancel' })
  })
})

describe('wasActiveNow: the editor re-reads a row it opened as active', () => {
  const row = { id: 'a', isActive: true }
  it('is null for a new item and false for a row opened inactive, without reading', async () => {
    const read = vi.fn(async () => [row])
    expect(await wasActiveNow(null, read)).toBeNull()
    expect(await wasActiveNow({ id: 'a', isActive: false }, read)).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })
  it('follows the fresh row: switched off meanwhile means saving active is an activation', async () => {
    expect(await wasActiveNow(row, async () => [{ id: 'a', isActive: false }])).toBe(false)
    expect(needsActivationConfirm(await wasActiveNow(row, async () => [{ id: 'a', isActive: false }]), true)).toBe(true)
  })
  it('falls back to the loaded row when the read fails', async () => {
    expect(await wasActiveNow(row, async () => { throw new Error('offline') })).toBe(true)
  })
})

describe('batchNeedsConfirm: Buat Massal asks only when the batch is created active', () => {
  it('asks for a batch created active', () => expect(batchNeedsConfirm({ isActive: true })).toBe(true))
  it('does not ask for a batch created inactive', () => expect(batchNeedsConfirm({ isActive: false })).toBe(false))
  it('does not ask when isActive is missing: the server stores that as inactive', () => expect(batchNeedsConfirm({})).toBe(false))
  it('asks for the form as Buat Massal opens it (active by default)', () => expect(batchNeedsConfirm(EMPTY_BATCH)).toBe(true))
})

describe('confirmBatchActivation', () => {
  it('names the number of codes in the D-79 words and returns the answer', async () => {
    const confirm = vi.fn(async () => ({ confirmed: true }))
    expect(await confirmBatchActivation(confirm, 25)).toBe(true)
    expect(confirm).toHaveBeenCalledWith({ title: 'Buat 25 kode aktif?', consequence: 'Tablet memakainya setelah sinkron berikutnya.', confirmLabel: 'Buat kode', initialFocus: 'cancel' })
    confirm.mockResolvedValueOnce({ confirmed: false })
    expect(await confirmBatchActivation(confirm, 25)).toBe(false)
  })
})
