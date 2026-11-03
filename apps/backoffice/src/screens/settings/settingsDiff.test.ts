import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@mandalika/api'
import {
  ALWAYS_KEYS,
  PRESENT_ONLY_KEYS,
  buildSaveBody,
  copyPath,
  diffSettings,
  dirtyMarkers,
  findConflicts,
  normalize,
  rebaseOnFresh,
  resolveConflict,
} from './settingsDiff'

const SERVER: AppSettings = {
  taxEnabled: true,
  taxRate: 11,
  roundingEnabled: false,
  roundingType: 'nearest_500',
  roundingAmount: null,
  roundingDirection: null,
  roundingApplyToTax: null,
  paymentMethods: [
    { id: 'cash', label: 'Tunai', isEnabled: true },
    { id: 'qris', label: 'QRIS', isEnabled: true, isCash: false },
  ],
  receipt: { headerText: 'Hai', footerText: 'Bye', showTax: true, showCashier: true, copies: null, autoPrint: null },
  autoOpenShift: false,
  allowNegativeStock: true,
  receiveApproverRoles: ['admin', 'manager'],
  recipesEnabled: false,
  inventoryApprovalRequired: false,
  splitTenderEnabled: true,
  documents: { logoUrl: null, brandName: 'Mandalika', addressLines: null, phone: null, npwp: null },
} as AppSettings

const edit = (s: AppSettings, patch: Partial<AppSettings>): AppSettings => ({ ...s, ...patch })

describe('normalize', () => {
  it('shows no changes right after loading the same server copy', () => {
    const n = normalize(SERVER)
    expect(diffSettings(n, normalize(SERVER))).toEqual([])
  })

  it('drops admin from the approver list so a stored admin is not a change', () => {
    expect(normalize(SERVER).receiveApproverRoles).toEqual(['manager'])
  })

  it('treats null and missing flags/documents as their form defaults', () => {
    const n = normalize({ ...SERVER, recipesEnabled: undefined, documents: undefined })
    expect(n.recipesEnabled).toBe(false)
    expect(n.documents).toEqual({})
  })

  it('does not report a change when the form shows a default for a NULL server value', () => {
    const base = normalize(SERVER)
    const draft = { ...base, roundingAmount: 1000, roundingDirection: 'floor' as const, receipt: { ...base.receipt, copies: 1, autoPrint: false } }
    expect(diffSettings(base, draft)).toEqual([])
  })
})

describe('diffSettings', () => {
  it('reports top-level, receipt, document, method and role changes with human labels', () => {
    const base = normalize(SERVER)
    let draft = edit(base, { taxRate: 12, splitTenderEnabled: false, receiveApproverRoles: ['manager', 'cashier'] })
    draft = { ...draft, receipt: { ...draft.receipt, autoPrint: true }, documents: { ...draft.documents, phone: '0812' } }
    draft = { ...draft, paymentMethods: [...draft.paymentMethods.filter((m) => m.id !== 'qris'), { id: 'gopay', label: 'GoPay', isEnabled: true }] }
    const changes = diffSettings(base, draft)
    expect(changes.map((c) => c.path).sort()).toEqual(
      ['documents.phone', 'paymentMethods[gopay]', 'paymentMethods[qris]', 'receipt.autoPrint', 'receiveApproverRoles[cashier]', 'splitTenderEnabled', 'taxRate'].sort(),
    )
    expect(changes.find((c) => c.path === 'taxRate')).toMatchObject({ from: '11%', to: '12%' })
    expect(changes.find((c) => c.path === 'paymentMethods[qris]')?.to).toBe('dihapus')
  })

  it('uses the resolved cash flag, so toggling it twice is no change', () => {
    const base = normalize(SERVER)
    const twice = { ...base, paymentMethods: base.paymentMethods.map((m) => (m.id === 'cash' ? { ...m, isCash: true } : m)) }
    expect(diffSettings(base, twice)).toEqual([])
    const flipped = { ...base, paymentMethods: base.paymentMethods.map((m) => (m.id === 'cash' ? { ...m, isCash: false } : m)) }
    expect(diffSettings(base, flipped).map((c) => c.path)).toEqual(['paymentMethods[cash].isCash'])
  })

  it('maps changes to cards and tabs for the dirty cues', () => {
    const base = normalize(SERVER)
    const m = dirtyMarkers(diffSettings(base, edit(base, { splitTenderEnabled: false, autoOpenShift: true })))
    expect([...m.cards].sort()).toEqual(['shift', 'split'])
    expect([...m.tabs].sort()).toEqual(['operasional', 'transaksi'])
  })
})

