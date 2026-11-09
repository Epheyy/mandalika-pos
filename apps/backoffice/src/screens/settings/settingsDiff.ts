import type { AppSettings } from '@mandalika/api'
import { isCashMethod, resolveReceiptFlags } from '@mandalika/types'

/*
 * Pengaturan draft logic, all pure. The screen keeps a `baseline` (what the server held when the
 * admin started editing) and a `draft`. Saving never sends the draft: it fetches the server's
 * current settings, applies only the fields the admin changed, and sends that. So a tab left open
 * cannot revert another admin's saved changes.
 */

export type CardId = 'tax' | 'payments' | 'split' | 'receipt' | 'stock' | 'shift' | 'approval' | 'transfer' | 'docs' | 'recipe'
export type TabId = 'locations' | 'transaksi' | 'operasional' | 'recipe'

export const CARD_TAB: Record<CardId, TabId> = {
  stock: 'locations',
  tax: 'transaksi',
  payments: 'transaksi',
  split: 'transaksi',
  receipt: 'transaksi',
  shift: 'operasional',
  approval: 'operasional',
  transfer: 'operasional',
  docs: 'operasional',
  recipe: 'recipe',
}

/** The pending change for one setting path, if the draft differs from the saved value. */
export const changeAt = (changes: readonly Change[], path: string): Change | undefined => changes.find((c) => c.path === path)

/** Card names for the leave question ("Ada 2 perubahan (Metode pembayaran, Bayar terpisah)"). */
export const CARD_TITLE: Record<CardId, string> = {
  stock: 'Pengaturan stok',
  tax: 'Pajak & pembulatan',
  payments: 'Metode pembayaran',
  split: 'Bayar terpisah',
  receipt: 'Struk',
  shift: 'Pengaturan shift',
  approval: 'Persetujuan stok',
  transfer: 'Persetujuan penerimaan transfer',
  docs: 'Dokumen pengiriman',
  recipe: 'Resep & bahan',
}

/** Keys the server overwrites (zero value or NULL) when a PUT omits them: always sent. Pinned to write/settings.go by a test. */
export const ALWAYS_KEYS = [
  'taxEnabled',
  'taxRate',
  'roundingEnabled',
  'roundingType',
  'roundingAmount',
  'roundingDirection',
  'roundingApplyToTax',
  'autoOpenShift',
  'allowNegativeStock',
  'paymentMethods',
  'receipt',
  'receiveApproverRoles',
] as const

/** Keys the server leaves untouched when absent: sent only when the admin changed them. */
export const PRESENT_ONLY_KEYS = ['recipesEnabled', 'inventoryApprovalRequired', 'splitTenderEnabled', 'documents'] as const

export const DEFAULT_SETTINGS: AppSettings = {
  taxEnabled: true,
  taxRate: 11,
  roundingEnabled: false,
  roundingType: 'nearest_500',
  roundingAmount: 1000,
  roundingDirection: 'floor',
  roundingApplyToTax: false,
  paymentMethods: [
    { id: 'cash', label: 'Tunai', isEnabled: true, isCash: true },
    { id: 'card', label: 'Kartu', isEnabled: true, isCash: false },
    { id: 'qris', label: 'QRIS', isEnabled: true, isCash: false },
    { id: 'transfer', label: 'Transfer', isEnabled: true, isCash: false },
  ],
  receipt: {
    headerText: 'Mandalika Perfume',
    footerText: 'Terima kasih telah berbelanja!',
    showTax: true,
    showCashier: true,
    copies: 1,
    autoPrint: false,
    showOrderNumber: true,
    showCustomerName: true,
    showCustomerPhone: true,
    showDiscount: true,
    showSubtotal: true,
    showChange: true,
  },
  autoOpenShift: false,
  allowNegativeStock: true,
  receiveApproverRoles: [],
}

const DOC_KEYS = ['brandName', 'logoUrl', 'addressLines', 'phone', 'npwp'] as const

