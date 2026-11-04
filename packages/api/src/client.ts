import type { components, operations } from './schema'

type S = components['schemas']
type Query<K extends keyof operations> = NonNullable<operations[K]['parameters']['query']>

/** Query params of the order list, shift list and report summary, generated from the OpenAPI contract. */
export type ListOrdersParams = Query<'listOrders'>
export type ListShiftsParams = Query<'listShifts'>
export type ReportSummaryParams = Query<'reportSummary'>
export type DashboardAggregateParams = Query<'reportDashboard'>

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
export type ErpOutboxItem = S['ErpOutboxItem']
export type ErpOutboxDetail = S['ErpOutboxDetail']
export type ErpOutboxCounts = S['ErpOutboxCounts']
export type ErpRelayReport = S['ErpRelayReport']
export type ListErpOutboxParams = Query<'listErpOutbox'>
/** Optional backoffice filters of the product list (D2-API); the page and limit stay positional. */
export type ProductListFilter = Omit<Query<'listProducts'>, 'page' | 'limit' | 'outletId'>
/** Optional paging and filters of the promotion and discount-code lists; page makes the answer carry a meta. */
export type PromoListParams = Omit<Query<'listPromotions'>, 'outletId'>
export type ListGoodsReceiptsParams = Query<'listGoodsReceipts'>
export type GoodsReceiptListItem = S['GoodsReceiptListItem']
/** outletId and kind narrow the Persetujuan Stok list; pendingCount ignores them. */
export type ApprovalListFilter = Pick<Query<'listInventoryApprovals'>, 'outletId' | 'kind'>
export interface ErpOutboxList { items: ErpOutboxItem[]; meta: Meta; counts: ErpOutboxCounts }
export type CustomRole = S['CustomRole']
export type ReportSummary = S['ReportSummary']
export type DashboardAggregate = S['DashboardAggregate']
export type DashboardWindow = S['DashboardWindow']
export type DashboardTrendBucket = S['DashboardTrendBucket']
export type DashboardProductRow = S['DashboardProductRow']
export type DashboardCashierRow = S['DashboardCashierRow']
export type DashboardPromoRow = S['DashboardPromoRow']
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
export type IngredientUsageVariant = S['IngredientUsageVariant']
export type IngredientUsageResponse = S['IngredientUsageResponse']
export type Recipe = S['Recipe']
export type RecipeIngredientLine = S['RecipeIngredientLine']
export type RecipeVersionSummary = S['RecipeVersionSummary']
export type RecipeSaveInput = S['RecipeSaveInput']
export type RecipeRestoreInput = S['RecipeRestoreInput']
export type Tag = S['Tag']
export type TagInput = S['TagInput']
export type Segment = S['Segment']
export type SegmentInput = S['SegmentInput']
export type Interaction = S['Interaction']
export type InteractionInput = S['InteractionInput']
export type Reminder = S['Reminder']
export type PointTransaction = S['PointTransaction']
export type AdjustPointsInput = S['AdjustPointsInput']
export type RewardGrant = S['RewardGrant']
export type LoyaltyPreviewReward = S['LoyaltyPreviewReward']
export type CustomerProfile = S['CustomerProfile']
export type DupCandidate = S['DupCandidate']
export type SyncReviewItem = S['SyncReviewItem']
export type SyncReviewResolution = S['SyncReviewResolution']
export type SyncReviewItemList = S['SyncReviewItemListResponse']
export interface SyncReviewListParams {
  status: 'open' | 'resolved'
  page: number
  limit: number
  outletId?: string
  reviewCode?: string
}
export type MergeCustomersInput = S['MergeCustomersInput']

export type ProductInput = S['ProductInput']
export type CategoryInput = S['CategoryInput']
export type CustomerInput = S['CustomerInput']
export type PromotionInput = S['PromotionInput']
export type DiscountCodeInput = S['DiscountCodeInput']
export type DiscountCodeBatchInput = S['DiscountCodeBatchInput']
export type OutletInput = S['OutletInput']
export type OutletVariantConfig = S['OutletVariantConfig']
export type OutletConfigItemInput = S['OutletConfigItemInput']
export type CreateUserRequest = S['CreateUserRequest']
export type UpdateUserRequest = S['UpdateUserRequest']
export type SetReceivePinRequest = S['SetReceivePinRequest']
export type ReceiveApprover = S['ReceiveApprover']
export type TransferReceiveApprovalRequest = S['TransferReceiveApprovalRequest']
export type TransferReceiveApproval = S['TransferReceiveApproval']
export type ResetUserPasswordRequest = S['ResetUserPasswordRequest']
export type UploadSignature = S['UploadSignature']
export type WarehouseInput = S['WarehouseInput']
export type GoodsReceiptInput = S['GoodsReceiptInput']
export type WarehouseAdjustInput = S['WarehouseAdjustInput']
export type OutletParInput = S['OutletParInput']
export type InventoryOverviewResponse = S['InventoryOverviewResponse']
export type InventoryOverviewRow = S['InventoryOverviewRow']
export type InventoryOverviewLocation = S['InventoryOverviewLocation']
export type IngredientOverviewResponse = S['IngredientOverviewResponse']
export type IngredientOverviewRow = S['IngredientOverviewRow']
export type IngredientOverviewCell = S['IngredientOverviewCell']
export type MovementSummaryRow = S['MovementSummaryRow']
export type MovementSummaryResponse = S['MovementSummaryResponse']
export type PromoRewardGrantReport = S['PromoRewardGrantReport']
export type DiscountCodeReport = S['DiscountCodeReport']
export type RefundReport = S['RefundReport']
export type RefundReportRow = S['RefundReportRow']
export type OrderRefund = S['OrderRefund']
export type OversellReport = S['OversellReport']
export type OversellRecord = S['OversellRecord']
export type OversellSummary = S['OversellSummary']
export type OversellBreakdown = S['OversellBreakdown']
export type CsvImportRequest = S['CsvImportRequest']
export type ImportReport = S['ImportReport']
export type ImportSummary = S['ImportSummary']
export type ImportIssue = S['ImportIssue']
export type ImportFileIssue = S['ImportFileIssue']
export type ImportRowResult = S['ImportRowResult']
export type ImportKind = ImportReport['kind']
export type StockMovementRow = S['StockMovementRow']
export type GoodsReceiptDetail = S['GoodsReceiptDetail']
export type StockMovementSummary = S['StockMovementSummary']
export type StockMovementPage = S['StockMovementPage']
export type MovementLedgerSummaryRow = S['MovementLedgerSummaryRow']
export type MovementLedgerSummaryResponse = S['MovementLedgerSummaryResponse']
export type MovementSku = S['MovementSku']
export type MovementSkuResponse = S['MovementSkuResponse']
export type InventoryDocEvent = S['InventoryDocEvent']
export type InventoryReasonCode = S['InventoryReasonCode']
export type OutletGiveaway = S['OutletGiveaway']
export type OutletGiveawayInput = S['OutletGiveawayInput']
export type AdjustmentRequest = S['AdjustmentRequest']
export type AdjustmentRequestCreateInput = S['AdjustmentRequestCreateInput']
export type AdjustmentRequestApproveResult = S['AdjustmentRequestApproveResult']
export type InventoryApproveInput = S['InventoryApproveInput']
export type InventoryRejectInput = S['InventoryRejectInput']
export type InventoryCancelInput = S['InventoryCancelInput']
export type ApprovalQueueItem = S['ApprovalQueueItem']
export type ApprovalQueueResponse = S['ApprovalQueueResponse']
export type StockCountSubmitInput = S['StockCountSubmitInput']
export type StockCountImportReport = S['StockCountImportReport']
export type StockCountImportRequest = S['StockCountImportRequest']
export type StockCountImportSummary = S['StockCountImportSummary']
export type StockCountImportRow = S['StockCountImportRow']
export type StockRequisition = S['StockRequisition']
export type StockRequisitionItem = S['StockRequisitionItem']
export type StockRequisitionInput = S['StockRequisitionInput']
export type StockRequisitionApproveInput = S['StockRequisitionApproveInput']
export type StockRequisitionFulfilResult = S['StockRequisitionFulfilResult']
/** Query params of the kartu stok list and its CSV export, generated from the OpenAPI contract. */
export type StockMovementParams = Query<'listStockMovements'>
export type StockMovementExportParams = Query<'exportStockMovements'>
export type MovementLedgerSummaryParams = Query<'getMovementLedgerSummary'>
export type MovementLedgerSummaryExportParams = Query<'exportMovementLedgerSummary'>
export type MovementSkuParams = Query<'listMovementSkus'>
export type ListAdjustmentRequestsParams = Query<'listAdjustmentRequests'>
export type ListRequisitionsParams = Query<'listRequisitions'>
export interface OversellReportParams {
  dateFrom?: string
  dateTo?: string
  outletId?: string
  productId?: string
  variantSize?: string
  cashierId?: string
  kind?: OversellRecord['kind']
  status?: 'open' | 'acknowledged'
  page?: number
  limit?: number
}

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