describe('buildSaveBody', () => {
  const base = normalize(SERVER)

  it('sends no present-only key unless it changed, and never the whole fresh object', () => {
    const draft = edit(base, { taxRate: 12 })
    const body = buildSaveBody(SERVER, base, draft, diffSettings(base, draft)) as unknown as Record<string, unknown>
    for (const k of PRESENT_ONLY_KEYS) expect(k in body).toBe(false)
    expect(Object.keys(body).sort()).toEqual([...ALWAYS_KEYS].sort())
    expect(body.taxRate).toBe(12)
  })

  it('sends a present-only key when the admin changed it', () => {
    const draft = edit(base, { splitTenderEnabled: false, recipesEnabled: true })
    const body = buildSaveBody(SERVER, base, draft, diffSettings(base, draft)) as unknown as Record<string, unknown>
    expect(body.splitTenderEnabled).toBe(false)
    expect(body.recipesEnabled).toBe(true)
    expect('inventoryApprovalRequired' in body).toBe(false)
  })

  it('sends the fresh documents block with only the changed field applied', () => {
    const draft = { ...base, documents: { ...base.documents, phone: '0812' } }
    const body = buildSaveBody(SERVER, base, draft, diffSettings(base, draft)) as unknown as Record<string, unknown>
    expect(body.documents).toEqual({ brandName: 'Mandalika', phone: '0812' })
  })

  it('applies the admin edit on top of what another admin saved meanwhile', () => {
    const fresh = normalize({ ...SERVER, taxRate: 7, receipt: { ...SERVER.receipt, headerText: 'Baru' } })
    const draft = { ...base, receipt: { ...base.receipt, autoPrint: true } }
    const body = buildSaveBody({ ...SERVER, taxRate: 7 }, fresh, draft, diffSettings(base, draft))
    expect(body.taxRate).toBe(7)
    expect(body.receipt).toMatchObject({ headerText: 'Baru', autoPrint: true })
  })

  it('merges method changes by id onto the fresh list and persists the resolved cash flag', () => {
    const fresh = normalize({ ...SERVER, paymentMethods: [...SERVER.paymentMethods, { id: 'ovo', label: 'OVO', isEnabled: true }] })
    const draft = { ...base, paymentMethods: base.paymentMethods.map((m) => (m.id === 'qris' ? { ...m, isEnabled: false } : m)) }
    const body = buildSaveBody(SERVER, fresh, draft, diffSettings(base, draft))
    expect(body.paymentMethods.map((m) => m.id)).toEqual(['cash', 'qris', 'ovo'])
    expect(body.paymentMethods.find((m) => m.id === 'qris')?.isEnabled).toBe(false)
    expect(body.paymentMethods.every((m) => typeof m.isCash === 'boolean')).toBe(true)
  })

  it('returns the server method list untouched when methods did not change', () => {
    const draft = edit(base, { taxRate: 12 })
    const body = buildSaveBody(SERVER, base, draft, diffSettings(base, draft))
    expect(body.paymentMethods).toEqual(SERVER.paymentMethods)
    expect(body.receiveApproverRoles).toEqual(['admin', 'manager'])
  })

  it('merges approver roles per role', () => {
    const fresh = normalize({ ...SERVER, receiveApproverRoles: ['manager', 'cashier'] })
    const draft = edit(base, { receiveApproverRoles: [] })
    const body = buildSaveBody(SERVER, fresh, draft, diffSettings(base, draft))
    expect(body.receiveApproverRoles).toEqual(['cashier'])
  })
})

