import type { Promotion, PromotionInput } from '@mandalika/api'
import { promotionKeyError } from './promotionKeyValidation'

export type PromoType = PromotionInput['type']

/** A problem with one field. `required` is held back until the form has been touched (a new form opens quiet). */
export interface FormProblem {
  /** DOM id of the field, so the summary can focus it. */
  fieldId: string
  /** Short name for the error summary. */
  label: string
  message: string
  kind: 'required' | 'invalid'
}

export const PROMO_FIELD = {
  name: 'promo-name',
  products: 'promo-products',
  tiers: 'promo-tiers',
  bundle: 'promo-bundle',
  hours: 'promo-hours-from',
  maxApplications: 'promo-max-applications',
} as const

export type BxgyConfig = NonNullable<PromotionInput['bxgyConfig']>
export type TierRow = { minSubtotal: number; kind: 'percentage' | 'fixed'; value: number }
export type BundleSlotRow = { productKeys: string[]; quantity: number }
export type BundleConfig = { slots: BundleSlotRow[]; bundlePrice: number; maxApplications: number }

export const DEFAULT_BXGY: BxgyConfig & { maxApplications: number } = {
  buyQuantity: 2,
  getQuantity: 1,
  buyProductIds: [],
  getProductIds: [],
  getDiscountKind: 'percentage',
  getDiscountValue: 100,
  maxApplications: 0,
}
export const DEFAULT_TIERED: { tiers: TierRow[] } = { tiers: [{ minSubtotal: 100000, kind: 'percentage', value: 10 }] }
export const DEFAULT_BUNDLE: BundleConfig = { slots: [{ productKeys: [], quantity: 1 }], bundlePrice: 0, maxApplications: 0 }

export const EMPTY_PROMO: PromotionInput = {
  name: '', description: '', type: 'percentage', value: 0, minPurchase: 0,
  applicableProductIds: [], applicableVariantKeys: [], isActive: true,
  combinable: false, codeOnly: false, outletIds: [], activeFromHour: '', activeToHour: '', activeDays: [],
}

/**
 * The editable form of a stored promotion. EVERY field of PromotionInput is carried, including the two the form
 * has no control for (`applicableVariantSizes`, `combinableWith`): the server rewrites every column on a PUT, so a
 * field left out here would be wiped by an untouched edit, a duplicate or a status switch. Nulls stay null (never
 * `|| 0` / `?? false`) so an untouched save changes nothing. Used by edit, duplicate, the status Switch and undo.
 */
export function promotionToInput(p: Promotion): PromotionInput {
  return {
    name: p.name,
    description: p.description ?? undefined,
    type: p.type,
    value: p.value,
    minPurchase: p.minPurchase ?? null,
    applicableProductIds: p.applicableProductIds ?? undefined,
    applicableVariantKeys: p.applicableVariantKeys ?? undefined,
    applicableVariantSizes: p.applicableVariantSizes ?? undefined,
    outletIds: p.outletIds ?? undefined,
    combinable: p.combinable ?? null,
    combinableWith: p.combinableWith ?? undefined,
    activeFromHour: p.activeFromHour ?? undefined,
    activeToHour: p.activeToHour ?? undefined,
    activeDays: p.activeDays ?? undefined,
    isActive: p.isActive,
    startDate: p.startDate ?? undefined,
    endDate: p.endDate ?? undefined,
    codeOnly: p.codeOnly,
    bxgyConfig: p.bxgyConfig ?? null,
    tieredConfig: p.tieredConfig ?? null,
    bundleConfig: p.bundleConfig ?? null,
  }
}

/** A copy for "Duplikat": same body, a suffixed name, and always inactive: a copy must not reach tablets unasked (D-79). */
export const duplicateInput = (p: Promotion): PromotionInput => ({ ...promotionToInput(p), name: `${p.name} (Salinan)`, isActive: false })