/** How a request failed. `http` = the server answered with an error status;
 *  `network` = no answer (offline, DNS, connection reset); `timeout` = we aborted
 *  a hung request; `invalid_response` = an answer we could not parse (e.g. an HTML
 *  502 page from a proxy, or a 200 with a non-JSON body). */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'invalid_response'

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when no response was received (network / timeout). */
    public status: number,
    message: string,
    public kind: ApiErrorKind = 'http',
    /** Parsed JSON body of an error response (e.g. the import report on a 422), when there was one. */
    public body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Per-request options. `timeoutMs` aborts the request (fetch + body read). */
export interface RequestOptions {
  timeoutMs?: number
  /** Extra request headers (e.g. Idempotency-Key). */
  headers?: Record<string, string>
}

export interface ListResult<T> {
  data: T[]
  meta?: Meta
}

const API = '/api/v1'
/** The silent token refresh gets its own deadline, independent of the caller's. */
const REFRESH_TIMEOUT_MS = 15_000
/** A hung per-line stock count save would stall that line's queue and Complete. */
const STOCK_COUNT_SAVE_TIMEOUT_MS = 20_000

export interface Api {
  request: <T>(method: string, path: string, body?: unknown, opts?: RequestOptions) => Promise<T>

  // auth
  login: (email: string, password: string) => Promise<AuthData>
  refresh: (refresh: string, opts?: RequestOptions) => Promise<AuthData>
  logout: (refresh: string) => Promise<void>
  me: () => Promise<User>

  // outlets
  listOutlets: () => Promise<Outlet[]>
  createOutlet: (input: OutletInput) => Promise<Outlet>
  updateOutlet: (id: string, input: OutletInput) => Promise<Outlet>

  // products / categories / bundles
  listProducts: (page?: number, limit?: number, filter?: ProductListFilter) => Promise<ListResult<Product>>
  createProduct: (input: ProductInput) => Promise<Product>
  updateProduct: (id: string, input: ProductInput) => Promise<Product>
  deleteProduct: (id: string) => Promise<void>
  /** Single product at base/all-outlet scope (base price, summed stock). */
  getProduct: (id: string) => Promise<Product>
  getProductOutletConfig: (id: string) => Promise<OutletVariantConfig[]>
  updateProductOutletConfig: (id: string, items: OutletConfigItemInput[]) => Promise<void>
  listCategories: () => Promise<Category[]>
  createCategory: (input: CategoryInput) => Promise<Category>
  updateCategory: (id: string, input: CategoryInput) => Promise<Category>
  deleteCategory: (id: string) => Promise<void>
  listBundles: () => Promise<Bundle[]>

  // customers
  listCustomers: (page?: number, limit?: number, q?: string, sort?: string, tagId?: string, segmentId?: string) => Promise<ListResult<Customer>>
  getCustomer: (id: string) => Promise<Customer>
  getCustomersByPhone: (phone: string) => Promise<Customer[]>
  lookupCustomers: (q: string, limit?: number) => Promise<Customer[]>
  /** Cashier finder (A30): exact phone match online, any common format; at most 3 reduced rows. Throws ApiError 429 when the per-account budget is spent. */
  lookupCustomerByPhone: (phone: string) => Promise<Customer[]>
  createCustomer: (input: CustomerInput) => Promise<Customer>
  updateCustomer: (id: string, input: CustomerInput) => Promise<Customer>
  deleteCustomer: (id: string) => Promise<void>

  // dup-candidate review (SP-CRM-Merge)
  listDupCandidates: (status?: string, page?: number, limit?: number) => Promise<ListResult<DupCandidate>>
  getDupCandidate: (id: string) => Promise<DupCandidate>
  mergeDupCandidate: (id: string, input: MergeCustomersInput) => Promise<{ ok: boolean }>
  dismissDupCandidate: (id: string) => Promise<{ ok: boolean }>

  // tags (SP-CRM-4)
  listTags: () => Promise<Tag[]>
  createTag: (input: TagInput) => Promise<{ id: string }>
  updateTag: (id: string, input: TagInput) => Promise<void>
  deleteTag: (id: string) => Promise<void>
  setCustomerTags: (id: string, tagIds: string[]) => Promise<void>

  // segments (SP-CRM-5a)
  listSegments: () => Promise<Segment[]>
  createSegment: (input: SegmentInput) => Promise<{ id: string }>
  updateSegment: (id: string, input: SegmentInput) => Promise<void>
  deleteSegment: (id: string) => Promise<void>
  reorderSegments: (orderedIds: string[]) => Promise<void>

  // interactions + reminders (SP-CRM-6)
  listInteractions: (customerId: string, page?: number, limit?: number) => Promise<ListResult<Interaction>>
  createInteraction: (customerId: string, input: InteractionInput) => Promise<{ id: string }>
  deleteInteraction: (customerId: string, interactionId: string) => Promise<void>
  listReminders: (opts?: { window?: number; type?: string; page?: number; limit?: number }) => Promise<ListResult<Reminder>>

  // points ledger (SP-CRM-7)
  listPointTransactions: (customerId: string, page?: number, limit?: number) => Promise<ListResult<PointTransaction>>
  adjustPoints: (customerId: string, input: AdjustPointsInput) => Promise<{ balanceAfter: number }>
  listRewardGrants: (customerId: string) => Promise<RewardGrant[]>
  loyaltyPreview: (
    customerId: string,
    items: CartItem[],
    total: number,
    clientCreatedAt?: string,
  ) => Promise<LoyaltyPreviewReward[]>

