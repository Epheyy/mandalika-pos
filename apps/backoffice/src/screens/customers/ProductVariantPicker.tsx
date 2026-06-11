import { useState } from 'react'
import type { Product } from '@mandalika/api'
import { ChevronDown, ChevronRight } from 'lucide-react'

// SP-CRM-9b composite entries: "pid" = whole product (any variant),
// "pid|size" = that variant only. Product and variant selection are mutually
// exclusive per product. Sizes containing '|' are excluded defensively (none exist).
interface ProductVariantPickerProps {
  products: Product[]
  value: string[]
  onChange: (next: string[]) => void
}

export function ProductVariantPicker({ products, value, onChange }: ProductVariantPickerProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const has = (entry: string) => value.includes(entry)

  const toggleWhole = (pid: string) => {
    if (has(pid)) {
      onChange(value.filter((e) => e !== pid))
    } else {
      // checking the whole product clears its variant entries
      onChange([...value.filter((e) => !e.startsWith(`${pid}|`)), pid])
    }
  }
  const toggleVariant = (pid: string, size: string) => {
    const entry = `${pid}|${size}`
    if (has(entry)) {
      onChange(value.filter((e) => e !== entry))
    } else {
      // checking a variant clears the whole-product entry
      onChange([...value.filter((e) => e !== pid), entry])
    }
  }

  return (
    <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-xl p-2 space-y-1">
      {products.map((p) => {
        const pid = p.id ?? ''
        if (!pid) return null
        const variants = (p.variants || []).filter((v) => !v.size.includes('|'))
        const pickedCount = value.filter((e) => e.startsWith(`${pid}|`)).length
        const isOpen = open[pid] ?? false
        return (
          <div key={pid}>
            <div className="flex items-center gap-2 hover:bg-gray-50 rounded-lg px-2 py-1">
              <input
                type="checkbox"
                checked={has(pid)}
                onChange={() => toggleWhole(pid)}
                className="accent-gold-600"
              />
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [pid]: !isOpen }))}
                className="flex items-center gap-1 flex-1 text-left cursor-pointer"
              >
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                <span className="text-sm text-gray-700">{p.name}</span>
                {has(pid) && <span className="text-[10px] font-bold text-gold-600">semua varian</span>}
                {!has(pid) && pickedCount > 0 && <span className="text-[10px] font-bold text-gold-600">{pickedCount} varian</span>}
              </button>
            </div>
            {isOpen && (
              <div className="ml-7 space-y-0.5">
                {variants.map((v) => (
                  <label key={v.size} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-0.5">
                    <input
                      type="checkbox"
                      checked={has(pid) || has(`${pid}|${v.size}`)}
                      disabled={has(pid)}
                      onChange={() => toggleVariant(pid, v.size)}
                      className="accent-gold-600"
                    />
                    <span className="text-xs text-gray-600">{v.size}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
