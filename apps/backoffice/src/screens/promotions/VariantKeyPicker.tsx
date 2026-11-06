import { useState } from 'react'
import type { Product } from '@mandalika/api'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { BRAND } from '../../lib/brand'

interface VariantKeyPickerProps {
  products: readonly Product[]
  /** Selected keys, "productId::size" (the format of applicableVariantKeys; the BXGY and bundle pickers use "id|size"). */
  value: readonly string[]
  onChange: (next: string[]) => void
}

/** Optional restriction of a percentage / fixed / BOGO promotion to specific variants. Keys not shown stay selected. */
export function VariantKeyPicker({ products, value, onChange }: VariantKeyPickerProps) {
  const [open, setOpen] = useState<string | null>(null)
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key])
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-paper-2 p-2">
      {products.map((p) => (
        <div key={p.id}>
          <button
            type="button"
            aria-expanded={open === p.id}
            onClick={() => setOpen(open === p.id ? null : p.id)}
            className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-paper-1"
          >
            <span className="text-sm font-bold text-ink-700">{p.name}</span>
            {open === p.id ? <ChevronUp className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />}
          </button>
          {open === p.id && (
            <div className="ml-4 mt-0.5 space-y-0.5">
              {p.variants.map((v) => {
                const key = `${p.id}::${v.size}`
                return (
                  <label key={v.size} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-paper-1">
                    <input type="checkbox" checked={value.includes(key)} onChange={() => toggle(key)} className="accent-brand-strong" />
                    <span className="text-xs text-ink-700">{v.size} — {BRAND.currency.format(v.price)}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