  /** B3 (D-25): the POS customer profile. Throws ApiError 404 when the backend predates the endpoint or the customer is unknown, 404 also when a phone-only caller's `phone` does not match (A30). */
  customerProfile: (customerId: string, phone: string) => Promise<CustomerProfile>

  /** A08: online-only. Eligible receive approvers at the caller's outlet (no PIN hash). */
  listReceiveApprovers: () => Promise<ReceiveApprover[]>
  /** A08: online-only step-up. Verifies the approver PIN on the server and mints a single-use grant. A 429 body carries retryAfterSeconds. */
  createTransferReceiveApproval: (input: TransferReceiveApprovalRequest) => Promise<TransferReceiveApproval>

  /** Receipt-number device code of this install at the caller's outlet (idempotent per device and outlet). */
  registerDevice: (deviceId: string) => Promise<{ code: string }>

  // loyalty
  listLoyaltyConditions: () => Promise<LoyaltyCondition[]>
  createLoyaltyCondition: (input: Partial<LoyaltyCondition>) => Promise<LoyaltyCondition>
  updateLoyaltyCondition: (id: string, input: Partial<LoyaltyCondition>) => Promise<LoyaltyCondition>
  deleteLoyaltyCondition: (id: string) => Promise<void>
  getLoyaltySettings: () => Promise<LoyaltySettings>
  updateLoyaltySettings: (input: LoyaltySettings) => Promise<LoyaltySettings>

  // promotions / discount codes
  listPromotions: () => Promise<Promotion[]>
  /** Paged and filtered; the response always has a meta when page or limit is sent. An old backend ignores the parameters and returns the whole list. */
  listPromotionsPage: (params: PromoListParams) => Promise<ListResult<Promotion>>
  createPromotion: (input: PromotionInput) => Promise<Promotion>
  updatePromotion: (id: string, input: PromotionInput) => Promise<Promotion>
  deletePromotion: (id: string) => Promise<void>
  listDiscountCodes: () => Promise<DiscountCode[]>
  listDiscountCodesPage: (params: PromoListParams) => Promise<ListResult<DiscountCode>>
  createDiscountCode: (input: DiscountCodeInput) => Promise<DiscountCode>
  /** Needs an Idempotency-Key: a retry of a batch that may already have landed must not create a second set of active codes. */
  createDiscountCodeBatch: (input: DiscountCodeBatchInput, idempotencyKey: string) => Promise<DiscountCode[]>
  updateDiscountCode: (id: string, input: DiscountCodeInput) => Promise<DiscountCode>
  deleteDiscountCode: (id: string) => Promise<void>

  // orders / shifts
  listOrders: (params?: ListOrdersParams) => Promise<ListResult<Order>>
  getOrder: (id: string) => Promise<Order>
  /** Whole order when `items` is omitted (only while it has no earlier refund); else a per-line refund (admin, C4c).
   *  `clientRefundUuid` is the replay key: the same uuid returns the earlier refund instead of paying out twice. */
  refundOrder: (id: string, reason: string, opts?: { reasonCode?: string; items?: { lineNo: number; quantity: number }[]; clientRefundUuid?: string; payoutMethod?: string }) => Promise<Order>
  listShifts: (params?: ListShiftsParams) => Promise<ListResult<Shift>>
  listErrorLogs: (params?: Record<string, string | number>) => Promise<ListResult<ErrorLog>>
  listSyncReviewItems: (params: SyncReviewListParams) => Promise<SyncReviewItemList>
  listErpOutbox: (params?: ListErpOutboxParams) => Promise<ErpOutboxList>
  getErpOutbox: (id: string) => Promise<ErpOutboxDetail>
  retryErpOutbox: (id: string) => Promise<ErpOutboxItem>
  runErpRelay: () => Promise<ErpRelayReport>
  resolveSyncReviewItem: (key: string, note: string) => Promise<SyncReviewResolution>

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
  completeStockCount: (id: string, items?: StockCountItem[]) => Promise<StockCount>
  // approval flow (inventoryApprovalRequired): submit, then an approver approves with their PIN or rejects
  submitStockCount: (id: string, input: StockCountSubmitInput, idempotencyKey: string) => Promise<StockCount>
  approveStockCount: (id: string, input: InventoryApproveInput, idempotencyKey: string) => Promise<StockCount>
  rejectStockCount: (id: string, input: InventoryRejectInput, idempotencyKey: string) => Promise<StockCount>
  /** The count sheet as CSV text (sku, barcode, product, size, expected_qty, counted_qty). */
  exportStockCount: (id: string) => Promise<string>
  // scanner CSV upload: dryRun previews, dryRun=false stores counted quantities (needs idempotencyKey).
  // A 422 (row errors) or 409 (stale / key conflict) throws an ApiError whose body carries the report.
  importStockCount: (id: string, input: StockCountImportRequest, idempotencyKey?: string) => Promise<StockCountImportReport>

  // warehouses / inventory
  listWarehouses: () => Promise<Warehouse[]>
  createWarehouse: (input: WarehouseInput) => Promise<{ id: string }>
  updateWarehouse: (id: string, input: WarehouseInput) => Promise<void>
  deleteWarehouse: (id: string) => Promise<void>
  getWarehouseStock: (id: string) => Promise<WarehouseStockRow[]>
  /** Additive stock write: a double submit applies twice, so the key is required (one per form open). */
  createLocationGoodsReceipt: (loc: { kind: 'outlet' | 'warehouse'; id: string }, input: GoodsReceiptInput, idempotencyKey: string) => Promise<void>
  adjustLocationStock: (loc: { kind: 'outlet' | 'warehouse'; id: string }, input: WarehouseAdjustInput, idempotencyKey: string) => Promise<void>
  setOutletPar: (outletId: string, input: OutletParInput) => Promise<void>
  getInventoryOverview: () => Promise<InventoryOverviewResponse>
  getIngredientOverview: () => Promise<IngredientOverviewResponse>
  getMovementSummary: (params: { kind: 'outlet' | 'warehouse'; id: string; from: string; to: string; page?: number; limit?: number }) => Promise<MovementSummaryResponse>

