/**
 * POS-side promo/discount-code validator — a pure TS port of
 * backend/internal/service/promo_validate.go (SP-Promo-1). Kept in lockstep
 * with promo_validate_test.go via promoValidate.test.ts to prevent Go/TS drift.
 *
 * The POS submits every order offline through the /sync outbox, which the server
 * processes leniently (records + flags, never 422). So this is the SOLE real-time
 * guard against an invalid discount being applied at the POS.
 */

import type { components } from '@mandalika/api'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

export type Violation =
  | 'not_started'
  | 'expired'
  | 'below_min_purchase'
  | 'wrong_day'
  | 'outside_hours'
  | 'wrong_outlet'
  | 'usage_limit_reached'

export interface PromoEvalContext {
  now: Date
  outletId: string
  subtotal: number
}

// Fixed WIB offset (UTC+7, no DST) so validation matches the server regardless
// of the device's local zone. Mirrors the Go validator's fixed `wib` zone.
const WIB_OFFSET_MIN = 7 * 60

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

// Wall-clock parts of `now` in WIB. We shift the UTC epoch by +7h then read the
// UTC getters, which yields the WIB calendar date / weekday / HH:MM.
function wibParts(now: Date): { dateStr: string; weekday: number; hhmm: string } {
  const w = new Date(now.getTime() + WIB_OFFSET_MIN * 60_000)
  const dateStr = `${w.getUTCFullYear()}-${pad2(w.getUTCMonth() + 1)}-${pad2(w.getUTCDate())}`
  return { dateStr, weekday: w.getUTCDay(), hhmm: `${pad2(w.getUTCHours())}:${pad2(w.getUTCMinutes())}` }
}

// Normalize an API date that may be "YYYY-MM-DD" or a full ISO datetime to a
// calendar-date string for lexicographic (== calendar) comparison.
function dateOnly(s: string): string {
  return s.slice(0, 10)
}

export function validatePromo(p: Promotion, ctx: PromoEvalContext): Violation[] {
  const v: Violation[] = []
  const { dateStr, weekday, hhmm } = wibParts(ctx.now)

  if (p.startDate && dateStr < dateOnly(p.startDate)) v.push('not_started')
  if (p.endDate && dateStr > dateOnly(p.endDate)) v.push('expired')
  if (p.minPurchase != null && ctx.subtotal < p.minPurchase) v.push('below_min_purchase')
  if (p.activeDays && p.activeDays.length > 0 && !p.activeDays.includes(weekday)) v.push('wrong_day')
  // Both bounds required to gate; a half-set window is treated as no constraint.
  if (p.activeFromHour && p.activeToHour) {
    if (hhmm < p.activeFromHour || hhmm > p.activeToHour) v.push('outside_hours')
  }
  if (p.outletIds && p.outletIds.length > 0 && !p.outletIds.includes(ctx.outletId)) v.push('wrong_outlet')
  return v
}

export function validateCode(c: DiscountCode, ctx: PromoEvalContext): Violation[] {
  const v: Violation[] = []
  const { dateStr } = wibParts(ctx.now)

  if (c.startDate && dateStr < dateOnly(c.startDate)) v.push('not_started')
  if (c.endDate && dateStr > dateOnly(c.endDate)) v.push('expired')
  if (c.minPurchase != null && ctx.subtotal < c.minPurchase) v.push('below_min_purchase')
  // usage_limit of 0 (or absent) means UNLIMITED — only enforce a positive cap.
  if (c.usageLimit != null && c.usageLimit > 0 && c.usageCount >= c.usageLimit) {
    v.push('usage_limit_reached')
  }
  return v
}

const MESSAGES: Record<Violation, string> = {
  not_started: 'Promo belum dimulai',
  expired: 'Sudah kadaluarsa',
  below_min_purchase: 'Belum memenuhi minimum belanja',
  outside_hours: 'Tidak berlaku pada jam ini',
  wrong_day: 'Tidak berlaku hari ini',
  wrong_outlet: 'Tidak berlaku di outlet ini',
  usage_limit_reached: 'Kuota kode diskon sudah habis',
}

export function violationMessage(v: Violation): string {
  return MESSAGES[v]
}
