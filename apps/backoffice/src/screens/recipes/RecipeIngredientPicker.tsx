import { useEffect, useMemo, useState } from 'react'
import type { Ingredient, IngredientCategory } from '@mandalika/api'
import { Search } from 'lucide-react'
import { api } from '../../api'
import { fieldClass } from '../../ui'

interface Props {
  excludeIds: string[]
  onPick: (ing: Ingredient) => void
  /** Collapse the picker (Escape in the search input). Optional. */
  onClose?: () => void
}

export function RecipeIngredientPicker({ excludeIds, onPick, onClose }: Props) {
  const [all, setAll] = useState<Ingredient[]>([])
  const [cats, setCats] = useState<IngredientCategory[]>([])
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')

  useEffect(() => {
    let alive = true
    api.listIngredients({ limit: 200 }).then((r) => { if (alive) setAll(r.data) }).catch(() => {})
    api.listIngredientCategories().then((c) => { if (alive) setCats(c) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    return all.filter((i) =>
      i.isActive &&
      !excludeIds.includes(i.id) &&
      (cat === '' || i.categoryId === cat) &&
      (term === '' || i.name.toLowerCase().includes(term) || (i.sku ?? '').toLowerCase().includes(term)),
    ).slice(0, 8)
  }, [all, q, cat, excludeIds])

  return (
    <div className="rounded-xl border border-gold-200 bg-amber-50/40 p-2.5 space-y-2">
      {/* full-width search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          className={`${fieldClass} pl-9 bg-white`}
          placeholder="Cari bahan (nama / SKU)…"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.() } }}
        />
      </div>

      {/* category filter on its own row */}
      <select
        className={`${fieldClass} bg-white`}
        value={cat}
        onChange={(e) => setCat(e.target.value)}
      >
        <option value="">Semua kategori</option>
        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      {/* in-flow results list (no overlay; pushes content down) */}
      <div className="rounded-lg border border-gray-200 bg-white max-h-52 overflow-auto">
        {results.length === 0 ? (
          <p className="px-3 py-3 text-xs text-gray-400">Tidak ada bahan cocok.</p>
        ) : (
          results.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => { onPick(i); setQ('') }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gold-50 flex justify-between items-center border-b border-gray-50 last:border-0"
            >
              <span className="font-medium text-gray-800">{i.name}</span>
              <span className="text-gray-400 text-xs">{[i.sku, i.unit].filter(Boolean).join(' · ')}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
