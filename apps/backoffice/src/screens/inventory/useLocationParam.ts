import { useMemo } from 'react'
import { DEFAULT_TIMEZONE } from '../../lib/businessDay'
import { parseLocationKey, useLocations, type LocationsState } from './useLocations'

/**
 * `useLocations` with the picked location in the URL. An empty `urlKey` means the default location, which stays
 * implicit: nothing is written to the URL until the user picks one (the page owner passes the setter).
 */
export function useLocationParam(urlKey: string): LocationsState {
  const loc = useLocations(urlKey)
  const locationKey = urlKey || loc.locationKey
  const location = useMemo(() => parseLocationKey(locationKey), [locationKey])
  const zone =
    location?.type === 'outlet' ? (loc.outlets.find((o) => o.id === location.id)?.timezone ?? DEFAULT_TIMEZONE) : DEFAULT_TIMEZONE
  return { ...loc, locationKey, location, zone }
}
