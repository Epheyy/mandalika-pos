import { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '../../ui/Button'
import { useRecipe, type EditLine } from './useRecipe'
import { RecipeIngredientPicker } from './RecipeIngredientPicker'
import { VersionHistoryDropdown } from './VersionHistoryDropdown'

interface Props {
  productId: string
  variantId: string
  variantLabel: string // e.g. "Parfum Aurora — 50ml"
  onClose: () => void
}

const idr = (n: number) => n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })

export function RecipeSlideOver({ productId, variantId, variantLabel, onClose }: Props) {
  const r = useRecipe({ productId, variantId })
  const readOnly = r.isViewingHistory
  const [adding, setAdding] = useState(false)

  const costEstimate = (() => {
    let total = 0
    for (const l of r.lines) {
      if (l.defaultUnitCost == null) return null
      const q = Number(l.qty)
      if (Number.isNaN(q)) return null
      total += q * l.defaultUnitCost
    }
    return total
  })()

  const setQty = (idx: number, qty: string) =>
    r.setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty } : l)))
  const removeLine = (idx: number) =>
    r.setLines((ls) => ls.filter((_, i) => i !== idx))
  const addLine = (ing: { id: string; name: string; unit: string; defaultUnitCost?: number | null; isActive: boolean }) =>
    r.setLines((ls) => [...ls, {
      ingredientId: ing.id, name: ing.name, unit: ing.unit, qty: '',
      defaultUnitCost: ing.defaultUnitCost ?? null, isActive: ing.isActive,
    } as EditLine])

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-label="Editor resep">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col">
        {/* header */}
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-black tracking-widest text-gray-400 uppercase">Resep</div>
              <div className="font-black text-gray-900">{variantLabel}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="Tutup" className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
          </div>
          <div className="mt-3">
            <VersionHistoryDropdown
              versions={r.versions}
              currentVersionId={r.recipe?.currentVersionId ?? null}
              viewingVersionId={r.viewingVersionId}
              onSelect={(id) => void r.viewVersion(id)}
              onBackToCurrent={() => void r.loadCurrent()}
            />
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          {readOnly && (
            <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              <span>Versi {r.versions.find((v) => v.id === r.viewingVersionId)?.versionNo} — hanya-baca</span>
              <div className="flex gap-2">
                <button type="button" className="font-bold underline" onClick={() => r.viewingVersionId && void r.restore(r.viewingVersionId)}>Pulihkan ke versi ini</button>
                <button type="button" className="text-amber-600" onClick={() => void r.loadCurrent()}>Kembali ke versi kini</button>
              </div>
            </div>
          )}
          {r.loading ? (
            <p className="text-sm text-gray-400">Memuat…</p>
          ) : (
            <>
              {r.lines.length === 0 && <p className="text-sm text-gray-400">Belum ada bahan.</p>}
              {r.lines.length > 0 && (
                <div className="grid grid-cols-12 gap-2 items-center text-[10px] font-black uppercase tracking-wider text-gray-400">
                  <span className="col-span-6">Bahan</span>
                  <span className="col-span-3 text-right">Jumlah</span>
                  <span className="col-span-2">Satuan</span>
                  <span className="col-span-1" />
                </div>
              )}
              {r.lines.map((l, i) => {
                const short = l.onHandTotal != null && l.onHandTotal < Number(l.qty)
                return (
                  <div key={l.ingredientId} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-6">
                      <div className="text-sm text-gray-800">
                        {l.name}
                        {!l.isActive && <span className="text-red-600 text-xs ml-1">⚠ nonaktif</span>}
                      </div>
                      {l.onHandTotal != null && (
                        <div className={short ? 'text-[10.5px] text-amber-600' : 'text-[10.5px] text-gray-400'}>
                          {short && '⚠ '}stok gudang {l.onHandTotal} {l.unit}
                        </div>
                      )}
                    </div>
                    <input
                      type="number" inputMode="decimal" value={l.qty} disabled={readOnly}
                      aria-label={`Jumlah ${l.name}`}
                      onChange={(e) => setQty(i, e.target.value)}
                      className="col-span-3 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right disabled:bg-gray-50"
                    />
                    <span className="col-span-2 text-xs text-gray-500">{l.unit}</span>
                    {!readOnly && (
                      <button type="button" className="col-span-1 text-gray-300 hover:text-red-500" onClick={() => removeLine(i)}><X className="w-4 h-4" /></button>
                    )}
                  </div>
                )
              })}
              {!readOnly && (
                adding ? (
                  <div className="space-y-2">
                    <RecipeIngredientPicker
                      excludeIds={r.lines.map((l) => l.ingredientId)}
                      onPick={addLine}
                      onClose={() => setAdding(false)}
                    />
                    <button
                      type="button"
                      onClick={() => setAdding(false)}
                      className="text-xs text-gray-400 hover:text-gray-600 font-medium"
                    >
                      Tutup
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="w-full rounded-lg border-2 border-dashed border-gold-300 bg-amber-50/60 px-3 py-2.5 text-sm font-bold text-gold-600 hover:bg-amber-50 hover:border-gold-400 transition-colors"
                  >
                    + Tambah Bahan
                  </button>
                )
              )}
            </>
          )}
          {r.err && <p className="text-sm text-red-600">{r.err}</p>}
        </div>

        {/* footer */}
        {!readOnly && (
          <div className="border-t border-gray-100 px-5 py-4 bg-gray-50 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Estimasi biaya bahan</span>
              {costEstimate != null ? (
                <span className="font-black text-gray-900">{idr(costEstimate)}</span>
              ) : (
                <span
                  className="text-gray-400 italic"
                  title="Ada bahan tanpa biaya satuan, jadi estimasi tidak bisa dihitung."
                >
                  belum tersedia ⓘ
                </span>
              )}
            </div>
            <textarea
              value={r.notes} onChange={(e) => r.setNotes(e.target.value)} rows={2}
              placeholder="Catatan versi…"
              aria-label="Catatan versi resep"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <Button className="w-full" onClick={() => void r.save()}>Simpan versi baru</Button>
          </div>
        )}
      </div>
    </div>
  )
}