/** One normalisation for baseline AND draft, so opening the screen shows no changes. */
export function normalize(data?: Partial<AppSettings> | null): AppSettings {
  const m = { ...DEFAULT_SETTINGS, ...(data ?? {}) } as AppSettings
  const documents: Record<string, string> = {}
  for (const k of DOC_KEYS) {
    const v = m.documents?.[k]
    if (typeof v === 'string' && v !== '') documents[k] = v
  }
  return {
    ...m,
    paymentMethods: m.paymentMethods ?? [],
    // A stored receipt object can be partial (absent show* keys). Resolve each key the way the printer reads it,
    // per key, so the switches, the on-screen receipt and the paper agree; never merge DEFAULT_SETTINGS in.
    receipt: { ...(m.receipt ?? DEFAULT_SETTINGS.receipt), ...resolveReceiptFlags(m.receipt) },
    // The server stores the list as sent, so a stored 'admin' is possible; admin is always allowed and must not count as a change.
    receiveApproverRoles: (m.receiveApproverRoles ?? []).filter((r) => r !== 'admin'),
    recipesEnabled: !!m.recipesEnabled,
    inventoryApprovalRequired: !!m.inventoryApprovalRequired,
    splitTenderEnabled: !!m.splitTenderEnabled,
    documents,
  }
}

type Kind = 'bool' | 'text' | 'num' | 'enum'
interface FieldSpec {
  path: string
  card: CardId
  label: string
  kind: Kind
  /** Value the form shows while the server holds NULL, so picking it is not a change. */
  fallback?: string | number | boolean
  unit?: string
  enumLabels?: Record<string, string>
}

const RECEIPT_FIELDS: FieldSpec[] = [
  { path: 'receipt.copies', card: 'receipt', label: 'Jumlah salinan struk', kind: 'num', fallback: 1 },
  { path: 'receipt.autoPrint', card: 'receipt', label: 'Cetak struk otomatis', kind: 'bool' },
  { path: 'receipt.headerText', card: 'receipt', label: 'Teks header struk', kind: 'text' },
  { path: 'receipt.footerText', card: 'receipt', label: 'Teks footer struk', kind: 'text' },
  { path: 'receipt.showOrderNumber', card: 'receipt', label: 'Struk: nomor pesanan', kind: 'bool' },
  { path: 'receipt.showCashier', card: 'receipt', label: 'Struk: dicetak oleh', kind: 'bool' },
  { path: 'receipt.showCustomerName', card: 'receipt', label: 'Struk: nama pelanggan', kind: 'bool' },
  { path: 'receipt.showCustomerPhone', card: 'receipt', label: 'Struk: nomor telepon', kind: 'bool' },
  { path: 'receipt.showTax', card: 'receipt', label: 'Struk: pajak', kind: 'bool' },
  { path: 'receipt.showDiscount', card: 'receipt', label: 'Struk: diskon', kind: 'bool' },
  { path: 'receipt.showSubtotal', card: 'receipt', label: 'Struk: subtotal', kind: 'bool' },
  { path: 'receipt.showChange', card: 'receipt', label: 'Struk: kembalian', kind: 'bool' },
]

const FIELDS: FieldSpec[] = [
  { path: 'taxEnabled', card: 'tax', label: 'PPN', kind: 'bool' },
  { path: 'taxRate', card: 'tax', label: 'Tarif pajak', kind: 'num', unit: '%' },
  { path: 'roundingEnabled', card: 'tax', label: 'Pembulatan harga', kind: 'bool' },
  { path: 'roundingAmount', card: 'tax', label: 'Pembulatan ke', kind: 'num', fallback: 1000 },
  {
    path: 'roundingDirection',
    card: 'tax',
    label: 'Tipe pembulatan',
    kind: 'enum',
    fallback: 'floor',
    enumLabels: { floor: 'ke bawah', ceil: 'ke atas', nearest: 'terdekat' },
  },
  { path: 'splitTenderEnabled', card: 'split', label: 'Bayar terpisah', kind: 'bool' },
  ...RECEIPT_FIELDS,
  { path: 'allowNegativeStock', card: 'stock', label: 'Izinkan stok minus', kind: 'bool' },
  { path: 'autoOpenShift', card: 'shift', label: 'Buka shift otomatis', kind: 'bool' },
  { path: 'inventoryApprovalRequired', card: 'approval', label: 'Wajib persetujuan stok', kind: 'bool' },
  { path: 'documents.brandName', card: 'docs', label: 'Nama merek dokumen', kind: 'text' },
  { path: 'documents.logoUrl', card: 'docs', label: 'Logo dokumen', kind: 'text' },
  { path: 'documents.addressLines', card: 'docs', label: 'Alamat dokumen', kind: 'text' },
  { path: 'documents.phone', card: 'docs', label: 'Telepon dokumen', kind: 'text' },
  { path: 'documents.npwp', card: 'docs', label: 'NPWP dokumen', kind: 'text' },
  { path: 'recipesEnabled', card: 'recipe', label: 'Modul Resep & Bahan', kind: 'bool' },
]