const tiersOf = (form: PromotionInput): TierRow[] => (form.tieredConfig?.tiers ?? []) as TierRow[]
const slotsOf = (form: PromotionInput): BundleSlotRow[] => (form.bundleConfig?.slots ?? []) as BundleSlotRow[]

function tieredMessage(tiers: TierRow[]): string | null {
  if (tiers.length === 0) return 'Harus ada minimal 1 tingkat.'
  const seen = new Set<number>()
  for (const t of tiers) {
    if (t.minSubtotal < 0) return 'Min. belanja tidak boleh negatif.'
    if (t.kind !== 'percentage' && t.kind !== 'fixed') return 'Tipe diskon tidak valid.'
    if (t.kind === 'percentage' && (t.value <= 0 || t.value > 100)) return 'Persentase harus antara 0 dan 100.'
    if (t.kind === 'fixed' && t.value <= 0) return 'Nominal harus lebih dari 0.'
    if (seen.has(t.minSubtotal)) return `Min. belanja Rp ${t.minSubtotal.toLocaleString('id-ID')} duplikat.`
    seen.add(t.minSubtotal)
  }
  return null
}

// Mirrors backend write.validateBundle: >=1 slot, each slot has >=1 key and quantity >= 1, bundlePrice > 0,
// and no productKey may appear in two slots.
function bundleMessage(form: PromotionInput, slots: BundleSlotRow[]): string | null {
  if (slots.length === 0) return 'Harus ada minimal 1 slot.'
  const seen = new Set<string>()
  for (const s of slots) {
    if (!s.productKeys || s.productKeys.length === 0) return 'Setiap slot harus punya minimal 1 produk.'
    if (s.quantity < 1) return 'Jumlah tiap slot minimal 1.'
    for (const k of s.productKeys) {
      if (seen.has(k)) return 'Produk tidak boleh dipakai di lebih dari satu slot.'
      seen.add(k)
    }
  }
  if (!form.bundleConfig || form.bundleConfig.bundlePrice <= 0) return 'Harga paket harus lebih dari 0.'
  return null
}

function hoursMessage(form: PromotionInput): string | null {
  const from = form.activeFromHour || ''
  const to = form.activeToHour || ''
  if ((from === '') !== (to === '')) return 'Isi kedua jam aktif atau kosongkan keduanya.'
  if (from !== '' && to !== '' && from > to) return 'Jam mulai harus lebih awal dari jam selesai (rentang lewat tengah malam tidak didukung).'
  return null
}

function maxApplicationsMessage(form: PromotionInput): string | null {
  if (form.type === 'buy_x_get_y' && (form.bxgyConfig?.maxApplications ?? 0) < 0) return 'Maks/transaksi tidak boleh negatif.'
  if (form.type === 'bundle' && (form.bundleConfig?.maxApplications ?? 0) < 0) return 'Maks. kelipatan tidak boleh negatif.'
  return null
}

/** Every problem that blocks a save, in form order. Empty means the form may be saved. */
export function promotionProblems(form: PromotionInput): FormProblem[] {
  const out: FormProblem[] = []
  const add = (fieldId: string, label: string, message: string | null, kind: FormProblem['kind'] = 'invalid') => {
    if (message) out.push({ fieldId, label, message, kind })
  }
  if (!form.name.trim()) add(PROMO_FIELD.name, 'Nama promosi', 'Nama promosi wajib diisi.', 'required')
  add(PROMO_FIELD.hours, 'Jam aktif', hoursMessage(form))
  add(PROMO_FIELD.products, 'Produk promosi', promotionKeyError(form))
  if (form.type === 'tiered') add(PROMO_FIELD.tiers, 'Tingkatan diskon', tieredMessage(tiersOf(form)))
  if (form.type === 'bundle') add(PROMO_FIELD.bundle, 'Slot paket', bundleMessage(form, slotsOf(form)))
  add(PROMO_FIELD.maxApplications, 'Batas penerapan', maxApplicationsMessage(form))
  return out
}
