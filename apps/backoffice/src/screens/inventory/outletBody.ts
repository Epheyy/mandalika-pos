import type { Outlet, OutletInput } from '@mandalika/api'

export interface OutletFormValues {
  name: string
  code: string
  address: string
  phone: string
  isActive: boolean
  logoUrl: string | undefined
  /** Undefined when an edited outlet carries none: the key is then omitted and the server keeps its zone. */
  timezone?: OutletInput['timezone']
}

/** The request body for creating or editing an outlet; always carries the chosen timezone. */
export function outletFormBody(form: OutletFormValues, code: string): OutletInput {
  return {
    name: form.name.trim(),
    code,
    address: form.address.trim(),
    phone: form.phone.trim(),
    isActive: form.isActive,
    logoUrl: form.logoUrl ?? null,
    ...(form.timezone ? { timezone: form.timezone } : {}),
  }
}

/** The body for the active/inactive toggle: sends the outlet's own timezone back, or omits it when unknown. */
export function outletToggleBody(o: Outlet): OutletInput {
  return {
    name: o.name,
    code: o.code || '',
    address: o.address || '',
    phone: o.phone || '',
    logoUrl: o.logoUrl ?? null,
    isActive: !o.isActive,
    ...(o.timezone ? { timezone: o.timezone } : {}),
  }
}

/** ERP-length outlet code: 2-20 chars of A-Z/0-9/hyphen, starting and ending with a letter or digit. */
export const OUTLET_CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$/

export function isValidOutletCode(code: string): boolean {
  return OUTLET_CODE_RE.test(code)
}

/**
 * Order-number prefix the tablet derives from an outlet code: uppercase, strip non A-Z0-9,
 * first 4. Keep in sync with outletPart in apps/pos/src/cashier/orderRef.ts. Empty code shows JKT.
 */
export function outletOrderPrefix(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'JKT'
}