const SPEC_BY_PATH = new Map(FIELDS.map((f) => [f.path, f]))

type Value = string | number | boolean | undefined

export interface Change {
  path: string
  card: CardId
  label: string
  from: string
  to: string
}

export interface Conflict {
  path: string
  label: string
  /** The value in the admin's draft. */
  mine: string
  /** What the server holds now. */
  theirs: string
}

// ── paths ─────────────────────────────────────────────────────────────────────

const METHOD_RE = /^paymentMethods\[(.+?)\](?:\.(label|isEnabled|isCash))?$/
const ROLE_RE = /^receiveApproverRoles\[(.+)\]$/

const getRaw = (s: AppSettings, path: string): unknown => {
  const dot = path.indexOf('.')
  if (dot < 0) return (s as unknown as Record<string, unknown>)[path]
  const group = path.slice(0, dot)
  const key = path.slice(dot + 1)
  return ((s as unknown as Record<string, Record<string, unknown> | undefined>)[group] ?? {})[key]
}

const coerce = (spec: FieldSpec, raw: unknown): Value => {
  const v = raw === null || raw === '' ? undefined : raw
  switch (spec.kind) {
    case 'bool':
      return !!v
    case 'num': {
      const n = typeof v === 'number' ? v : v === undefined ? NaN : Number(v)
      return Number.isFinite(n) ? n : (spec.fallback as number | undefined)
    }
    case 'enum':
      return (v as string | undefined) ?? (spec.fallback as string | undefined)
    case 'text':
      return spec.path.startsWith('documents.') ? ((v as string | undefined) || undefined) : ((v as string | undefined) ?? '')
  }
}

const findMethod = (s: AppSettings, id: string) => s.paymentMethods.find((m) => m.id === id)

/** Comparable value at a path. Method fields use the RESOLVED cash flag, so toggling it twice is no change. */
export function getValue(s: AppSettings, path: string): Value {
  const spec = SPEC_BY_PATH.get(path)
  if (spec) return coerce(spec, getRaw(s, path))
  const method = METHOD_RE.exec(path)
  if (method) {
    const m = findMethod(s, method[1])
    switch (method[2]) {
      case undefined:
        return !!m
      case 'label':
        return m?.label
      case 'isEnabled':
        return m ? !!m.isEnabled : undefined
      default:
        return m ? isCashMethod(s.paymentMethods, m.id) : undefined
    }
  }
  const role = ROLE_RE.exec(path)
  if (role) return (s.receiveApproverRoles ?? []).includes(role[1])
  return undefined
}

/** Copy the value at `path` from `source` into `target` (immutably). Everything else in `target` is kept. */
export function copyPath(target: AppSettings, path: string, source: AppSettings): AppSettings {
  const dot = path.indexOf('.')
  if (SPEC_BY_PATH.has(path)) {
    if (dot < 0) return { ...target, [path]: getRaw(source, path) }
    const group = path.slice(0, dot)
    const key = path.slice(dot + 1)
    const prev = ((target as unknown as Record<string, Record<string, unknown> | undefined>)[group] ?? {})
    const next = { ...prev }
    const v = getRaw(source, path)
    if (v === undefined) delete next[key]
    else next[key] = v
    return { ...target, [group]: next } as AppSettings
  }
  const method = METHOD_RE.exec(path)
  if (method) return copyMethod(target, method[1], method[2], source)
  const role = ROLE_RE.exec(path)
  if (role) {
    const has = (source.receiveApproverRoles ?? []).includes(role[1])
    const rest = (target.receiveApproverRoles ?? []).filter((r) => r !== role[1])
    return { ...target, receiveApproverRoles: has ? [...rest, role[1]] : rest }
  }
  return target
}

