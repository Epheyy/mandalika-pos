import { useEffect, useState } from 'react'
import type { Outlet, Warehouse } from '@mandalika/api'
import { api } from '../../api'
import { DEFAULT_TIMEZONE } from '../../lib/businessDay'
import { usePolledQuery } from '../../hooks/usePolledQuery'

export type LocationType = 'outlet' | 'warehouse'

export interface LocationRef {
  type: LocationType
  id: string
}

/** A location picker value is `outlet:<id>` or `warehouse:<id>`. */
export function parseLocationKey(key: string): LocationRef | null {
  const idx = key.indexOf(':')
  if (idx < 0) return null
  return { type: key.slice(0, idx) as LocationType, id: key.slice(idx + 1) }
}

export interface LocationsState {
  outlets: Outlet[]
  warehouses: Warehouse[]
  locationKey: string
  setLocationKey: (key: string) => void
  location: LocationRef | null
  /** Timezone the picked days are read in: the outlet's own, or Asia/Jakarta for a warehouse. */
  zone: string
}

/** Outlets + warehouses and the selected location (first active outlet by default). */
export function useLocations(initialKey = ''): LocationsState {
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const outlets = ouq.data ?? []
  const warehouses = wq.data ?? []
  const [locationKey, setLocationKey] = useState(initialKey)

  const defaultKey = (() => {
    const active = outlets.find((o) => o.isActive) ?? outlets[0]
    if (active) return `outlet:${active.id}`
    if (warehouses.length) return `warehouse:${warehouses[0].id}`
    return ''
  })()

  useEffect(() => {
    if (!locationKey && defaultKey) setLocationKey(defaultKey)
  }, [defaultKey, locationKey])

  const location = parseLocationKey(locationKey)
  const zone =
    location?.type === 'outlet' ? (outlets.find((o) => o.id === location.id)?.timezone ?? DEFAULT_TIMEZONE) : DEFAULT_TIMEZONE
  return { outlets, warehouses, locationKey, setLocationKey, location, zone }
}
