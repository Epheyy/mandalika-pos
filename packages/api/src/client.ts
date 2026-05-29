import type { components } from './schema'

type S = components['schemas']

export type User = S['User']
export type AuthData = S['AuthData']
export type Outlet = S['Outlet']
export type Category = S['Category']
export type Product = S['Product']
export type ProductVariant = S['ProductVariant']
export type Bundle = S['Bundle']
export type Customer = S['Customer']
export type Promotion = S['Promotion']
export type DiscountCode = S['DiscountCode']
export type LoyaltyCondition = S['LoyaltyCondition']
export type LoyaltySettings = S['LoyaltySettings']
export type AppSettings = S['AppSettings']
export type Order = S['Order']
export type CartItem = S['CartItem']
export type Shift = S['Shift']
export type StockCount = S['StockCount']
export type StockCountItem = S['StockCountItem']
export type CashFlow = S['CashFlow']
export type ErrorLog = S['ErrorLog']
export type CustomRole = S['CustomRole']
export type ReportSummary = S['ReportSummary']
export type Meta = S['Meta']
export type Warehouse = S['Warehouse']
export type WarehouseStockRow = S['WarehouseStockRow']
export type Transfer = S['Transfer']
export type TransferItem = S['TransferItem']
export type TransferLocation = S['TransferLocation']
export type TransferCreateInput = S['TransferCreateInput']
export type TransferReceiveInput = S['TransferReceiveInput']
export type Ingredient = S['Ingredient']
export type IngredientInput = S['IngredientInput']
export type IngredientCategory = S['IngredientCategory']
export type IngredientCategoryInput = S['IngredientCategoryInput']
export type IngredientStockRow = S['IngredientStockRow']
export type IngredientGoodsReceiptInput = S['IngredientGoodsReceiptInput']
export type IngredientAdjustInput = S['IngredientAdjustInput']
export type IngredientTransfer = S['IngredientTransfer']
export type IngredientTransferItem = S['IngredientTransferItem']
export type IngredientTransferCreateInput = S['IngredientTransferCreateInput']
export type IngredientTransferReceiveInput = S['IngredientTransferReceiveInput']
export type IngredientStockCount = S['IngredientStockCount']
export type IngredientStockCountItem = S['IngredientStockCountItem']
export type IngredientStockCountInput = S['IngredientStockCountInput']
export type IngredientStockCountSaveInput = S['IngredientStockCountSaveInput']
export type Recipe = S['Recipe']
export type RecipeIngredientLine = S['RecipeIngredientLine']
export type RecipeVersionSummary = S['RecipeVersionSummary']
export type RecipeSaveInput = S['RecipeSaveInput']
export type RecipeRestoreInput = S['RecipeRestoreInput']

export type ProductInput = S['ProductInput']
export type CategoryInput = S['CategoryInput']
export type CustomerInput = S['CustomerInput']
export type PromotionInput = S['PromotionInput']
export type DiscountCodeInput = S['DiscountCodeInput']
export type OutletInput = S['OutletInput']
export type OutletVariantConfig = S['OutletVariantConfig']
export type CreateUserRequest = S['CreateUserRequest']
export type UpdateUserRequest = S['UpdateUserRequest']
export type SetReceivePinRequest = S['SetReceivePinRequest']
export type UploadSignature = S['UploadSignature']
export type WarehouseInput = S['WarehouseInput']
export type GoodsReceiptInput = S['GoodsReceiptInput']
export type WarehouseAdjustInput = S['WarehouseAdjustInput']

