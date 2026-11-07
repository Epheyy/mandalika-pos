import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react'
import type { components } from '@mandalika/api'
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { formatRupiah } from './pricing'
import { variantLabel } from '@mandalika/types'
import { IconHeart } from '../components/ui/icons'
import { Chip } from '../components/ui/Chip'
import { VariantSheet } from './VariantSheet'
import { PRODUCT_GRID_COLS, ProductGridSkeleton } from '../components/Skeleton'
import { PROMO_TAB_ID } from './promoProducts'
import { STOCK_DOT_CLASS, STOCK_TEXT_CLASS, stockLabel, stockTone, type StockTone } from './stockTone'

type Product = components['schemas']['Product']
type Category = components['schemas']['Category']

const ORDER_KEY = 'pos_productOrder'

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** Sort products by the cashier's saved custom order; unranked keep their
 *  original (server) order at the end. Stable. */
function sortByCustomOrder(products: Product[], order: string[]): Product[] {
  if (order.length === 0) return products
  const rank = new Map(order.map((id, i) => [id, i]))
  return products
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ra = rank.get(a.p.id) ?? Infinity
      const rb = rank.get(b.p.id) ?? Infinity
      return ra === rb ? a.i - b.i : ra - rb
    })
    .map((x) => x.p)
}

interface ProductGridProps {
  products: Product[]
  categories: Category[]
  selectedCategoryId: string | null
  searchQuery: string
  showFavouritesOnly: boolean
  gridCols: 2 | 3 | 4 | 6
  showPrice: boolean
  showStock: boolean
  showVariants: boolean
  onProductTap: (product: Product, variantQtys: Record<string, number>) => void
  onCategoryChange: (id: string | null) => void
  /** Products in a live promotion; the virtual "Promo" tab lists them and is hidden while this is empty. */
  promoProductIds?: ReadonlySet<string>
  onToggleFavourites: () => void
  isLoading: boolean
  /** Filled while the variant sheet is open so the screen's Android Back handler can close it (returns true when it did). */
  variantBackRef?: MutableRefObject<(() => boolean) | null>
  /** Rendered at the top of the glass band, above the category row (the empty-cart customer chip and held-orders button). */
  topSlot?: ReactNode
}

interface SortableCardProps {
  product: Product
  gridCols: number
  categoryName: string | undefined
  showPrice: boolean
  showStock: boolean
  showVariants: boolean
  onTap: (product: Product) => void
}

/** Bottle silhouette for products without a photo. Decorative; the name sits next to it. */
function BottlePlaceholder() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2.5h4v3h-4z" />
      <path d="M9 5.5h6v2l2 2.5v9.5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10l2-2.5z" />
      <path d="M9.5 14h5" />
    </svg>
  )
}

// Narrow tiles (under about 150 dp) stack the photo above the name so the name keeps room. Keyed on the column count per breakpoint, not on measured width.
const HEAD_LAYOUT: Record<number, { head: string; photo: string }> = {
  2: { head: 'flex-row', photo: 'h-14 w-14' },
  3: { head: 'flex-col lg:flex-row', photo: 'h-10 w-10 lg:h-14 lg:w-14' },
  4: { head: 'flex-row sm:flex-col xl:flex-row', photo: 'h-14 w-14 sm:h-10 sm:w-10 xl:h-14 xl:w-14' },
  6: { head: 'flex-col', photo: 'h-10 w-10' },
}