  // inventory controls: kartu stok, giveaway, adjustment requests, approvals queue, requisitions
  listStockMovements: (params: StockMovementParams) => Promise<StockMovementPage>
  /** The kartu stok as CSV text, same filters as the list. */
  exportStockMovements: (params: StockMovementExportParams) => Promise<string>
  getMovementLedgerSummary: (params: MovementLedgerSummaryParams) => Promise<MovementLedgerSummaryResponse>
  /** Pergerakan (per-SKU summary with the six buckets) as CSV text, same filters as the summary. */
  exportMovementLedgerSummary: (params: MovementLedgerSummaryExportParams) => Promise<string>
  /** The kartu stok SKU picker: variants matching q that have a ledger row at the location. */
  listMovementSkus: (params: MovementSkuParams) => Promise<MovementSkuResponse>
  /** One goods receipt with its lines, read-only (opened from a kartu stok row). */
  listGoodsReceipts: (params?: ListGoodsReceiptsParams) => Promise<ListResult<GoodsReceiptListItem>>
  getGoodsReceipt: (id: string) => Promise<GoodsReceiptDetail>
  getOutletGiveaway: (outletId: string) => Promise<OutletGiveaway>
  setOutletGiveaway: (outletId: string, input: OutletGiveawayInput, idempotencyKey: string) => Promise<OutletGiveaway>
  listAdjustmentRequests: (params?: ListAdjustmentRequestsParams) => Promise<ListResult<AdjustmentRequest>>
  createAdjustmentRequest: (input: AdjustmentRequestCreateInput, idempotencyKey: string) => Promise<AdjustmentRequest>
  getAdjustmentRequest: (id: string) => Promise<AdjustmentRequest>
  approveAdjustmentRequest: (id: string, input: InventoryApproveInput, idempotencyKey: string) => Promise<AdjustmentRequestApproveResult>
  rejectAdjustmentRequest: (id: string, input: InventoryRejectInput, idempotencyKey: string) => Promise<AdjustmentRequest>
  cancelAdjustmentRequest: (id: string, idempotencyKey: string, input?: InventoryCancelInput) => Promise<AdjustmentRequest>
  listInventoryApprovals: (page?: number, limit?: number, filter?: ApprovalListFilter) => Promise<ApprovalQueueResponse>
  listRequisitions: (params?: ListRequisitionsParams, opts?: RequestOptions) => Promise<ListResult<StockRequisition>>
  getRequisition: (id: string, opts?: RequestOptions) => Promise<StockRequisition>
  createRequisition: (input: StockRequisitionInput, idempotencyKey: string, opts?: RequestOptions) => Promise<StockRequisition>
  updateRequisition: (id: string, input: StockRequisitionInput, idempotencyKey: string, opts?: RequestOptions) => Promise<StockRequisition>
  submitRequisition: (id: string, idempotencyKey: string, opts?: RequestOptions) => Promise<StockRequisition>
  cancelRequisition: (id: string, idempotencyKey: string, opts?: RequestOptions) => Promise<StockRequisition>
  approveRequisition: (id: string, input: StockRequisitionApproveInput, idempotencyKey: string) => Promise<StockRequisition>
  rejectRequisition: (id: string, input: InventoryRejectInput, idempotencyKey: string) => Promise<StockRequisition>
  fulfilRequisition: (id: string, idempotencyKey: string) => Promise<StockRequisitionFulfilResult>

  // transfers (SP2)
  listTransfers: (opts?: { status?: string; from?: string; to?: string; locKind?: 'outlet' | 'warehouse'; locId?: string; page?: number; limit?: number }) => Promise<ListResult<Transfer>>
  getTransfer: (id: string) => Promise<Transfer>
  getTransferLocationStock: (kind: string, id: string) => Promise<WarehouseStockRow[]>
  createTransfer: (input: TransferCreateInput) => Promise<{ id: string }>
  updateTransfer: (id: string, input: TransferCreateInput) => Promise<void>
  sendTransfer: (id: string, idempotencyKey: string) => Promise<void>
  receiveTransfer: (id: string, input: TransferReceiveInput) => Promise<void>
  cancelTransfer: (id: string, idempotencyKey: string) => Promise<void>
  outletTransfers: (status: 'completed' | 'cancelled') => Promise<Transfer[]>

  // ingredients / recipe inventory (SP-Recipe-1)
  listIngredients: (opts?: { page?: number; limit?: number; q?: string; categoryId?: string }) => Promise<ListResult<Ingredient>>
  createIngredient: (input: IngredientInput) => Promise<void>
  updateIngredient: (id: string, input: IngredientInput) => Promise<void>
  deleteIngredient: (id: string) => Promise<void>
  getIngredientUsage: (id: string) => Promise<IngredientUsageResponse>
  listIngredientCategories: () => Promise<IngredientCategory[]>
  createIngredientCategory: (input: IngredientCategoryInput) => Promise<void>
  updateIngredientCategory: (id: string, input: IngredientCategoryInput) => Promise<void>
  deleteIngredientCategory: (id: string) => Promise<void>
  getIngredientLocationStock: (kind: 'outlet' | 'warehouse', id: string) => Promise<IngredientStockRow[]>
  createIngredientLocationGoodsReceipt: (loc: { kind: 'outlet' | 'warehouse'; id: string }, input: IngredientGoodsReceiptInput) => Promise<void>
  adjustIngredientLocationStock: (loc: { kind: 'outlet' | 'warehouse'; id: string }, input: IngredientAdjustInput) => Promise<void>
  listIngredientTransfers: (opts?: { status?: string; from?: string; to?: string; locKind?: 'outlet' | 'warehouse'; locId?: string; page?: number; limit?: number }) => Promise<ListResult<IngredientTransfer>>
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

  // promo reward grants report
  listPromoRewardGrants: (opts?: { dateFrom?: string; dateTo?: string; outletId?: string; promotionId?: string; productId?: string; page?: number; limit?: number }) => Promise<PromoRewardGrantReport>

  // discount code usage report (SP-Code-2)
  listRefundReport: (opts?: { dateFrom?: string; dateTo?: string; outletId?: string; flag?: 'any' | 'amount_mismatch' | 'over_total'; page?: number; limit?: number }) => Promise<RefundReport>
  listDiscountCodeReport: (opts?: { dateFrom?: string; dateTo?: string; page?: number; limit?: number }) => Promise<DiscountCodeReport>

  // oversold sale lines "Stok Minus" (A44)
  listOversellReport: (opts?: OversellReportParams) => Promise<OversellReport>
  getOversellOpenCount: () => Promise<number>
  acknowledgeOversell: (ids: string[], note?: string) => Promise<number>

  // CSV import (A39): dryRun previews, dryRun=false applies (needs idempotencyKey).
  // A 422 (row errors) or 409 (stale / key conflict) throws an ApiError whose body carries the report.
  importCsv: (kind: ImportKind, input: CsvImportRequest, idempotencyKey?: string) => Promise<ImportReport>

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
  /** Admin-only: clear the receive-PIN lockouts of a user without changing the PIN (A08). */
  clearUserReceivePinLockout: (id: string) => Promise<void>
  deleteUser: (id: string) => Promise<void>
  /** Admin-only: set a new password for the user and revoke their sessions. */
  resetUserPassword: (id: string, input: ResetUserPasswordRequest) => Promise<void>
  listCustomRoles: () => Promise<CustomRole[]>
  createCustomRole: (input: { name: string; permissions: string[] }) => Promise<CustomRole>
  updateCustomRole: (id: string, input: { name: string; permissions: string[] }) => Promise<CustomRole>
  deleteCustomRole: (id: string) => Promise<void>

  // settings / reports / uploads
  /** `fresh` adds a nonce query so the server's shared read cache (keyed on the query string) cannot serve a stale copy. */
  getAppSettings: (opts?: { fresh?: boolean }) => Promise<AppSettings>
  updateAppSettings: (input: AppSettings) => Promise<AppSettings>
  reportSummary: (params?: ReportSummaryParams) => Promise<ReportSummary>
  /** Ringkasan numbers aggregated on the server (windows, trend granularity); a 404 means an older backend. */
  reportDashboard: (params: DashboardAggregateParams) => Promise<DashboardAggregate>
  signUpload: (folder?: string) => Promise<UploadSignature>
}

