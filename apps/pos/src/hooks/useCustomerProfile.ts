import { useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'

export type CustomerProfile = components['schemas']['CustomerProfile']
export type ProfileStatus = 'loading' | 'ready' | 'unavailable'

const isProfile = (v: unknown): v is CustomerProfile =>
  typeof v === 'object' && v !== null && typeof (v as CustomerProfile).customer === 'object' && (v as CustomerProfile).customer !== null && Array.isArray((v as CustomerProfile).lastOrders)

/** B3: the server profile of the customer whose sheet is open. Online only; a 404 (backend not deployed yet),
 *  a 429 or any failure is "unavailable" and the sheet shows this tablet's receipts instead. */
export function useCustomerProfile(customerId: string | null, online: boolean): { status: ProfileStatus; profile: CustomerProfile | null } {
  const [state, setState] = useState<{ id: string; status: ProfileStatus; profile: CustomerProfile | null } | null>(null)
  const wanted = customerId !== null && online

  useEffect(() => {
    if (!wanted) return
    let ignore = false
    api
      .customerProfile(customerId)
      .then((profile) => {
        if (ignore) return
        // A proxy or an old backend can answer 200 with something else: only a real profile counts.
        setState(isProfile(profile) ? { id: customerId, status: 'ready', profile } : { id: customerId, status: 'unavailable', profile: null })
      })
      .catch(() => { if (!ignore) setState({ id: customerId, status: 'unavailable', profile: null }) })
    return () => { ignore = true }
  }, [wanted, customerId])

  if (customerId === null) return { status: 'unavailable', profile: null }
  if (!online) return { status: 'unavailable', profile: null }
  if (state === null || state.id !== customerId) return { status: 'loading', profile: null }
  return { status: state.status, profile: state.profile }
}
