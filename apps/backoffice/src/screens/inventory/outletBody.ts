import type { Outlet, OutletInput } from '@mandalika/api'
import { DEFAULT_TIMEZONE } from '../../lib/businessDay'

export interface OutletFormValues {
  name: string
  code: string
  address: string
  phone: string
  isActive: boolean
  logoUrl: string | undefined
  timezone: NonNullable<OutletInput['timezone']>
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
    timezone: form.timezone,
  }
}

/** The body for the active/inactive toggle: it must send the outlet's own timezone back. */
export function outletToggleBody(o: Outlet): OutletInput {
  return {
    name: o.name,
    code: o.code || '',
    address: o.address || '',
    phone: o.phone || '',
    logoUrl: o.logoUrl ?? null,
    isActive: !o.isActive,
    timezone: o.timezone ?? DEFAULT_TIMEZONE,
  }
}