export function createClient(opts: ClientOptions): Api {
  // De-dupe concurrent refreshes: many requests can 401 at once when the
  // access token expires; they all await the single in-flight refresh.
  let refreshing: Promise<'ok' | 'rejected' | ApiError> | null = null

  /** 'ok' = new tokens stored; 'rejected' = the server refused the refresh token
   *  (session is over); an ApiError = no verdict (unreachable, hung, 5xx/429): the
   *  caller rethrows it, typed, and never logs the cashier out. */
  async function trySilentRefresh(): Promise<'ok' | 'rejected' | ApiError> {
    const rt = opts.getRefresh?.()
    if (!rt) return 'rejected'
    if (!refreshing) {
      refreshing = (async (): Promise<'ok' | 'rejected' | ApiError> => {
        // A hung refresh would leave the caller (e.g. a sync flush) awaiting forever.
        const controller = new AbortController()
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, REFRESH_TIMEOUT_MS)
        try {
          const res = await fetch(`${opts.baseUrl}${API}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh: rt }),
            signal: controller.signal,
          })
          // A05: only a 401 is the server refusing the refresh token. Any other non-OK answer is
          // no verdict on the session. 5xx/429 keep their status (callers read them as transient);
          // anything else (a proxy's 400/403/404/407/413/422) is returned WITHOUT the refresh
          // endpoint's status, so it can never be mistaken for a verdict on the original request
          // (a 400/413/422 would park the whole outbox, a 403/404/407 would flag the account).
          if (res.status === 401) return 'rejected'
          if (res.status >= 500 || res.status === 429) {
            return new ApiError(res.status, `pembaruan sesi belum tersedia (${res.status})`)
          }
          if (!res.ok) return new ApiError(0, `pembaruan sesi gagal (${res.status})`, 'invalid_response')
          const j = await res.json()
          const d = (j?.data ?? j) as AuthData
          if (!d?.access) return new ApiError(0, 'respons pembaruan sesi tidak valid', 'invalid_response')
          opts.onTokens?.(d)
          return 'ok'
        } catch (e) {
          return timedOut
            ? new ApiError(0, 'pembaruan sesi melebihi batas waktu', 'timeout')
            : new ApiError(0, e instanceof Error ? e.message : 'network error', 'network')
        } finally {
          clearTimeout(timer)
          refreshing = null
        }
      })()
    }
    return refreshing
  }

  function request<T>(
    method: string,
    path: string,
    body?: unknown,
    reqOpts?: RequestOptions,
  ): Promise<T> {
    return execute<T>(method, path, body, reqOpts, false)
  }

  /** The one request core: auth, outlet header, timeout, one silent refresh, typed errors.
   *  `csv` only changes the Accept header and how a 2xx body is read (verbatim text, content-type checked). */
  async function execute<T>(
    method: string,
    path: string,
    body: unknown,
    reqOpts: RequestOptions | undefined,
    csv: boolean,
  ): Promise<T> {
    const controller = reqOpts?.timeoutMs ? new AbortController() : null
    let timedOut = false
    const timer = controller
      ? setTimeout(() => { timedOut = true; controller.abort() }, reqOpts?.timeoutMs)
      : null
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = csv ? { Accept: 'text/csv' } : { 'Content-Type': 'application/json' }
      const token = opts.getToken()
      if (token) headers.Authorization = `Bearer ${token}`
      const outlet = opts.getOutletId?.()
      if (outlet) headers['X-Outlet-Id'] = outlet
      if (reqOpts?.headers) Object.assign(headers, reqOpts.headers)
      return fetch(opts.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      })
    }
    // fetch rejects with a TypeError when there is no answer, and with an
    // AbortError when we aborted: type both so callers never string-match.
    const transportError = (e: unknown): ApiError => {
      if (timedOut) return new ApiError(0, 'permintaan melebihi batas waktu', 'timeout')
      return new ApiError(0, e instanceof Error ? e.message : 'network error', 'network')
    }

    try {
      let res: Response
      try {
        res = await send()
      } catch (e) {
        throw transportError(e)
      }
      if (res.status === 401 && !path.includes('/auth/')) {
        // Try one silent refresh+retry before giving up the session.
        const refreshed = await trySilentRefresh()
        if (refreshed === 'ok') {
          try {
            res = await send()
          } catch (e) {
            throw transportError(e)
          }
        } else if (refreshed !== 'rejected') {
          // No verdict on the session (unreachable / hung / 5xx / 429): do not log the
          // cashier out (unsynced work may be queued); surface the real, typed cause.
          throw refreshed
        }
      }
      if (res.status === 401) {
        opts.onUnauthorized?.()
        throw new ApiError(401, 'unauthorized')
      }
      let text: string
      try {
        text = await res.text()
      } catch (e) {
        throw transportError(e)
      }
      if (csv && res.ok) {
        // A 200 that is not a CSV (a proxy page, a JSON envelope) must not be handed to a download as data.
        const ct = (res.headers.get('content-type') ?? '').toLowerCase()
        if (!ct.includes('text/csv') && !ct.includes('application/octet-stream')) {
          throw new ApiError(res.status, `respons server tidak valid (${res.status})`, 'invalid_response')
        }
        return text as T
      }
      let json: { error?: string } | null = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        // A proxy error page (HTML 502) or a truncated body. Server-side
        // failures are transient; a non-JSON 4xx is still a deterministic reject.
        if (res.ok || res.status >= 500) {
          throw new ApiError(res.status, `respons server tidak valid (${res.status})`, 'invalid_response')
        }
        throw new ApiError(res.status, `request failed (${res.status})`)
      }
      if (!res.ok) {
        throw new ApiError(res.status, json?.error ?? `request failed (${res.status})`, 'http', json)
      }
      return json as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const qs = (params?: Record<string, string | number>): string => {
    if (!params) return ''
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) p.set(k, String(v))
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  const data = async <T>(
    method: string,
    path: string,
    body?: unknown,
    reqOpts?: RequestOptions,
  ): Promise<T> => {
    const r = await request<{ data: T }>(method, path, body, reqOpts)
    return r.data
  }
  const list = async <T>(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<ListResult<T>> => request<ListResult<T>>('GET', path + qs(params))

  /** Idempotency-Key request option for the optional key of a write. */
  const idem = (key?: string): RequestOptions | undefined =>
    key ? { headers: { 'Idempotency-Key': key } } : undefined
  /** Idempotency-Key request option for a write whose double-submit would create or apply a second document. */
  const idemRequired = (key: string): RequestOptions => ({ headers: { 'Idempotency-Key': key } })
  /** idemRequired merged with caller options (e.g. a timeout); the required key always wins over a caller header. */
  const idemWith = (key: string, extra?: RequestOptions): RequestOptions => ({
    ...extra,
    headers: { ...extra?.headers, 'Idempotency-Key': key },
  })

  /** Query string that allows an array value (repeated key) next to scalars; undefined, null and empty strings are dropped (false is kept: giveaway=false excludes giveaway rows). */
  const qsMulti = (params: object): string => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      if (Array.isArray(v)) {
        for (const x of v) if (x !== undefined && x !== null && x !== '') p.append(k, String(x))
      }
      else p.set(k, String(v))
    }
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  /** GET a text/csv body. Same auth, outlet header, timeout, one silent refresh and error mapping as request(); the body is returned verbatim. */
  const requestCsv = (path: string, reqOpts?: RequestOptions): Promise<string> =>
    execute<string>('GET', path, undefined, reqOpts, true)

  return {
    request,

    async login(email, password) {
      return data<AuthData>('POST', `${API}/auth/login`, { email, password })
    },
    async refresh(refresh, reqOpts) {
      return data<AuthData>('POST', `${API}/auth/refresh`, { refresh }, reqOpts)
    },
    async logout(refresh) {
      await request<unknown>('POST', `${API}/auth/logout`, { refresh })
    },
    me: () => data<User>('GET', `${API}/auth/me`),

    listOutlets: () => data<Outlet[]>('GET', `${API}/outlets`),
    createOutlet: (input) => data<Outlet>('POST', `${API}/outlets`, input),
    updateOutlet: (id, input) => data<Outlet>('PUT', `${API}/outlets/${id}`, input),

    listProducts: (page = 1, limit = 200, filter) =>
      request<ListResult<Product>>('GET', `${API}/products${qsMulti({ page, limit, ...filter })}`),
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

    listCustomers: (page = 1, limit = 50, q = '', sort = '', tagId = '', segmentId = '') =>
      list<Customer>(`${API}/customers`, {
        page,
        limit,
        ...(q ? { q } : {}),
        ...(sort ? { sort } : {}),
        ...(tagId ? { tagId } : {}),
        ...(segmentId ? { segmentId } : {}),
      }),
    getCustomer: (id) => data<Customer>('GET', `${API}/customers/${id}`),
    getCustomersByPhone: (phone) =>
      list<Customer>(`${API}/customers/by-phone`, { phone }).then((r) => r.data),
    lookupCustomers: (q, limit = 20) =>
      list<Customer>(`${API}/sync/customers/lookup`, { q, limit }).then((r) => r.data),
    lookupCustomerByPhone: (phone) =>
      list<Customer>(`${API}/sync/customers/lookup`, { phone }).then((r) => r.data),
    createCustomer: (input) => data<Customer>('POST', `${API}/customers`, input),
    updateCustomer: (id, input) => data<Customer>('PUT', `${API}/customers/${id}`, input),
    deleteCustomer: async (id) => {
      await request('DELETE', `${API}/customers/${id}`)
    },

    listDupCandidates: (status = 'pending', page = 1, limit = 25) =>
      list<DupCandidate>(`${API}/customers/dup-candidates`, { status, page, limit }),
    getDupCandidate: (id) =>
      data<DupCandidate>('GET', `${API}/customers/dup-candidates/${id}`),
    mergeDupCandidate: (id, input) =>
      data<{ ok: boolean }>('POST', `${API}/customers/dup-candidates/${id}/merge`, input),
    dismissDupCandidate: (id) =>
      data<{ ok: boolean }>('POST', `${API}/customers/dup-candidates/${id}/dismiss`, {}),

    listTags: () => list<Tag>(`${API}/tags`).then((r) => r.data),
    createTag: (input) => data<{ id: string }>('POST', `${API}/tags`, input),
    updateTag: (id, input) => request<void>('PUT', `${API}/tags/${id}`, input),
    deleteTag: (id) => request<void>('DELETE', `${API}/tags/${id}`),
    setCustomerTags: (id, tagIds) =>
      request<void>('PUT', `${API}/customers/${id}/tags`, { tagIds }),

    listSegments: () => list<Segment>(`${API}/segments`).then((r) => r.data),
    createSegment: (input) => data<{ id: string }>('POST', `${API}/segments`, input),
    updateSegment: (id, input) => request<void>('PUT', `${API}/segments/${id}`, input),
    deleteSegment: (id) => request<void>('DELETE', `${API}/segments/${id}`),
    reorderSegments: (orderedIds) => request<void>('PUT', `${API}/segments/reorder`, { orderedIds }),

    listInteractions: (customerId, page = 1, limit = 25) =>
      list<Interaction>(`${API}/customers/${customerId}/interactions`, { page, limit }),
    createInteraction: (customerId, input) =>
      data<{ id: string }>('POST', `${API}/customers/${customerId}/interactions`, input),
    deleteInteraction: (customerId, interactionId) =>
      request<void>('DELETE', `${API}/customers/${customerId}/interactions/${interactionId}`),
    listReminders: (opts = {}) =>
      list<Reminder>(`${API}/customers/reminders`, {
        ...(opts.window !== undefined ? { window: opts.window } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        page: opts.page ?? 1,
        limit: opts.limit ?? 25,
      }),

    listPointTransactions: (customerId, page = 1, limit = 25) =>
      list<PointTransaction>(`${API}/customers/${customerId}/points`, { page, limit }),
    adjustPoints: (customerId, input) =>
      data<{ balanceAfter: number }>('POST', `${API}/customers/${customerId}/points/adjust`, input),
    listRewardGrants: (customerId) =>
      data<RewardGrant[]>('GET', `${API}/customers/${customerId}/reward-grants`),
    listReceiveApprovers: () => data<ReceiveApprover[]>('GET', `${API}/sync/receive-approvers`),
    createTransferReceiveApproval: (input) =>
      data<TransferReceiveApproval>('POST', `${API}/sync/transfer-receive-approvals`, input),
    loyaltyPreview: (customerId, items, total, clientCreatedAt) =>
      data<LoyaltyPreviewReward[]>('POST', `${API}/sync/loyalty-preview`, {
        customerId,
        items,
        total,
        ...(clientCreatedAt ? { clientCreatedAt } : {}),
      }),

    customerProfile: (customerId, phone) =>
      data<CustomerProfile>('GET', `${API}/sync/customers/${encodeURIComponent(customerId)}/profile?phone=${encodeURIComponent(phone)}`),

    registerDevice: (deviceId) =>
      data<{ code: string }>('POST', `${API}/pos/devices/register`, { deviceId }),

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
    listPromotionsPage: (params) =>
      request<ListResult<Promotion>>('GET', `${API}/promotions${qsMulti(params)}`),
    createPromotion: (input) => data<Promotion>('POST', `${API}/promotions`, input),
    updatePromotion: (id, input) => data<Promotion>('PUT', `${API}/promotions/${id}`, input),
    deletePromotion: async (id) => {
      await request('DELETE', `${API}/promotions/${id}`)
    },
    listDiscountCodes: () => data<DiscountCode[]>('GET', `${API}/discount-codes`),
    listDiscountCodesPage: (params) =>
      request<ListResult<DiscountCode>>('GET', `${API}/discount-codes${qsMulti(params)}`),
    createDiscountCode: (input) =>
      data<DiscountCode>('POST', `${API}/discount-codes`, input),
    createDiscountCodeBatch: (input, idempotencyKey) =>
      data<DiscountCode[]>('POST', `${API}/discount-codes/batch`, input, idemRequired(idempotencyKey)),
    updateDiscountCode: (id, input) =>
      data<DiscountCode>('PUT', `${API}/discount-codes/${id}`, input),
    deleteDiscountCode: async (id) => {
      await request('DELETE', `${API}/discount-codes/${id}`)
    },

    listOrders: (params) => list<Order>(`${API}/orders`, params),
    getOrder: (id) => data<Order>('GET', `${API}/orders/${id}`),
    refundOrder: (id, reason, opts) =>
      data<Order>('POST', `${API}/orders/${id}/refund`, { reason, ...(opts?.reasonCode ? { reasonCode: opts.reasonCode } : {}), ...(opts?.items ? { items: opts.items } : {}), ...(opts?.clientRefundUuid ? { clientRefundUuid: opts.clientRefundUuid } : {}), ...(opts?.payoutMethod ? { payoutMethod: opts.payoutMethod } : {}) }),
    listShifts: (params) => list<Shift>(`${API}/shifts`, params),
    listErrorLogs: (params) => list<ErrorLog>(`${API}/error-logs`, params),
    listErpOutbox: async (params) => {
      // Drop undefined filters: qs would otherwise send status=undefined (400).
      const defined = Object.fromEntries(
        Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null),
      ) as Record<string, string | number>
      const r = await request<S['ErpOutboxListResponse']>('GET', `${API}/admin/erp/outbox` + qs(defined))
      return { items: r.data, meta: r.meta, counts: r.counts }
    },
    getErpOutbox: (id) => data<ErpOutboxDetail>('GET', `${API}/admin/erp/outbox/${id}`),
    retryErpOutbox: (id) => data<ErpOutboxItem>('POST', `${API}/admin/erp/outbox/${id}/retry`),
    runErpRelay: () => data<ErpRelayReport>('POST', `${API}/admin/erp/relay`),
    listSyncReviewItems: ({ status, page, limit, outletId, reviewCode }) =>
      request<SyncReviewItemList>('GET', `${API}/sync-review-items` + qs({
        status, page, limit,
        ...(outletId ? { outletId } : {}),
        ...(reviewCode ? { reviewCode } : {}),
      })),
    resolveSyncReviewItem: (key, note) =>
      data<SyncReviewResolution>('POST', `${API}/sync-review-items/${encodeURIComponent(key)}/resolve`, { note }),

    listStockCounts: (page = 1, limit = 100) =>
      list<StockCount>(`${API}/stock-counts`, { page, limit }),
    getStockCount: (id) => data<StockCount>('GET', `${API}/stock-counts/${id}`),
    createStockCount: (input) => data<StockCount>('POST', `${API}/stock-counts`, input),
    updateStockCount: (id, input) =>
      data<StockCount>('PUT', `${API}/stock-counts/${id}`, input, { timeoutMs: STOCK_COUNT_SAVE_TIMEOUT_MS }),
    completeStockCount: (id, items) =>
      data<StockCount>('POST', `${API}/stock-counts/${id}/complete`, { items }),
    submitStockCount: (id, input, idempotencyKey) =>
      data<StockCount>('POST', `${API}/stock-counts/${id}/submit`, input, idemRequired(idempotencyKey)),
    approveStockCount: (id, input, idempotencyKey) =>
      data<StockCount>('POST', `${API}/stock-counts/${id}/approve`, input, idemRequired(idempotencyKey)),
    rejectStockCount: (id, input, idempotencyKey) =>
      data<StockCount>('POST', `${API}/stock-counts/${id}/reject`, input, idemRequired(idempotencyKey)),
    exportStockCount: (id) => requestCsv(`${API}/stock-counts/${id}/export`),
    importStockCount: (id, input, idempotencyKey) =>
      data<StockCountImportReport>('POST', `${API}/stock-counts/${id}/import`, input, idem(idempotencyKey)),

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
    createLocationGoodsReceipt: async (loc, input, idempotencyKey) => {
      await request('POST', `${API}/inventory/goods-receipt?kind=${loc.kind}&id=${loc.id}`, input, idemRequired(idempotencyKey))
    },
    adjustLocationStock: async (loc, input, idempotencyKey) => {
      await request('POST', `${API}/inventory/adjust?kind=${loc.kind}&id=${loc.id}`, input, idemRequired(idempotencyKey))
    },
    setOutletPar: async (outletId, input) => {
      await request('PUT', `${API}/inventory/outlet-par?id=${outletId}`, input)
    },
    getInventoryOverview: () =>
      request<InventoryOverviewResponse>('GET', `${API}/inventory/overview`),
    getIngredientOverview: () =>
      request<IngredientOverviewResponse>('GET', `${API}/inventory/ingredient-overview`),
    getMovementSummary: (params) =>
      request<MovementSummaryResponse>('GET', `${API}/inventory/movement-summary${qs(params as Record<string, string | number>)}`),
    listStockMovements: (params) =>
      request<StockMovementPage>('GET', `${API}/inventory/movements${qsMulti(params)}`),
    exportStockMovements: (params) => requestCsv(`${API}/inventory/movements/export${qsMulti(params)}`),
    getMovementLedgerSummary: (params) =>
      request<MovementLedgerSummaryResponse>('GET', `${API}/inventory/movements/summary${qsMulti(params)}`),
    exportMovementLedgerSummary: (params) => requestCsv(`${API}/inventory/movements/summary/export${qsMulti(params)}`),
    listGoodsReceipts: (params) =>
      request<ListResult<GoodsReceiptListItem>>('GET', `${API}/inventory/goods-receipts${qsMulti(params ?? {})}`),
    getGoodsReceipt: (id) => request<GoodsReceiptDetail>('GET', `${API}/inventory/goods-receipts/${id}`),
    listMovementSkus: (params) =>
      request<MovementSkuResponse>('GET', `${API}/inventory/movements/skus${qsMulti(params)}`),
    getOutletGiveaway: (outletId) => data<OutletGiveaway>('GET', `${API}/outlets/${outletId}/giveaway`),
    setOutletGiveaway: (outletId, input, idempotencyKey) =>
      data<OutletGiveaway>('PUT', `${API}/outlets/${outletId}/giveaway`, input, idemRequired(idempotencyKey)),
    listAdjustmentRequests: (params) =>
      request<ListResult<AdjustmentRequest>>('GET', `${API}/inventory/adjustment-requests${qsMulti(params ?? {})}`),
    createAdjustmentRequest: (input, idempotencyKey) =>
      data<AdjustmentRequest>('POST', `${API}/inventory/adjustment-requests`, input, idemRequired(idempotencyKey)),
    getAdjustmentRequest: (id) => data<AdjustmentRequest>('GET', `${API}/inventory/adjustment-requests/${id}`),
    approveAdjustmentRequest: (id, input, idempotencyKey) =>
      data<AdjustmentRequestApproveResult>('POST', `${API}/inventory/adjustment-requests/${id}/approve`, input, idemRequired(idempotencyKey)),
    rejectAdjustmentRequest: (id, input, idempotencyKey) =>
      data<AdjustmentRequest>('POST', `${API}/inventory/adjustment-requests/${id}/reject`, input, idemRequired(idempotencyKey)),
    cancelAdjustmentRequest: (id, idempotencyKey, input) =>
      data<AdjustmentRequest>('POST', `${API}/inventory/adjustment-requests/${id}/cancel`, input ?? {}, idemRequired(idempotencyKey)),
    listInventoryApprovals: (page, limit, filter) =>
      request<ApprovalQueueResponse>('GET', `${API}/inventory/approvals${qsMulti({ status: 'pending', page, limit, ...filter })}`),
    listRequisitions: (params, reqOpts) =>
      request<ListResult<StockRequisition>>('GET', `${API}/requisitions${qsMulti(params ?? {})}`, undefined, reqOpts),
    getRequisition: (id, reqOpts) => data<StockRequisition>('GET', `${API}/requisitions/${id}`, undefined, reqOpts),
    createRequisition: (input, idempotencyKey, reqOpts) =>
      data<StockRequisition>('POST', `${API}/requisitions`, input, idemWith(idempotencyKey, reqOpts)),
    updateRequisition: (id, input, idempotencyKey, reqOpts) =>
      data<StockRequisition>('PUT', `${API}/requisitions/${id}`, input, idemWith(idempotencyKey, reqOpts)),
    submitRequisition: (id, idempotencyKey, reqOpts) =>
      data<StockRequisition>('POST', `${API}/requisitions/${id}/submit`, undefined, idemWith(idempotencyKey, reqOpts)),
    cancelRequisition: (id, idempotencyKey, reqOpts) =>
      data<StockRequisition>('POST', `${API}/requisitions/${id}/cancel`, undefined, idemWith(idempotencyKey, reqOpts)),
    approveRequisition: (id, input, idempotencyKey) =>
      data<StockRequisition>('POST', `${API}/requisitions/${id}/approve`, input, idemRequired(idempotencyKey)),
    rejectRequisition: (id, input, idempotencyKey) =>
      data<StockRequisition>('POST', `${API}/requisitions/${id}/reject`, input, idemRequired(idempotencyKey)),
    fulfilRequisition: (id, idempotencyKey) =>
      data<StockRequisitionFulfilResult>('POST', `${API}/requisitions/${id}/fulfil`, undefined, idemRequired(idempotencyKey)),
    listTransfers: (opts) => {
      const { status, from, to, locKind, locId, page = 1, limit = 50 } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      if (status) params.status = status
      if (from) params.from = from
      if (to) params.to = to
      if (locKind) params.locKind = locKind
      if (locId) params.locID = locId
      return list<Transfer>(`${API}/transfers`, params)
    },
    getTransfer: (id) => data<Transfer>('GET', `${API}/transfers/${id}`),
    getTransferLocationStock: (kind, id) =>
      data<WarehouseStockRow[]>('GET', `${API}/transfers/location-stock${qs({ kind, id })}`),
    createTransfer: (input) => data<{ id: string }>('POST', `${API}/transfers`, input),
    updateTransfer: async (id, input) => {
      await request('PUT', `${API}/transfers/${id}`, input)
    },
    sendTransfer: async (id, idempotencyKey) => {
      await request('POST', `${API}/transfers/${id}/send`, undefined, idemRequired(idempotencyKey))
    },
    receiveTransfer: async (id, input) => {
      await request('POST', `${API}/transfers/${id}/receive`, input)
    },
    cancelTransfer: async (id, idempotencyKey) => {
      await request('POST', `${API}/transfers/${id}/cancel`, undefined, idemRequired(idempotencyKey))
    },
    outletTransfers: (status) =>
      data<Transfer[]>('GET', `${API}/sync/outlet-transfers?status=${status}`),

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
    getIngredientUsage: (id) =>
      request<IngredientUsageResponse>('GET', `${API}/ingredients/${id}/usage`),
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
    getIngredientLocationStock: (kind, id) =>
      data<IngredientStockRow[]>('GET', `${API}/inventory/ingredient-location-stock${qs({ kind, id })}`),
    createIngredientLocationGoodsReceipt: async (loc, input) => {
      await request('POST', `${API}/inventory/ingredient-goods-receipt?kind=${loc.kind}&id=${loc.id}`, input)
    },
    adjustIngredientLocationStock: async (loc, input) => {
      await request('POST', `${API}/inventory/ingredient-adjust?kind=${loc.kind}&id=${loc.id}`, input)
    },
    listIngredientTransfers: (opts) => {
      const { status, from, to, locKind, locId, page = 1, limit = 50 } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      if (status) params.status = status
      if (from) params.from = from
      if (to) params.to = to
      if (locKind) params.locKind = locKind
      if (locId) params.locID = locId
      return list<IngredientTransfer>(`${API}/ingredient-transfers`, params)
    },
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

    listPromoRewardGrants: (opts) => {
      const { dateFrom, dateTo, outletId, promotionId, productId, page = 1, limit = 50 } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      if (dateFrom) params.dateFrom = dateFrom
      if (dateTo) params.dateTo = dateTo
      if (outletId) params.outletId = outletId
      if (promotionId) params.promotionId = promotionId
      if (productId) params.productId = productId
      return request<PromoRewardGrantReport>('GET', `${API}/promo-reward-grants` + qs(params))
    },

    listRefundReport: (opts) => {
      const { dateFrom, dateTo, outletId, flag, page = 1, limit = 50 } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      if (dateFrom) params.dateFrom = dateFrom
      if (dateTo) params.dateTo = dateTo
      if (outletId) params.outletId = outletId
      if (flag) params.flag = flag
      return request<RefundReport>('GET', `${API}/refund-report` + qs(params))
    },

    listDiscountCodeReport: (opts) => {
      const { dateFrom, dateTo, page = 1, limit = 50 } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      if (dateFrom) params.dateFrom = dateFrom
      if (dateTo) params.dateTo = dateTo
      return request<DiscountCodeReport>('GET', `${API}/discount-code-report` + qs(params))
    },

    listOversellReport: (opts) => {
      const { page = 1, limit = 50, ...filters } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      for (const [k, v] of Object.entries(filters)) if (v) params[k] = v
      return request<OversellReport>('GET', `${API}/oversell-report` + qs(params))
    },
    getOversellOpenCount: async () =>
      (await data<{ openCount: number }>('GET', `${API}/oversell-report/open-count`)).openCount,
    acknowledgeOversell: async (ids, note) =>
      (await data<{ acknowledged: number }>('POST', `${API}/oversell-records/acknowledge`, { ids, ...(note ? { note } : {}) })).acknowledged,

    importCsv: (kind, input, idempotencyKey) =>
      data<ImportReport>('POST', `${API}/${kind}/import`, input,
        idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined),

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
    clearUserReceivePinLockout: async (id) => {
      await request('DELETE', `${API}/users/${id}/receive-pin-lockout`)
    },
    deleteUser: async (id) => {
      await request('DELETE', `${API}/users/${id}`)
    },
    resetUserPassword: async (id, input) => {
      await request('POST', `${API}/users/${id}/reset-password`, input)
    },
    listCustomRoles: () => data<CustomRole[]>('GET', `${API}/custom-roles`),
    createCustomRole: (input) => data<CustomRole>('POST', `${API}/custom-roles`, input),
    updateCustomRole: (id, input) =>
      data<CustomRole>('PUT', `${API}/custom-roles/${id}`, input),
    deleteCustomRole: async (id) => {
      await request('DELETE', `${API}/custom-roles/${id}`)
    },

    getAppSettings: (opts) =>
      data<AppSettings>('GET', `${API}/settings/app${opts?.fresh ? `?_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : ''}`),
    updateAppSettings: (input) => data<AppSettings>('PUT', `${API}/settings/app`, input),
    reportSummary: (params) =>
      data<ReportSummary>('GET', `${API}/reports/summary${qs(params)}`),
    reportDashboard: (params) =>
      data<DashboardAggregate>('GET', `${API}/reports/dashboard${qsMulti(params)}`),
    signUpload: (folder) =>
      data<UploadSignature>('POST', `${API}/uploads/sign`, { folder }),
  }
}
