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
