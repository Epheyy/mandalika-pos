export { isCashMethod, type CashFlagMethod } from './paymentMethod'
export { promotionKeysOverlap, promotionKeySetsOverlap, promotionKeyGroupsOverlap, promotionHasKeyOverlap } from './promotionKeys'

/** Variant size stored for a single-unit product (no real variant). Internal sentinel — never shown to a human. */
export const SINGLE_UNIT_SIZE = 'Satuan'

/** Human display label for a variant size: empty string for the single-unit sentinel (trims input). */
export function variantLabel(size: string | null | undefined): string {
  const s = (size ?? '').trim()
  return s === SINGLE_UNIT_SIZE ? '' : s
}

export const UserRole = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  CASHIER: 'cashier',
} as const
export type UserRole = typeof UserRole[keyof typeof UserRole]

export const PaymentMethod = {
  CASH: 'cash',
  CARD: 'card',
  TRANSFER: 'transfer',
  QRIS: 'qris',
} as const
export type PaymentMethod = typeof PaymentMethod[keyof typeof PaymentMethod]

export const OrderStatus = {
  COMPLETED: 'completed',
  REFUNDED: 'refunded',
  // Never written by runtime code; only orders imported from legacy Firestore (fsmigrate) can carry it.
  CANCELLED: 'cancelled',
} as const
export type OrderStatus = typeof OrderStatus[keyof typeof OrderStatus]

export const ShiftStatus = {
  OPEN: 'open',
  CLOSED: 'closed',
} as const
export type ShiftStatus = typeof ShiftStatus[keyof typeof ShiftStatus]

export const UserPermission = {
  VIEW_DASHBOARD: 'view_dashboard',
  VIEW_TRANSACTIONS: 'view_transactions',
  MANAGE_PRODUCTS: 'manage_products',
  MANAGE_CUSTOMERS: 'manage_customers',
  MANAGE_OUTLETS: 'manage_outlets',
  MANAGE_USERS: 'manage_users',
  PROCESS_REFUND: 'process_refund',
  MANAGE_PROMOTIONS: 'manage_promotions',
  VIEW_REPORTS: 'view_reports',
  MANAGE_SETTINGS: 'manage_settings',
  MANAGE_STOCK_COUNT: 'manage_stock_count',
  RESOLVE_SYNC_REVIEW: 'resolve_sync_review',
  REQUEST_STOCK: 'request_stock',
} as const
export type UserPermission = typeof UserPermission[keyof typeof UserPermission]

/** Longest refund reason the server accepts (runes, after trimming). Mirrors the backend's MaxRefundReasonRunes. */
export const MAX_REFUND_REASON_CHARS = 500


export interface AppUser {
  id?: string
  uid: string
  displayName: string
  email: string
  role: UserRole
  permissions: UserPermission[]
  outletId?: string
  photoURL?: string
  createdAt: string
}

/** UI-only refund gate, read from the cached signed-in user so it works offline on the last-known
 *  permissions. The server decides (admin bypass or `process_refund`), this only hides what would be refused. */
export function canRefund(user: { role: string; permissions?: readonly string[] | null } | null | undefined): boolean {
  if (!user) return false
  return user.role === 'admin' || (user.permissions ?? []).includes(UserPermission.PROCESS_REFUND)
}

/** UI-only gate for the POS "Permintaan Barang" screen, read from the cached signed-in user. The server decides
 *  (`request_stock`, admin bypass); a refresh after a grant or revoke updates this within one access-token TTL. */
export function canRequestStock(user: { role: string; permissions?: readonly string[] | null } | null | undefined): boolean {
  if (!user) return false
  return user.role === 'admin' || (user.permissions ?? []).includes(UserPermission.REQUEST_STOCK)
}

export interface CustomRole {
  id?: string
  name: string
  permissions: UserPermission[]
  createdAt: string
}

export interface LoyaltySettings {
  enabled: boolean
  tierEnabled: boolean
  pointsPerThousand: number
  redemptionRate: number
}

export interface LoyaltyCondition {
  id?: string
  name: string
  type: 'always_on' | 'campaign'
  trigger: 'first_registration' | 'birthday' | 'anniversary' | 'double_date' | 'member_day' | 'product_purchase' | 'spending_threshold'
  rewardType: 'set_points' | 'multiply_points' | 'product_reward'
  rewardValue: number
  rewardProductIds?: string[]
  campaignStartDate?: string
  campaignEndDate?: string
  activeDays?: number[]
  applicableProductIds?: string[]
  minimumSpend?: number
  isActive: boolean
  createdAt: string
}

export interface PaymentMethodConfig {
  id: string
  label: string
  isEnabled: boolean
  /** Money goes into the cash drawer; absent/null = default by id (cash, tunai). */
  isCash?: boolean | null
}

