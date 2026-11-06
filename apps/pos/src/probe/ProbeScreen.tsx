import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { components } from '@mandalika/api'
import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { SortableCard } from '../cashier/ProductGrid'
import { PRODUCT_GRID_COLS } from '../components/Skeleton'
import { formatRupiah } from '../cashier/pricing'
import { variantLabel } from '@mandalika/types'
import { categories, products } from './syntheticData'
import { MATERIAL_LABEL, MeasurePanel, type Material } from './MeasurePanel'

type Product = components['schemas']['Product']
type Motion = 'pegas' | 'halus'

// Combined header + category band, overlaid at the top of the scroller. The scroller's top padding equals
// BAND_TOP + BAND_HEIGHT so the first row starts just below it and everything else scrolls under it.
const BAND_TOP = 8
const BAND_HEIGHT = 116
const BAND_OFFSET = BAND_TOP + BAND_HEIGHT

interface CartLine {
  key: number
  name: string
  size: string
  price: number
  qty: number
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; text: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      <span className="text-xs font-semibold text-ink-700">{label}</span>
      <div role="group" aria-label={label} className="flex rounded-chip bg-paper-1 p-0.5">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={o.id === value}
            onClick={() => onChange(o.id)}
            className={`press min-h-10 rounded-chip px-3 text-sm font-semibold ${o.id === value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-700'}`}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ProbeScreen() {
  const [material, setMaterial] = useState<Material>('glass')
  const [ambient, setAmbient] = useState(true)
  const [motion, setMotion] = useState<Motion>('pegas')
  const [activeCat, setActiveCat] = useState(categories[0].id)
  const [lines, setLines] = useState<CartLine[]>([])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const keySeq = useRef(1)

  // Root attributes: the same ones the real app's applyMaterial() sets.
  useEffect(() => {
    document.documentElement.dataset.material = material
  }, [material])
  useEffect(() => {
    document.documentElement.dataset.ambient = ambient ? 'on' : 'off'
  }, [ambient])
  useEffect(() => {
    if (motion === 'halus') document.documentElement.dataset.motion = 'halus'
    else delete document.documentElement.dataset.motion
  }, [motion])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const categoryNames = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [])
  const sections = useMemo(
    () => categories.map((c) => ({ cat: c, items: products.filter((p) => p.categoryId === c.id) })),
    [],
  )

  const addToCart = useCallback((product: Product) => {
    const v = product.variants[0]
    setLines((ls) => {
      const existing = ls.find((l) => l.name === product.name && l.size === v.size)
      if (existing) return ls.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l))
      return [{ key: keySeq.current++, name: product.name, size: v.size, price: v.price, qty: 1 }, ...ls]
    })
  }, [])

  const jumpTo = (id: string) => {
    setActiveCat(id)
    const el = sectionRefs.current.get(id)
    scrollerRef.current?.scrollTo({ top: Math.max(0, (el?.offsetTop ?? 0) - BAND_OFFSET), behavior: 'smooth' })
  }

  const total = lines.reduce((s, l) => s + l.price * l.qty, 0)

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left: scroller with the band overlaid on top of it */}
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div ref={scrollerRef} data-probe-scroller className="absolute inset-0 overflow-y-auto px-3 pb-48" style={{ paddingTop: BAND_OFFSET }}>
          <DndContext sensors={sensors} collisionDetection={closestCenter}>
            {sections.map(({ cat, items }) => (
              <section
                key={cat.id}
                ref={(el) => {
                  if (el) sectionRefs.current.set(cat.id, el)
                }}
                className="mb-4"
              >
                <h2 className="mb-2 mt-1 text-base font-bold text-ink-900">{cat.name}</h2>
                <SortableContext items={items.map((p) => p.id)} strategy={rectSortingStrategy}>
                  <div className={`grid ${PRODUCT_GRID_COLS[4]} gap-2`}>
                    {items.map((p) => (
                      <SortableCard
                        key={p.id}
                        product={p}
                        gridCols={4}
                        categoryName={categoryNames.get(p.categoryId)}
                        showPrice
                        showStock
                        showVariants={false}
                        onTap={addToCart}
                      />
                    ))}
                  </div>
                </SortableContext>
              </section>
            ))}
          </DndContext>
        </div>

        <header
          className="surface-glass absolute inset-x-3 z-10 flex flex-col justify-center gap-2 rounded-panel px-3"
          style={{ top: BAND_TOP, height: BAND_HEIGHT }}
        >
          <div className="flex items-center gap-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <p className="flex-shrink-0 text-base font-bold text-ink-900">POS Probe A9</p>
            <Segmented<Material>
              label="Bahan"
              value={material}
              onChange={setMaterial}
              options={(['glass', 'static', 'solid'] as const).map((m) => ({ id: m, text: MATERIAL_LABEL[m] }))}
            />
            <Segmented<'on' | 'off'>
              label="Latar"
              value={ambient ? 'on' : 'off'}
              onChange={(v) => setAmbient(v === 'on')}
              options={[{ id: 'on', text: 'nyala' }, { id: 'off', text: 'mati' }]}
            />
            <Segmented<Motion>
              label="Gerak"
              value={motion}
              onChange={setMotion}
              options={[{ id: 'pegas', text: 'Pegas' }, { id: 'halus', text: 'Halus' }]}
            />
          </div>
          <div role="tablist" aria-label="Kategori" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === activeCat}
                onClick={() => jumpTo(c.id)}
                className={`press min-h-11 flex-shrink-0 whitespace-nowrap rounded-chip px-4 text-sm font-semibold ${c.id === activeCat ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-700'}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </header>
      </div>

      {/* Right: cart column, solid, the production width */}
      <aside className="surface-solid flex w-80 flex-shrink-0 flex-col rounded-none lg:w-[486px]">
        <div className="flex items-baseline justify-between px-4 pb-2 pt-3">
          <h2 className="text-base font-bold text-ink-900">Keranjang</h2>
          <p className="tnum text-sm font-semibold text-ink-700">{formatRupiah(total)}</p>
        </div>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-2">
          {lines.length === 0 && <li className="px-1 py-6 text-center text-sm text-ink-500">Ketuk produk untuk menambah.</li>}
          {lines.map((l) => (
            <li key={l.key} className="probe-line-in surface-card flex items-center justify-between gap-2 rounded-control px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink-900">{l.name}</p>
                {variantLabel(l.size) && <p className="text-xs text-ink-500">{variantLabel(l.size)}</p>}
              </div>
              <p className="tnum flex-shrink-0 text-sm font-bold text-ink-900">
                {l.qty} × {formatRupiah(l.price)}
              </p>
            </li>
          ))}
        </ul>
        <MeasurePanel scrollerRef={scrollerRef} material={material} ambient={ambient} />
      </aside>
    </div>
  )
}