/** Colour dot + stock word on a tile. Never colour alone. */
function StockLine({ tone, text, soldOutSizes = 0 }: { tone: StockTone; text: string; soldOutSizes?: number }) {
  return (
    <p className={`flex items-center gap-1.5 text-[0.8125rem] font-semibold ${STOCK_TEXT_CLASS[tone]}`}>
      <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${STOCK_DOT_CLASS[tone]}`} />
      {text}
      {soldOutSizes > 0 && <span className="text-warn">{` · ${soldOutSizes} ukuran habis`}</span>}
    </p>
  )
}

const SortableCard = memo(function SortableCard({ product, gridCols, categoryName, showPrice, showStock, showVariants, onTap }: SortableCardProps) {
  const totalStock = product.variants.reduce((s, v) => s + v.stock, 0)
  const inStock = totalStock > 0
  const prices = product.variants.map((v) => v.price)
  const minPrice = prices.length ? Math.min(...prices) : 0
  const maxPrice = prices.length ? Math.max(...prices) : 0
  // Compact price for small grids: a single price, or the minimum with "+"
  // when variants differ (e.g. "Rp 250.000+").
  const priceLabel = minPrice === maxPrice ? formatRupiah(minPrice) : `${formatRupiah(minPrice)}+`
  const subline = categoryName ?? ''
  const tone = stockTone(totalStock)
  const layout = HEAD_LAYOUT[gridCols] ?? HEAD_LAYOUT[4]
  const [imgFailed, setImgFailed] = useState(false)
  const soldOutSizes = product.variants.length > 1 && inStock ? product.variants.filter((v) => v.stock <= 0).length : 0
  // "Habis" / negative stock always shows, even when the stock display is off; the toggle only hides the positive count.
  const showStockRow = showStock || !inStock

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: product.id })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      // A44 owner decision 2026-10-16: an out-of-stock item is still sellable. The card
      // keeps a clear "Habis" warning and the add is warned + recorded server-side.
      onClick={() => onTap(product)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onTap(product)
        }
      }}
      className={`surface-card flex min-h-[150px] cursor-pointer select-none touch-manipulation flex-col gap-2 rounded-control p-3 text-left ${
        inStock ? '' : 'border-danger!'
      } ${isDragging ? 'shadow-lg! ring-2 ring-paper-2' : 'press-tile'}`}
    >
      <div className={`flex items-start gap-2 ${layout.head}`}>
        {product.imageUrl && !imgFailed ? (
          <img
            src={product.imageUrl}
            alt=""
            onError={() => setImgFailed(true)}
            className={`pointer-events-none flex-shrink-0 rounded-lg object-cover ${layout.photo} ${inStock ? '' : 'grayscale opacity-60'}`}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className={`flex flex-shrink-0 items-center justify-center rounded-lg bg-paper-1 text-ink-500 ${layout.photo} ${inStock ? '' : 'opacity-60'}`}>
            <BottlePlaceholder />
          </div>
        )}
        <div className="w-full min-w-0 flex-1">
          <p className="line-clamp-2 text-[0.9375rem] font-semibold leading-snug text-ink-900">{product.name}</p>
          {subline && <p className="mt-0.5 truncate text-xs text-ink-500">{subline}</p>}
        </div>
      </div>

      {showVariants ? (
        /* Per-variant rows — each variant's own price/stock, not an
           accumulated total. */
        <div className="mt-auto space-y-1">
          {product.variants.map((v) => (
            <div key={v.size} className="flex items-baseline justify-between gap-2 text-xs">
              {variantLabel(v.size) && <span className="truncate text-ink-700">{variantLabel(v.size)}</span>}
              {(showPrice || showStock) && (
                <span className="flex flex-shrink-0 items-center gap-2">
                  {showPrice && <span className="tnum font-bold text-ink-900">{formatRupiah(v.price)}</span>}
                  {showStock && <span className={`tnum font-semibold ${STOCK_TEXT_CLASS[stockTone(v.stock)]}`}>{stockLabel(v.stock)}</span>}
                </span>
              )}
            </div>
          ))}
          {!showStock && !inStock && <StockLine tone={tone} text={stockLabel(totalStock)} />}
        </div>
      ) : (
        <div className="mt-auto space-y-1">
          {(showPrice || product.variants.length > 1) && (
            <div className="flex items-baseline justify-between gap-2">
              {showPrice && <p className="tnum truncate text-base font-bold text-ink-900">{priceLabel}</p>}
              {product.variants.length > 1 && (
                <p className="ml-auto flex-shrink-0 text-xs text-ink-500">{product.variants.length} ukuran</p>
              )}
            </div>
          )}
          {showStockRow && <StockLine tone={tone} text={stockLabel(totalStock)} soldOutSizes={showStock ? soldOutSizes : 0} />}
        </div>
      )}
    </div>
  )
})

interface CategoryTabsProps {
  categories: Category[]
  showPromo: boolean
  selectedCategoryId: string | null
  onChange: (id: string | null) => void
}

/** Segmented category selector. The white thumb slides with `transform` only (its size is set, never animated);
 *  tabs are measured so any number of categories of any width work. Arrow keys / Home / End move the selection. */
function CategoryTabs({ categories, showPromo, selectedCategoryId, onChange }: CategoryTabsProps) {
  const items = useMemo(
    () => [
      { id: null as string | null, name: 'Semua' },
      ...(showPromo ? [{ id: PROMO_TAB_ID as string | null, name: 'Promo' }] : []),
      ...categories.map((c) => ({ id: c.id as string | null, name: c.name })),
    ],
    [categories, showPromo],
  )
  const tabRefs = useRef(new Map<string | null, HTMLButtonElement>())
  const [thumb, setThumb] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const selectedIndex = items.findIndex((it) => it.id === selectedCategoryId)

  const measure = useCallback(() => {
    const el = tabRefs.current.get(selectedCategoryId)
    if (!el) {
      setThumb(null)
      return
    }
    setThumb((prev) => {
      const next = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
      return prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next
    })
  }, [selectedCategoryId])

  useLayoutEffect(() => {
    measure()
  }, [measure, items])

  // Scroll only when the selection changes, so a snapshot refresh never snaps a strip the cashier has swiped.
  useLayoutEffect(() => {
    const el = tabRefs.current.get(selectedCategoryId)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedCategoryId])

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1
    let next = -1
    if (e.key === 'ArrowRight') next = selectedIndex < 0 ? 0 : Math.min(last, selectedIndex + 1)
    else if (e.key === 'ArrowLeft') next = selectedIndex < 0 ? 0 : Math.max(0, selectedIndex - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next < 0) return
    e.preventDefault()
    onChange(items[next].id)
    tabRefs.current.get(items[next].id)?.focus()
  }

  return (
    <div className="surface-group min-w-0 flex-1 rounded-panel px-1">
      <div className="overflow-x-auto [mask-image:linear-gradient(to_right,transparent,#000_12px,#000_calc(100%-12px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label="Kategori" onKeyDown={onKeyDown} className="relative flex w-max min-w-full gap-1 px-3 py-1">
          {thumb && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 rounded-chip bg-white shadow-[0_0_0_0.5px_rgba(26,16,8,0.08),0_3px_10px_-2px_rgba(70,46,10,0.18)]"
              style={{
                width: thumb.w,
                height: thumb.h,
                transform: `translate(${thumb.x}px, ${thumb.y}px)`,
                transition: 'transform var(--d-select) var(--ease-std)',
                willChange: 'transform',
              }}
            />
          )}
          {items.map((it, i) => {
            const selected = i === selectedIndex
            return (
              <button
                key={it.id ?? 'all'}
                ref={(el) => {
                  if (el) tabRefs.current.set(it.id, el)
                  else tabRefs.current.delete(it.id)
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected || (selectedIndex < 0 && i === 0) ? 0 : -1}
                onClick={() => onChange(it.id)}
                className={`press relative z-10 inline-flex min-h-11 flex-shrink-0 flex-grow items-center justify-center whitespace-nowrap rounded-chip px-4 text-sm font-semibold ${
                  selected ? 'text-ink-900' : 'text-ink-700'
                }`}
              >
                {it.name}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export const ProductGrid = memo(function ProductGrid({
  products,
  categories,
  selectedCategoryId,
  searchQuery,
  showFavouritesOnly,
  gridCols,
  showPrice,
  showStock,
  showVariants,
  onProductTap,
  onCategoryChange,
  promoProductIds,
  onToggleFavourites,
  isLoading,
  variantBackRef,
  topSlot,
}: ProductGridProps) {
  const [variantPopup, setVariantPopup] = useState<Product | null>(null)
  const [order, setOrder] = useState<string[]>(loadOrder)
  // Glass band height (header zone + categories) = the scroller's top padding.
  const bandRef = useRef<HTMLDivElement>(null)
  const [bandH, setBandH] = useState(0)
  useLayoutEffect(() => {
    const el = bandRef.current
    if (!el) return
    const measure = () => setBandH(Math.ceil(el.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Android Back closes the variant sheet before anything underneath.
  useEffect(() => {
    if (!variantBackRef) return
    variantBackRef.current = variantPopup ? () => { setVariantPopup(null); return true } : null
    return () => { variantBackRef.current = null }
  }, [variantPopup, variantBackRef])

  const categoryNames = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])

  // Custom order applied first, then the category/search/favourite filters.
  const orderedAll = useMemo(() => sortByCustomOrder(products, order), [products, order])
  // Only promoted products that are in the shown catalogue count (a deactivated product must not leave an empty tab).
  const showPromoTab = promoProductIds != null && products.some((p) => promoProductIds.has(p.id))
  // The Promo tab disappears with the last live promotion; a selection left on it then reads as "Semua".
  const effectiveCategoryId = selectedCategoryId === PROMO_TAB_ID && !showPromoTab ? null : selectedCategoryId
  // Selection parked on a vanished Promo tab: reset it, so it does not snap back when a promotion returns.
  useEffect(() => {
    if (selectedCategoryId === PROMO_TAB_ID && !showPromoTab) onCategoryChange(null)
  }, [selectedCategoryId, showPromoTab, onCategoryChange])
  const filtered = orderedAll.filter((p) => {
    const matchSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchCat = !effectiveCategoryId
      || (effectiveCategoryId === PROMO_TAB_ID ? promoProductIds?.has(p.id) === true : p.categoryId === effectiveCategoryId)
    const matchFav = !showFavouritesOnly || p.isFavourite
    return matchSearch && matchCat && matchFav
  })

  // Mouse: drag after 8px. Touch: press-and-hold 200ms (so a tap adds to cart
  // and a swipe scrolls the grid; only a deliberate hold starts a reorder).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = orderedAll.map((p) => p.id)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(ids, oldIndex, newIndex)
    setOrder(next)
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    } catch {
      /* quota — order just won't persist this session */
    }
  }

  const handleProductClick = useCallback((product: Product) => {
    if (product.variants.length === 1) {
      onProductTap(product, { [product.variants[0].size]: 1 })
      return
    }
    setVariantPopup(product)
  }, [onProductTap])

  // B1 (D-10): a size row adds one unit through the same add path as a single-size tile
  // (the screen fires the oversell warning there) and the sheet closes.
  const handlePickVariant = useCallback((product: Product, size: string) => {
    onProductTap(product, { [size]: 1 })
    setVariantPopup(null)
  }, [onProductTap])

  return (
    <div className="relative h-full overflow-hidden">
      {/* P6a (D-85): the catalogue scrolls UNDER one glass band (header zone + categories). The band is a
          sibling of the scroller (never inside it), so it is the only blurred layer on the POS; the scroller's top
          padding is the band's measured height, so the first row is not covered at scroll 0. */}
      <div
        ref={bandRef}
        data-kaca-band
        className="surface-glass absolute inset-x-0 top-0 z-[15]"
        style={{ paddingTop: 'var(--cashier-top-h, 3.5rem)' }}
      >
        {topSlot}
        {/* Category selector: a segmented tablist with a sliding white thumb, plus the Favorit toggle. */}
        <div className="flex flex-shrink-0 items-center gap-2 px-3 py-3">
          <CategoryTabs categories={categories} showPromo={showPromoTab} selectedCategoryId={effectiveCategoryId} onChange={onCategoryChange} />
          <Chip selected={showFavouritesOnly} onClick={onToggleFavourites} className="flex-shrink-0">
            <IconHeart size={16} /> Favorit
          </Chip>
        </div>
      </div>

      {/* Product grid */}
      <div
        data-kaca-scroller
        className="absolute inset-0 overflow-y-auto px-3 pb-3"
        style={{ paddingTop: bandH > 0 ? bandH : 'calc(var(--cashier-top-h, 3.5rem) + 4.5rem)', scrollPaddingTop: bandH > 0 ? bandH : undefined }}
      >
        {isLoading ? (
          <div role="status">
            <span className="sr-only">Memuat produk…</span>
            <ProductGridSkeleton className={PRODUCT_GRID_COLS[gridCols] ?? 'grid-cols-4'} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-ink-500">
            Produk tidak ditemukan
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className={`grid ${PRODUCT_GRID_COLS[gridCols] ?? 'grid-cols-4'} gap-2`}>
                {filtered.map((product) => (
                  <SortableCard key={product.id} product={product} gridCols={gridCols}
                    categoryName={product.categoryId ? categoryNames.get(product.categoryId) : undefined}
                    showPrice={showPrice} showStock={showStock} showVariants={showVariants}
                    onTap={handleProductClick} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Variant sheet (B1): tap a size = add one */}
      <VariantSheet product={variantPopup} onPick={handlePickVariant} onClose={() => setVariantPopup(null)} />
    </div>
  )
})
