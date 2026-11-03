import { useSyncExternalStore } from 'react'
import type { Location } from './hash'
import { getRouteLocation, getServerRouteLocation, subscribeRoute } from './navigate'

/** The current hash location. Re-renders on every move; the object is stable between moves. */
export function useRoute(): Location {
  return useSyncExternalStore(subscribeRoute, getRouteLocation, getServerRouteLocation)
}
