import { useEffect, useMemo, useState } from 'react'
import type { Ingredient, IngredientCategory } from '@mandalika/api'
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
  const [open, setOpen] = useState(false)

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
    <div className="relative">
      <div className="flex gap-2">
        <input
          className={`${fieldClass} flex-1`}
          placeholder="Cari nama / SKU…"
          value={q}
          autoFocus
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.() } }}
        />
        <select className={`${fieldClass} w-32`} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Semua</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-56 overflow-auto">
          {results.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => { onPick(i); setQ('') }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gold-50 flex justify-between"
            >
              <span className="font-medium text-gray-800">{i.name}</span>
              <span className="text-gray-400 text-xs">{i.sku || ''} · {i.unit}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
