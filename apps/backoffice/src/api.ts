import { createClient, type AuthData } from '@mandalika/api'

// Mutable auth holder shared between the API client and the providers,
// avoiding a provider↔client import cycle. `outletId` drives X-Outlet-Id
// (admin outlet switcher); null = use the token's own outlet.
export const authStore: {
  access: string | null
  refresh: string | null
  outletId: string | null
  onUnauthorized: (() => void) | null
  onTokens: ((d: AuthData) => void) | null
} = {
  access: null,
  refresh: null,
  outletId: null,
  onUnauthorized: null,
  onTokens: null,
}

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

export const api = createClient({
  baseUrl,
  getToken: () => authStore.access,
  getOutletId: () => authStore.outletId,
  getRefresh: () => authStore.refresh,
  onTokens: (d) => authStore.onTokens?.(d),
  onUnauthorized: () => authStore.onUnauthorized?.(),
})