export interface ClientOptions {
  baseUrl: string
  /** Returns the current access token, or null when unauthenticated. */
  getToken: () => string | null
  /** Active outlet id sent as X-Outlet-Id (null = use token's outlet). */
  getOutletId?: () => string | null
  /** Invoked on a 401 so the app can clear auth / redirect to login. */
  onUnauthorized?: () => void
  /** Stored refresh token. When present, a 401 triggers a silent
   *  refresh+retry instead of an immediate logout — so a short access TTL
   *  never interrupts an active session. */
  getRefresh?: () => string | null
  /** Called with the new tokens after a silent refresh so the app can
   *  persist them (access in memory, refresh in secure storage). */
  onTokens?: (d: AuthData) => void
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ListResult<T> {
  data: T[]
  meta?: Meta
}

const API = '/api/v1'

export interface Api {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>

  // auth
  login: (email: string, password: string) => Promise<AuthData>
  refresh: (refresh: string) => Promise<AuthData>
  logout: (refresh: string) => Promise<void>
  me: () => Promise<User>

  // outlets
  listOutlets: () => Promise<Outlet[]>
  createOutlet: (input: OutletInput) => Promise<Outlet>
  updateOutlet: (id: string, input: OutletInput) => Promise<Outlet>

  // products / categories / bundles
  listProducts: (page?: number, limit?: number) => Promise<ListResult<Product>>
  createProduct: (input: ProductInput) => Promise<Product>
  updateProduct: (id: string, input: ProductInput) => Promise<Product>
  deleteProduct: (id: string) => Promise<void>
  /** Single product at base/all-outlet scope (base price, summed stock). */
  getProduct: (id: string) => Promise<Product>
  getProductOutletConfig: (id: string) => Promise<OutletVariantConfig[]>
  updateProductOutletConfig: (id: string, items: OutletVariantConfig[]) => Promise<void>
  listCategories: () => Promise<Category[]>
  createCategory: (input: CategoryInput) => Promise<Category>
  updateCategory: (id: string, input: CategoryInput) => Promise<Category>
  deleteCategory: (id: string) => Promise<void>
  listBundles: () => Promise<Bundle[]>

  // customers
  listCustomers: (page?: number, limit?: number) => Promise<ListResult<Customer>>
  createCustomer: (input: CustomerInput) => Promise<Customer>
  updateCustomer: (id: string, input: CustomerInput) => Promise<Customer>
  deleteCustomer: (id: string) => Promise<void>

  // loyalty
  listLoyaltyConditions: () => Promise<LoyaltyCondition[]>
  createLoyaltyCondition: (input: Partial<LoyaltyCondition>) => Promise<LoyaltyCondition>
  updateLoyaltyCondition: (id: string, input: Partial<LoyaltyCondition>) => Promise<LoyaltyCondition>
  deleteLoyaltyCondition: (id: string) => Promise<void>
  getLoyaltySettings: () => Promise<LoyaltySettings>
  updateLoyaltySettings: (input: LoyaltySettings) => Promise<LoyaltySettings>

  // promotions / discount codes
  listPromotions: () => Promise<Promotion[]>
  createPromotion: (input: PromotionInput) => Promise<Promotion>
  updatePromotion: (id: string, input: PromotionInput) => Promise<Promotion>
  deletePromotion: (id: string) => Promise<void>
  listDiscountCodes: () => Promise<DiscountCode[]>
  createDiscountCode: (input: DiscountCodeInput) => Promise<DiscountCode>
  updateDiscountCode: (id: string, input: DiscountCodeInput) => Promise<DiscountCode>
  deleteDiscountCode: (id: string) => Promise<void>

  // orders / shifts
  listOrders: (params?: Record<string, string | number>) => Promise<ListResult<Order>>
  getOrder: (id: string) => Promise<Order>
  refundOrder: (id: string, reason: string) => Promise<Order>
  listShifts: (params?: Record<string, string | number>) => Promise<ListResult<Shift>>
  listErrorLogs: (params?: Record<string, string | number>) => Promise<ListResult<ErrorLog>>