export interface ReceiptSettings {
  headerText: string
  footerText: string
  showTax: boolean
  showCashier: boolean
  copies?: number
  autoPrint?: boolean
  showOrderNumber?: boolean
  showCustomerName?: boolean
  showCustomerPhone?: boolean
  showDiscount?: boolean
  showSubtotal?: boolean
  showChange?: boolean
}

export interface AppSettings {
  taxEnabled: boolean
  taxRate: number
  roundingEnabled: boolean
  roundingType: 'nearest_500' | 'nearest_1000' | 'none'
  roundingAmount?: number
  roundingDirection?: 'floor' | 'ceil' | 'nearest'
  roundingApplyToTax?: boolean
  paymentMethods: PaymentMethodConfig[]
  receipt: ReceiptSettings
  autoOpenShift: boolean
}

export interface Outlet {
  id?: string
  name: string
  address?: string
  phone?: string
  isActive: boolean
  createdAt: string
}

export interface Category {
  id?: string
  name: string
  description?: string
  sortOrder?: number
}

export interface ProductVariant {
  size: string
  price: number
  stock: number
  sku: string
}

export interface Product {
  id?: string
  name: string
  brand: string
  categoryId: string
  description?: string
  imageUrl?: string
  variants: ProductVariant[]
  isFeatured?: boolean
  isFavourite?: boolean
  isActive: boolean
  createdAt: string
}

export interface BundleItem {
  productId: string
  productName: string
  variantSize: string
  quantity: number
  price: number
}

export interface Bundle {
  id?: string
  name: string
  description?: string
  items: BundleItem[]
  price: number
  imageUrl?: string
  isActive: boolean
  createdAt: string
}

export interface Customer {
  id?: string
  name: string
  phone: string
  email?: string
  points: number
  totalSpent: number
  visitCount: number
  lastVisit?: string
  createdAt: string
}

export interface Promotion {
  id?: string
  name: string
  description?: string
  type: 'percentage' | 'fixed' | 'bogo'
  value: number
  minPurchase?: number
  applicableProductIds?: string[]
  applicableVariantKeys?: string[]
  applicableVariantSizes?: string[]
  outletIds?: string[]
  combinable?: boolean
  combinableWith?: string[]
  activeFromHour?: string
  activeToHour?: string
  activeDays?: number[]
  isActive: boolean
  startDate?: string
  endDate?: string
  createdAt: string
}

export interface DiscountCode {
  id?: string
  code: string
  promotionId?: string
  type: 'percentage' | 'fixed'
  value: number
  minPurchase?: number
  usageLimit?: number
  usageCount: number
  isActive: boolean
  combinable?: boolean
  startDate?: string
  endDate?: string
  createdAt: string
}

export interface CartItem {
  productId: string
  productName: string
  variantSize: string
  price: number
  quantity: number
  subtotal: number
  isBundle?: boolean
}

export interface Order {
  id?: string
  orderNumber: string
  outletId: string
  cashierId: string
  cashierName: string
  salesmanId?: string
  salesmanName?: string
  customerId?: string
  customerName?: string
  items: CartItem[]
  subtotal: number
  discountAmount: number
  discountType?: 'percentage' | 'fixed'
  discountValue?: number
  discountCode?: string
  taxAmount: number
  total: number
  paymentMethod: PaymentMethod
  amountPaid: number
  change: number
  status: OrderStatus
  notes?: string
  refundReason?: string
  refundedAt?: string
  createdAt: string
  shiftId?: string
}

export interface Shift {
  id?: string
  outletId: string
  outletName?: string
  cashierId: string
  cashierName: string
  status: ShiftStatus
  openedAt: string
  closedAt?: string
  startingCash: number
  closingCash?: number
  totalSales: number
  totalOrders: number
  totalRefunds: number
  cashSales: number
  cardSales: number
  transferSales: number
  qrisSales: number
}

export const StockCountStatus = {
  PLANNED: 'planned',
  IN_PROGRESS: 'in_progress',
  PENDING_APPROVAL: 'pending_approval',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const
export type StockCountStatus = typeof StockCountStatus[keyof typeof StockCountStatus]

export interface StockCountItem {
  productId: string
  productName: string
  variantSize: string
  sku: string
  frozenQty: number
  actualQty?: number
  difference?: number
  baselineQty?: number
  countedAt?: string
  stockBefore?: number
  stockAfter?: number
}

export interface StockCount {
  id?: string
  name: string
  status: StockCountStatus
  outletId: string
  plannedDate: string
  startedAt?: string
  completedAt?: string
  items: StockCountItem[]
  notes?: string
  createdBy: string
  createdAt: string
}
export { normalizePhone, PHONE_MIN_DIGITS, PHONE_MAX_DIGITS } from './phone'
export { phoneProblem, emailProblem, PHONE_REQUIRED_MESSAGE, PHONE_INVALID_MESSAGE, EMAIL_INVALID_MESSAGE } from './customerRules'
