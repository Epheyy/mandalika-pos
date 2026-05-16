import { createClient } from '@mandalika/api'

// Mutable auth holder shared between the API client and the AuthProvider.
// Phase E moves token storage to Capacitor secure storage.
export const authStore: {
  access: string | null
  outletId: string | null
  onUnauthorized: (() => void) | null
} = { access: null, outletId: null, onUnauthorized: null }

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

export const api = createClient({
  baseUrl,
  getToken: () => authStore.access,
  getOutletId: () => authStore.outletId,
  onUnauthorized: () => authStore.onUnauthorized?.(),
})