  // stock counts
  listStockCounts: (page?: number, limit?: number) => Promise<ListResult<StockCount>>
  getStockCount: (id: string) => Promise<StockCount>
  createStockCount: (input: {
    name: string
    outletId?: string
    warehouseId?: string
    plannedDate?: string
    notes?: string
    items: StockCountItem[]
  }) => Promise<StockCount>
  updateStockCount: (id: string, input: Partial<StockCount>) => Promise<StockCount>
  completeStockCount: (id: string, items: StockCountItem[]) => Promise<StockCount>

  // warehouses / inventory
  listWarehouses: () => Promise<Warehouse[]>
  createWarehouse: (input: WarehouseInput) => Promise<{ id: string }>
  updateWarehouse: (id: string, input: WarehouseInput) => Promise<void>
  deleteWarehouse: (id: string) => Promise<void>
  getWarehouseStock: (id: string) => Promise<WarehouseStockRow[]>
  createGoodsReceipt: (id: string, input: GoodsReceiptInput) => Promise<void>
  adjustWarehouseStock: (id: string, input: WarehouseAdjustInput) => Promise<void>

  // transfers (SP2)
  listTransfers: (status?: string, page?: number, limit?: number) => Promise<ListResult<Transfer>>
  getTransfer: (id: string) => Promise<Transfer>
  getTransferLocationStock: (kind: string, id: string) => Promise<WarehouseStockRow[]>
  createTransfer: (input: TransferCreateInput) => Promise<{ id: string }>
  updateTransfer: (id: string, input: TransferCreateInput) => Promise<void>
  sendTransfer: (id: string) => Promise<void>
  receiveTransfer: (id: string, input: TransferReceiveInput) => Promise<void>
  cancelTransfer: (id: string) => Promise<void>

  // ingredients / recipe inventory (SP-Recipe-1)
  listIngredients: (opts?: { page?: number; limit?: number; q?: string }) => Promise<ListResult<Ingredient>>
  createIngredient: (input: IngredientInput) => Promise<void>
  updateIngredient: (id: string, input: IngredientInput) => Promise<void>
  deleteIngredient: (id: string) => Promise<void>
  listIngredientCategories: () => Promise<IngredientCategory[]>
  createIngredientCategory: (input: IngredientCategoryInput) => Promise<void>
  updateIngredientCategory: (id: string, input: IngredientCategoryInput) => Promise<void>
  deleteIngredientCategory: (id: string) => Promise<void>
  getIngredientStock: (warehouseId: string) => Promise<IngredientStockRow[]>
  createIngredientGoodsReceipt: (input: IngredientGoodsReceiptInput) => Promise<void>
  adjustIngredientStock: (input: IngredientAdjustInput) => Promise<void>
  listIngredientTransfers: (opts?: { status?: string; page?: number; limit?: number }) => Promise<ListResult<IngredientTransfer>>
  getIngredientTransfer: (id: string) => Promise<IngredientTransfer>
  createIngredientTransfer: (input: IngredientTransferCreateInput) => Promise<void>
  sendIngredientTransfer: (id: string) => Promise<void>
  receiveIngredientTransfer: (id: string, input: IngredientTransferReceiveInput) => Promise<void>
  cancelIngredientTransfer: (id: string, reason: string) => Promise<void>
  listIngredientStockCounts: (opts?: { page?: number; limit?: number }) => Promise<ListResult<IngredientStockCount>>
  getIngredientStockCount: (id: string) => Promise<IngredientStockCount>
  createIngredientStockCount: (input: IngredientStockCountInput) => Promise<void>
  startIngredientStockCount: (id: string) => Promise<void>
  saveIngredientStockCount: (id: string, input: IngredientStockCountSaveInput) => Promise<void>
  completeIngredientStockCount: (id: string) => Promise<void>

