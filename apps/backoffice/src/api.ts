import { createClient } from '@mandalika/api'

// Mutable auth holder shared between the API client and the AuthProvider,
// avoiding a provider↔client import cycle.
export const authStore: {
  access: string | null
  onUnauthorized: (() => void) | null
} = { access: null, onUnauthorized: null }

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

export const api = createClient({
  baseUrl,
  getToken: () => authStore.access,
  onUnauthorized: () => authStore.onUnauthorized?.(),
})