function copyMethod(target: AppSettings, id: string, field: string | undefined, source: AppSettings): AppSettings {
  const src = findMethod(source, id)
  const dst = findMethod(target, id)
  if (field === undefined) {
    if (!src) return { ...target, paymentMethods: target.paymentMethods.filter((m) => m.id !== id) }
    if (dst) return target
    return { ...target, paymentMethods: [...target.paymentMethods, { ...src, isCash: isCashMethod(source.paymentMethods, id) }] }
  }
  if (!src || !dst) return target
  const patch =
    field === 'isCash' ? { isCash: isCashMethod(source.paymentMethods, id) } : field === 'isEnabled' ? { isEnabled: src.isEnabled } : { label: src.label }
  return { ...target, paymentMethods: target.paymentMethods.map((m) => (m.id === id ? { ...m, ...patch } : m)) }
}

// ── labels ────────────────────────────────────────────────────────────────────

export function formatValue(path: string, v: Value): string {
  const spec = SPEC_BY_PATH.get(path)
  if (spec?.kind === 'enum') return spec.enumLabels?.[String(v)] ?? String(v ?? '-')
  if (spec?.kind === 'bool' || typeof v === 'boolean') return v ? 'aktif' : 'nonaktif'
  if (spec?.kind === 'num') return v === undefined ? '-' : `${v}${spec.unit ?? ''}`
  return v === undefined || v === '' ? '(kosong)' : String(v)
}

const methodName = (id: string, ...from: AppSettings[]) => from.map((s) => findMethod(s, id)?.label).find(Boolean) ?? id

const FIELD_LABEL: Record<string, string> = { isEnabled: 'aktif', isCash: 'masuk laci kas' }

// ── diff ──────────────────────────────────────────────────────────────────────

const same = (a: Value, b: Value) => a === b

export function diffSettings(baseline: AppSettings, draft: AppSettings): Change[] {
  const out: Change[] = []
  for (const f of FIELDS) {
    const a = getValue(baseline, f.path)
    const b = getValue(draft, f.path)
    if (!same(a, b)) out.push({ path: f.path, card: f.card, label: f.label, from: formatValue(f.path, a), to: formatValue(f.path, b) })
  }
  const ids = [...new Set([...baseline.paymentMethods, ...draft.paymentMethods].map((m) => m.id))]
  for (const id of ids) {
    const name = methodName(id, draft, baseline)
    const before = findMethod(baseline, id)
    const after = findMethod(draft, id)
    if (!before || !after) {
      out.push({
        path: `paymentMethods[${id}]`,
        card: 'payments',
        label: `Metode pembayaran ${name}`,
        from: before ? 'ada' : 'tidak ada',
        to: after ? 'ditambahkan' : 'dihapus',
      })
      continue
    }
    for (const field of ['isEnabled', 'isCash'] as const) {
      const path = `paymentMethods[${id}].${field}`
      const a = getValue(baseline, path)
      const b = getValue(draft, path)
      if (!same(a, b)) out.push({ path, card: 'payments', label: `Metode ${name}: ${FIELD_LABEL[field]}`, from: formatValue(path, a), to: formatValue(path, b) })
    }
  }
  const roles = [...new Set([...(baseline.receiveApproverRoles ?? []), ...(draft.receiveApproverRoles ?? [])])]
  for (const role of roles) {
    const path = `receiveApproverRoles[${role}]`
    const a = getValue(baseline, path)
    const b = getValue(draft, path)
    if (!same(a, b)) out.push({ path, card: 'transfer', label: `Penyetuju transfer: ${role}`, from: formatValue(path, a), to: formatValue(path, b) })
  }
  return out
}

/** Cards and tabs that hold at least one change, for the dirty cues. */
export function dirtyMarkers(changes: readonly Change[]): { cards: ReadonlySet<CardId>; tabs: ReadonlySet<TabId> } {
  const cards = new Set(changes.map((c) => c.card))
  return { cards, tabs: new Set([...cards].map((c) => CARD_TAB[c])) }
}