describe('conflicts', () => {
  const base = normalize(SERVER)

  it('flags a field the admin changed that someone else also changed', () => {
    const draft = edit(base, { taxRate: 12 })
    const fresh = normalize({ ...SERVER, taxRate: 9 })
    const found = findConflicts(base, fresh, draft, diffSettings(base, draft))
    expect(found).toEqual([{ path: 'taxRate', label: 'Tarif pajak', mine: '12%', theirs: '9%' }])
  })

  it('does not flag fields only the other admin changed, or both set to the same value', () => {
    const fresh = normalize({ ...SERVER, taxRate: 12, autoOpenShift: true })
    const draft = edit(base, { taxRate: 12 })
    expect(findConflicts(base, fresh, draft, diffSettings(base, draft))).toEqual([])
  })

  it('resolves "theirs" by taking the server value and "mine" by keeping the draft', () => {
    const draft = edit(base, { taxRate: 12 })
    const fresh = normalize({ ...SERVER, taxRate: 9 })
    const theirs = resolveConflict({ baseline: base, draft }, fresh, 'taxRate', 'theirs')
    expect(theirs.draft.taxRate).toBe(9)
    expect(diffSettings(theirs.baseline, theirs.draft)).toEqual([])
    const mine = resolveConflict({ baseline: base, draft }, fresh, 'taxRate', 'mine')
    expect(mine.draft.taxRate).toBe(12)
    expect(findConflicts(mine.baseline, fresh, mine.draft, diffSettings(mine.baseline, mine.draft))).toEqual([])
  })
})

describe('conflict on a deleted method', () => {
  const base = normalize(SERVER)
  const draft = { ...base, paymentMethods: base.paymentMethods.map((m) => (m.id === 'qris' ? { ...m, isEnabled: false } : m)) }
  const fresh = normalize({ ...SERVER, paymentMethods: SERVER.paymentMethods.filter((m) => m.id !== 'qris') })
  const path = 'paymentMethods[qris].isEnabled'

  it.each(['mine', 'theirs'] as const)('can be resolved with %s', (choice) => {
    const found = findConflicts(base, fresh, draft, diffSettings(base, draft))
    expect(found.map((c) => c.path)).toEqual([path])
    const next = resolveConflict({ baseline: base, draft }, fresh, path, choice)
    expect(findConflicts(next.baseline, fresh, next.draft, diffSettings(next.baseline, next.draft))).toEqual([])
    expect(next.draft.paymentMethods.some((m) => m.id === 'qris')).toBe(choice === 'mine')
  })
})

describe('rebaseOnFresh', () => {
  const base = normalize(SERVER)

  it('takes the server value for untouched fields and keeps the admin edit and its old baseline', () => {
    const draft = edit(base, { taxRate: 12 })
    const fresh = normalize({ ...SERVER, taxRate: 9, autoOpenShift: true })
    const next = rebaseOnFresh({ baseline: base, draft }, fresh)
    expect(next.draft.autoOpenShift).toBe(true)
    expect(next.baseline.autoOpenShift).toBe(true)
    expect(next.draft.taxRate).toBe(12)
    expect(next.baseline.taxRate).toBe(11)
    expect(diffSettings(next.baseline, next.draft).map((c) => c.path)).toEqual(['taxRate'])
  })

  it('with no edits simply adopts the fresh copy', () => {
    const fresh = normalize({ ...SERVER, taxRate: 9 })
    const next = rebaseOnFresh({ baseline: base, draft: base }, fresh)
    expect(next.draft).toEqual(fresh)
    expect(next.baseline).toEqual(fresh)
  })
})

describe('copyPath', () => {
  it('copies only the named path', () => {
    const a = normalize(SERVER)
    const b = normalize({ ...SERVER, taxRate: 3, autoOpenShift: true })
    const out = copyPath(a, 'taxRate', b)
    expect(out.taxRate).toBe(3)
    expect(out.autoOpenShift).toBe(false)
  })
})

describe('server field coverage', () => {
  const source = readFileSync(new URL('../../../../../backend/internal/write/settings.go', import.meta.url), 'utf8')
  const struct = source.slice(source.indexOf('var s struct {'), source.indexOf('json.Unmarshal(raw, &s)'))
  const tags = [...struct.matchAll(/`json:"(\w+)"`/g)].map((m) => m[1])

  it('classifies every field the update handler reads', () => {
    expect([...ALWAYS_KEYS, ...PRESENT_ONLY_KEYS].sort()).toEqual([...tags].sort())
  })

  it('present-only keys are exactly those the handler skips when absent', () => {
    for (const k of PRESENT_ONLY_KEYS) {
      const field = k[0].toUpperCase() + k.slice(1)
      expect(source).toMatch(new RegExp(String.raw`s\.${field} != nil|:= s\.${field}; \w+ != nil`))
    }
    for (const k of ALWAYS_KEYS) {
      const field = k[0].toUpperCase() + k.slice(1)
      expect(source).not.toContain(`s.${field} != nil`)
    }
  })
})
