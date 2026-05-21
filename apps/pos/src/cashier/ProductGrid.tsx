import { memo, useMemo, useState, type CSSProperties } from 'react'
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
  onProductTap: (product: Product, variantQtys: Record<string, number>) => void
  onCategoryChange: (id: string | null) => void
  onSearchChange: (q: string) => void
  onToggleFavourites: () => void
  isLoading: boolean
}

interface SortableCardProps {
  product: Product
  onTap: (product: Product) => void
}

const SortableCard = memo(function SortableCard({ product, onTap }: SortableCardProps) {
  const inStock = product.variants.some((v) => v.stock > 0)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: product.id })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 20 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={inStock ? 0 : -1}
      onClick={() => { if (inStock) onTap(product) }}
      className={`flex flex-col rounded-xl border text-left overflow-hidden select-none touch-manipulation ${
        inStock
          ? 'border-gray-200 hover:border-indigo-300 hover:shadow-sm bg-white cursor-pointer'
          : 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
      } ${isDragging ? 'shadow-lg ring-2 ring-indigo-300' : 'transition-all'}`}
    >
      {product.imageUrl && (
        <img
          src={product.imageUrl}
          alt={product.name}
          className="w-full aspect-square object-cover pointer-events-none"
          loading="lazy"
          draggable={false}
        />
      )}
      <div className="p-2">
        <p className="text-xs font-semibold text-gray-800 line-clamp-2 leading-tight">
          {product.name}
        </p>
        {!inStock && <p className="text-[10px] text-red-500 mt-0.5">Habis</p>}
      </div>
    </div>
  )
})

export const ProductGrid = memo(function ProductGrid({
  products,
  categories,
  selectedCategoryId,
  searchQuery,
  showFavouritesOnly,
  gridCols,
  onProductTap,
  onCategoryChange,
  onSearchChange,
  onToggleFavourites,
  isLoading,
}: ProductGridProps) {
  const [variantPopup, setVariantPopup] = useState<Product | null>(null)
  const [variantQtys, setVariantQtys] = useState<Record<string, number>>({})
  const [order, setOrder] = useState<string[]>(loadOrder)

  // Custom order applied first, then the category/search/favourite filters.
  const orderedAll = useMemo(() => sortByCustomOrder(products, order), [products, order])
  const filtered = orderedAll.filter((p) => {
    const matchSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchCat = !selectedCategoryId || p.categoryId === selectedCategoryId
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

  const handleProductClick = (product: Product) => {
    if (product.variants.length === 1) {
      onProductTap(product, { [product.variants[0].size]: 1 })
      return
    }
    const qtys: Record<string, number> = {}
    product.variants.forEach((v) => { qtys[v.size] = 0 })
    setVariantQtys(qtys)
    setVariantPopup(product)
  }

  const handleVariantChange = (size: string, delta: number) => {
    if (!variantPopup) return
    const variant = variantPopup.variants.find((v) => v.size === size)
    if (!variant) return
    setVariantQtys((prev) => ({
      ...prev,
      [size]: Math.max(0, Math.min((prev[size] || 0) + delta, variant.stock)),
    }))
  }

  const handleConfirmVariants = () => {
    if (!variantPopup) return
    onProductTap(variantPopup, variantQtys)
    setVariantPopup(null)
  }

  const colClass: Record<number, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    6: 'grid-cols-6',
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search bar */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Cari produk…"
          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 px-3 py-2 overflow-x-auto flex-shrink-0 border-b border-gray-100">
        <button
          onClick={() => onCategoryChange(null)}
          className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
            selectedCategoryId === null
              ? 'bg-indigo-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Semua
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => onCategoryChange(cat.id)}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              selectedCategoryId === cat.id
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {cat.name}
          </button>
        ))}
        <button
          onClick={onToggleFavourites}
          className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
            showFavouritesOnly
              ? 'bg-pink-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          ♥ Favorit
        </button>
      </div>

      {/* Product grid */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Memuat produk…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Produk tidak ditemukan
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className={`grid ${colClass[gridCols] ?? 'grid-cols-4'} gap-2`}>
                {filtered.map((product) => (
                  <SortableCard key={product.id} product={product} onTap={handleProductClick} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Variant popup */}
      {variantPopup && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setVariantPopup(null)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-bold text-gray-900 mb-4">{variantPopup.name}</h3>
            <div className="space-y-3 mb-5">
              {variantPopup.variants.map((v) => (
                <div key={v.size} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-700">{v.size}</p>
                    <p className="text-xs text-indigo-600">{formatRupiah(v.price)}</p>
                    <p className="text-xs text-gray-400">Stok: {v.stock}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleVariantChange(v.size, -1)}
                      disabled={(variantQtys[v.size] || 0) === 0}
                      className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm font-bold">
                      {variantQtys[v.size] || 0}
                    </span>
                    <button
                      onClick={() => handleVariantChange(v.size, 1)}
                      disabled={(variantQtys[v.size] || 0) >= v.stock}
                      className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={handleConfirmVariants}
              disabled={Object.values(variantQtys).reduce((a, b) => a + b, 0) === 0}
              className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-semibold text-sm disabled:opacity-40 hover:bg-indigo-700 transition-colors"
            >
              Tambah ke Keranjang
            </button>
          </div>
        </div>
      )}
    </div>
  )
})