/** "Bayar terpisah: aktif · Metode QRIS: aktif: nonaktif" style list for the SaveBar. */
export const summarize = (changes: readonly Change[]): string[] => changes.map((c) => `${c.label}: ${c.to}`)

// ── conflicts, rebase, save body ──────────────────────────────────────────────

/** Fields the admin changed that someone else also changed on the server since the baseline. */
export function findConflicts(baseline: AppSettings, fresh: AppSettings, draft: AppSettings, changes: readonly Change[]): Conflict[] {
  const out: Conflict[] = []
  for (const c of changes) {
    const theirs = getValue(fresh, c.path)
    if (same(theirs, getValue(baseline, c.path)) || same(theirs, getValue(draft, c.path))) continue
    out.push({ path: c.path, label: c.label, mine: c.to, theirs: formatValue(c.path, theirs) })
  }
  return out
}

export interface DraftState {
  baseline: AppSettings
  draft: AppSettings
}

/** Resolve one conflict. "mine" keeps the draft value; "theirs" takes the server value. Either way the baseline moves to the server value. */
export function resolveConflict(state: DraftState, fresh: AppSettings, rawPath: string, choice: 'mine' | 'theirs'): DraftState {
  // A field of a method another admin deleted can only be settled at the method level.
  const method = METHOD_RE.exec(rawPath)
  const path = method && method[2] && !findMethod(fresh, method[1]) ? `paymentMethods[${method[1]}]` : rawPath
  return {
    baseline: copyPath(state.baseline, path, fresh),
    draft: choice === 'theirs' ? copyPath(state.draft, path, fresh) : state.draft,
  }
}

/**
 * A poll result arrived: every field the admin has NOT changed takes the server value (draft and
 * baseline); changed fields keep their draft AND their old baseline, so "sebelumnya" stays true
 * and the save-time conflict check still sees what moved underneath.
 */
export function rebaseOnFresh(state: DraftState, fresh: AppSettings): DraftState {
  let baseline = fresh
  let draft = fresh
  for (const c of diffSettings(state.baseline, state.draft)) {
    baseline = copyPath(baseline, c.path, state.baseline)
    draft = copyPath(draft, c.path, state.draft)
  }
  return { baseline, draft }
}

/** The server's current settings with only the admin's changes applied. */
export function applyChanges(fresh: AppSettings, draft: AppSettings, changes: readonly Change[]): AppSettings {
  return changes.reduce((acc, c) => copyPath(acc, c.path, draft), fresh)
}

/**
 * The PUT body: an explicit pick, never a spread of the fresh object (the GET also returns the
 * present-only keys, and re-sending them could undo a concurrent "Bayar terpisah" flip).
 */
export function buildSaveBody(rawFresh: Partial<AppSettings>, fresh: AppSettings, draft: AppSettings, changes: readonly Change[]): AppSettings {
  const merged = applyChanges(fresh, draft, changes)
  const touched = (prefix: string) => changes.some((c) => c.path === prefix || c.path.startsWith(`${prefix}.`) || c.path.startsWith(`${prefix}[`))
  const body: Record<string, unknown> = {}
  for (const k of ALWAYS_KEYS) body[k] = merged[k]
  // The resolved cash flag is persisted for every method, but only when the list changed: otherwise the server's own list goes back untouched.
  body.paymentMethods = touched('paymentMethods')
    ? merged.paymentMethods.map((m) => ({ ...m, isCash: isCashMethod(merged.paymentMethods, m.id) }))
    : (rawFresh.paymentMethods ?? merged.paymentMethods)
  body.receiveApproverRoles = touched('receiveApproverRoles') ? merged.receiveApproverRoles : (rawFresh.receiveApproverRoles ?? [])
  for (const k of ['recipesEnabled', 'inventoryApprovalRequired', 'splitTenderEnabled'] as const) {
    if (touched(k)) body[k] = !!merged[k]
  }
  if (touched('documents')) body.documents = { ...merged.documents }
  return body as unknown as AppSettings
}