  // recipes / formulas (SP-Recipe-2)
  getRecipeVariantIds: (productId: string) => Promise<string[]>
  getVariantRecipe: (productId: string, variantId: string) => Promise<Recipe | null>
  listRecipeVersions: (productId: string, variantId: string) => Promise<RecipeVersionSummary[]>
  getRecipeVersion: (productId: string, variantId: string, versionId: string) => Promise<Recipe>
  saveVariantRecipe: (productId: string, variantId: string, input: RecipeSaveInput) => Promise<{ id: string }>
  restoreRecipeVersion: (productId: string, variantId: string, versionId: string, expectedCurrentVersionId: string | null) => Promise<{ id: string }>

  // users / roles
  listUsers: (page?: number, limit?: number) => Promise<ListResult<User>>
  createUser: (input: CreateUserRequest) => Promise<User>
  updateUser: (id: string, input: UpdateUserRequest) => Promise<User>
  setUserReceivePin: (id: string, input: SetReceivePinRequest) => Promise<void>
  deleteUser: (id: string) => Promise<void>
  listCustomRoles: () => Promise<CustomRole[]>
  createCustomRole: (input: { name: string; permissions: string[] }) => Promise<CustomRole>
  updateCustomRole: (id: string, input: { name: string; permissions: string[] }) => Promise<CustomRole>
  deleteCustomRole: (id: string) => Promise<void>

