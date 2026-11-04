import { createClient, type Api, type AuthData } from '@mandalika/api'

// Mutable auth holder shared between the API client and the providers,
// avoiding a provider↔client import cycle. `outletId` drives X-Outlet-Id
// (admin outlet switcher); null = use the token's own outlet.
export const authStore: {
  access: string | null
  refresh: string | null
  outletId: string | null
  /** The signed-in user's id; part of the shared-cache scope so one login never reads another's lists. */
  userId: string | null
  onUnauthorized: (() => void) | null
  onTokens: ((d: AuthData) => void) | null
} = {
  access: null,
  refresh: null,
  outletId: null,
  userId: null,
  onUnauthorized: null,
  onTokens: null,
}

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

const client = createClient({
  baseUrl,
  getToken: () => authStore.access,
  getOutletId: () => authStore.outletId,
  getRefresh: () => authStore.refresh,
  onTokens: (d) => authStore.onTokens?.(d),
  onUnauthorized: () => authStore.onUnauthorized?.(),
})

/**
 * Called after a write that changes a product, a variant, an outlet's product config or stock. The shared
 * product list (lib/productCatalogue) registers here, so this module needs no import of it.
 */
export const catalogueSignal: { onChanged: (() => void) | null } = { onChanged: null }

const CATALOGUE_WRITES = [
  'createProduct',
  'updateProduct',
  'deleteProduct',
  'updateProductOutletConfig',
  'importCsv',
  'completeStockCount',
  'submitStockCount',
  'adjustLocationStock',
  'setOutletPar',
  'createTransfer',
  'receiveTransfer',
] as const satisfies ReadonlyArray<keyof Api>

/** The client with the catalogue-changing writes wrapped: once settled (even failed: it may half-apply) => signal. */
export function withCatalogueSignal(base: Api): Api {
  const wrapped: Api = { ...base }
  for (const name of CATALOGUE_WRITES) {
    const write = base[name] as (...args: unknown[]) => Promise<unknown>
    ;(wrapped as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      try {
        return await write(...args)
      } finally {
        // An import preview (dry run) writes nothing.
        const dryRun = name === 'importCsv' && (args[1] as { dryRun?: boolean } | undefined)?.dryRun === true
        if (!dryRun) catalogueSignal.onChanged?.()
      }
    }
  }
  return wrapped
}

export const api: Api = withCatalogueSignal(client)