  // settings / reports / uploads
  getAppSettings: () => Promise<AppSettings>
  updateAppSettings: (input: AppSettings) => Promise<AppSettings>
  reportSummary: (params?: Record<string, string>) => Promise<ReportSummary>
  signUpload: (folder?: string) => Promise<UploadSignature>
}

export function createClient(opts: ClientOptions): Api {
  // De-dupe concurrent refreshes: many requests can 401 at once when the
  // access token expires; they all await the single in-flight refresh.
  let refreshing: Promise<boolean> | null = null

  async function trySilentRefresh(): Promise<boolean> {
    const rt = opts.getRefresh?.()
    if (!rt) return false
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await fetch(`${opts.baseUrl}${API}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh: rt }),
          })
          if (!res.ok) return false
          const j = await res.json()
          const d = (j?.data ?? j) as AuthData
          if (!d?.access) return false
          opts.onTokens?.(d)
          return true
        } catch {
          return false
        } finally {
          refreshing = null
        }
      })()
    }
    return refreshing
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const token = opts.getToken()
      if (token) headers.Authorization = `Bearer ${token}`
      const outlet = opts.getOutletId?.()
      if (outlet) headers['X-Outlet-Id'] = outlet
      return fetch(opts.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }

    let res = await send()
    if (res.status === 401 && !path.includes('/auth/')) {
      // Try one silent refresh+retry before giving up the session.
      if (await trySilentRefresh()) {
        res = await send()
      }
    }
    if (res.status === 401) {
      opts.onUnauthorized?.()
      throw new ApiError(401, 'unauthorized')
    }
    const text = await res.text()
    const json = text ? JSON.parse(text) : null
    if (!res.ok) {
      throw new ApiError(res.status, json?.error ?? `request failed (${res.status})`)
    }
    return json as T
  }

  const qs = (params?: Record<string, string | number>): string => {
    if (!params) return ''
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) p.set(k, String(v))
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  const data = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await request<{ data: T }>(method, path, body)
    return r.data
  }
  const list = async <T>(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<ListResult<T>> => request<ListResult<T>>('GET', path + qs(params))

  return {
    request,

    async login(email, password) {
      return data<AuthData>('POST', `${API}/auth/login`, { email, password })
    },
    async refresh(refresh) {
      return data<AuthData>('POST', `${API}/auth/refresh`, { refresh })
    },
    async logout(refresh) {
      await request<unknown>('POST', `${API}/auth/logout`, { refresh })
    },
    me: () => data<User>('GET', `${API}/auth/me`),

    listOutlets: () => data<Outlet[]>('GET', `${API}/outlets`),
    createOutlet: (input) => data<Outlet>('POST', `${API}/outlets`, input),
    updateOutlet: (id, input) => data<Outlet>('PUT', `${API}/outlets/${id}`, input),

    listProducts: (page = 1, limit = 200) =>
      list<Product>(`${API}/products`, { page, limit }),
    createProduct: (input) => data<Product>('POST', `${API}/products`, input),
    updateProduct: (id, input) => data<Product>('PUT', `${API}/products/${id}`, input),
    deleteProduct: async (id) => {
      await request('DELETE', `${API}/products/${id}`)
    },
    getProduct: (id) => data<Product>('GET', `${API}/products/${id}?outletId=all`),
    getProductOutletConfig: (id) =>
      data<OutletVariantConfig[]>('GET', `${API}/products/${id}/outlet-config`),
    updateProductOutletConfig: async (id, items) => {
      await request('PUT', `${API}/products/${id}/outlet-config`, { items })
    },
    listCategories: () => data<Category[]>('GET', `${API}/categories`),
    createCategory: (input) => data<Category>('POST', `${API}/categories`, input),
    updateCategory: (id, input) => data<Category>('PUT', `${API}/categories/${id}`, input),
    deleteCategory: async (id) => {
      await request('DELETE', `${API}/categories/${id}`)
    },
    listBundles: () => data<Bundle[]>('GET', `${API}/bundles`),

    listCustomers: (page = 1, limit = 500) =>
      list<Customer>(`${API}/customers`, { page, limit }),
    createCustomer: (input) => data<Customer>('POST', `${API}/customers`, input),
    updateCustomer: (id, input) => data<Customer>('PUT', `${API}/customers/${id}`, input),
    deleteCustomer: async (id) => {
      await request('DELETE', `${API}/customers/${id}`)
    },

    listLoyaltyConditions: () => data<LoyaltyCondition[]>('GET', `${API}/loyalty-conditions`),
    createLoyaltyCondition: (input) =>
      data<LoyaltyCondition>('POST', `${API}/loyalty-conditions`, input),
    updateLoyaltyCondition: (id, input) =>
      data<LoyaltyCondition>('PUT', `${API}/loyalty-conditions/${id}`, input),
    deleteLoyaltyCondition: async (id) => {
      await request('DELETE', `${API}/loyalty-conditions/${id}`)
    },
    getLoyaltySettings: () => data<LoyaltySettings>('GET', `${API}/settings/loyalty`),
    updateLoyaltySettings: (input) =>
      data<LoyaltySettings>('PUT', `${API}/settings/loyalty`, input),

    listPromotions: () => data<Promotion[]>('GET', `${API}/promotions`),
    createPromotion: (input) => data<Promotion>('POST', `${API}/promotions`, input),
    updatePromotion: (id, input) => data<Promotion>('PUT', `${API}/promotions/${id}`, input),
    deletePromotion: async (id) => {
      await request('DELETE', `${API}/promotions/${id}`)
    },
    listDiscountCodes: () => data<DiscountCode[]>('GET', `${API}/discount-codes`),
    createDiscountCode: (input) =>
      data<DiscountCode>('POST', `${API}/discount-codes`, input),
    updateDiscountCode: (id, input) =>
      data<DiscountCode>('PUT', `${API}/discount-codes/${id}`, input),
    deleteDiscountCode: async (id) => {
      await request('DELETE', `${API}/discount-codes/${id}`)
    },

    listOrders: (params) => list<Order>(`${API}/orders`, params),
    getOrder: (id) => data<Order>('GET', `${API}/orders/${id}`),
    refundOrder: (id, reason) =>
      data<Order>('POST', `${API}/orders/${id}/refund`, { reason }),
    listShifts: (params) => list<Shift>(`${API}/shifts`, params),
    listErrorLogs: (params) => list<ErrorLog>(`${API}/error-logs`, params),

    listStockCounts: (page = 1, limit = 100) =>
      list<StockCount>(`${API}/stock-counts`, { page, limit }),
    getStockCount: (id) => data<StockCount>('GET', `${API}/stock-counts/${id}`),
    createStockCount: (input) => data<StockCount>('POST', `${API}/stock-counts`, input),
    updateStockCount: (id, input) =>
      data<StockCount>('PUT', `${API}/stock-counts/${id}`, input),
    completeStockCount: (id, items) =>
      data<StockCount>('POST', `${API}/stock-counts/${id}/complete`, { items }),

    listWarehouses: () => data<Warehouse[]>('GET', `${API}/warehouses`),
    createWarehouse: (input) => data<{ id: string }>('POST', `${API}/warehouses`, input),
    updateWarehouse: async (id, input) => {
      await request('PUT', `${API}/warehouses/${id}`, input)
    },
    deleteWarehouse: async (id) => {
      await request('DELETE', `${API}/warehouses/${id}`)
    },
    getWarehouseStock: (id) =>
      data<WarehouseStockRow[]>('GET', `${API}/warehouses/${id}/stock`),
    createGoodsReceipt: async (id, input) => {
      await request('POST', `${API}/warehouses/${id}/goods-receipt`, input)
    },
    adjustWarehouseStock: async (id, input) => {
      await request('POST', `${API}/warehouses/${id}/adjust`, input)
    },
    listTransfers: (status, page = 1, limit = 50) =>
      list<Transfer>(`${API}/transfers`, { ...(status ? { status } : {}), page, limit }),
    getTransfer: (id) => data<Transfer>('GET', `${API}/transfers/${id}`),
    getTransferLocationStock: (kind, id) =>
      data<WarehouseStockRow[]>('GET', `${API}/transfers/location-stock${qs({ kind, id })}`),
    createTransfer: (input) => data<{ id: string }>('POST', `${API}/transfers`, input),
    updateTransfer: async (id, input) => {
      await request('PUT', `${API}/transfers/${id}`, input)
    },
    sendTransfer: async (id) => {
      await request('POST', `${API}/transfers/${id}/send`)
    },
    receiveTransfer: async (id, input) => {
      await request('POST', `${API}/transfers/${id}/receive`, input)
    },
    cancelTransfer: async (id) => {
      await request('POST', `${API}/transfers/${id}/cancel`)
    },

    listIngredients: (opts) =>
      list<Ingredient>(`${API}/ingredients`, opts as Record<string, string | number> | undefined),
    createIngredient: async (input) => {
      await request('POST', `${API}/ingredients`, input)
    },
    updateIngredient: async (id, input) => {
      await request('PUT', `${API}/ingredients/${id}`, input)
    },
    deleteIngredient: async (id) => {
      await request('DELETE', `${API}/ingredients/${id}`)
    },
    listIngredientCategories: () =>
      data<IngredientCategory[]>('GET', `${API}/ingredient-categories`),
    createIngredientCategory: async (input) => {
      await request('POST', `${API}/ingredient-categories`, input)
    },
    updateIngredientCategory: async (id, input) => {
      await request('PUT', `${API}/ingredient-categories/${id}`, input)
    },
    deleteIngredientCategory: async (id) => {
      await request('DELETE', `${API}/ingredient-categories/${id}`)
    },
    getIngredientStock: (warehouseId) =>
      data<IngredientStockRow[]>('GET', `${API}/ingredients/stock${qs({ warehouseId })}`),
    createIngredientGoodsReceipt: async (input) => {
      await request('POST', `${API}/ingredients/goods-receipt`, input)
    },
    adjustIngredientStock: async (input) => {
      await request('POST', `${API}/ingredients/adjust`, input)
    },
    listIngredientTransfers: (opts) =>
      list<IngredientTransfer>(`${API}/ingredient-transfers`, opts as Record<string, string | number> | undefined),
    getIngredientTransfer: (id) =>
      data<IngredientTransfer>('GET', `${API}/ingredient-transfers/${id}`),
    createIngredientTransfer: async (input) => {
      await request('POST', `${API}/ingredient-transfers`, input)
    },
    sendIngredientTransfer: async (id) => {
      await request('POST', `${API}/ingredient-transfers/${id}/send`)
    },
    receiveIngredientTransfer: async (id, input) => {
      await request('POST', `${API}/ingredient-transfers/${id}/receive`, input)
    },
    cancelIngredientTransfer: async (id, reason) => {
      await request('POST', `${API}/ingredient-transfers/${id}/cancel`, { reason })
    },
    listIngredientStockCounts: (opts) =>
      list<IngredientStockCount>(`${API}/ingredient-stock-counts`, opts as Record<string, string | number> | undefined),
    getIngredientStockCount: (id) =>
      data<IngredientStockCount>('GET', `${API}/ingredient-stock-counts/${id}`),
    createIngredientStockCount: async (input) => {
      await request('POST', `${API}/ingredient-stock-counts`, input)
    },
    startIngredientStockCount: async (id) => {
      await request('POST', `${API}/ingredient-stock-counts/${id}/start`)
    },
    saveIngredientStockCount: async (id, input) => {
      await request('PUT', `${API}/ingredient-stock-counts/${id}/save`, input)
    },
    completeIngredientStockCount: async (id) => {
      await request('POST', `${API}/ingredient-stock-counts/${id}/complete`)
    },

    getRecipeVariantIds: (productId) =>
      // This endpoint returns the bare object `{variantIds:[...]}` (no `{data}` envelope),
      // so use the raw `request` helper rather than `data` (which unwraps `.data`).
      request<{ variantIds: string[] }>('GET', `${API}/products/${productId}/recipe-variant-ids`).then((r) => r.variantIds),
    getVariantRecipe: async (productId, variantId) => {
      try {
        return await data<Recipe>('GET', `${API}/products/${productId}/variants/${variantId}/recipe`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    listRecipeVersions: (productId, variantId) =>
      data<RecipeVersionSummary[]>('GET', `${API}/products/${productId}/variants/${variantId}/recipe/versions`),
    getRecipeVersion: (productId, variantId, versionId) =>
      data<Recipe>('GET', `${API}/products/${productId}/variants/${variantId}/recipe/versions/${versionId}`),
    saveVariantRecipe: (productId, variantId, input) =>
      data<{ id: string }>('POST', `${API}/products/${productId}/variants/${variantId}/recipe`, input),
    restoreRecipeVersion: (productId, variantId, versionId, expectedCurrentVersionId) =>
      data<{ id: string }>('POST', `${API}/products/${productId}/variants/${variantId}/recipe/versions/${versionId}/restore`, { expectedCurrentVersionId }),

    listUsers: (page = 1, limit = 200) => list<User>(`${API}/users`, { page, limit }),
    createUser: (input) => data<User>('POST', `${API}/users`, input),
    updateUser: (id, input) => data<User>('PUT', `${API}/users/${id}`, input),
    setUserReceivePin: async (id, input) => {
      await request('PUT', `${API}/users/${id}/receive-pin`, input)
    },
    deleteUser: async (id) => {
      await request('DELETE', `${API}/users/${id}`)
    },
    listCustomRoles: () => data<CustomRole[]>('GET', `${API}/custom-roles`),
    createCustomRole: (input) => data<CustomRole>('POST', `${API}/custom-roles`, input),
    updateCustomRole: (id, input) =>
      data<CustomRole>('PUT', `${API}/custom-roles/${id}`, input),
    deleteCustomRole: async (id) => {
      await request('DELETE', `${API}/custom-roles/${id}`)
    },

    getAppSettings: () => data<AppSettings>('GET', `${API}/settings/app`),
    updateAppSettings: (input) => data<AppSettings>('PUT', `${API}/settings/app`, input),
    reportSummary: (params) =>
      data<ReportSummary>('GET', `${API}/reports/summary${qs(params)}`),
    signUpload: (folder) =>
      data<UploadSignature>('POST', `${API}/uploads/sign`, { folder }),
  }
}
