import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { SlideOver } from '../../ui/SlideOver'
import { useRecipe, type EditLine } from './useRecipe'
import { RecipeIngredientPicker } from './RecipeIngredientPicker'
import { VersionHistoryDropdown } from './VersionHistoryDropdown'

interface Props {
  productId: string
  variantId: string
  variantLabel: string // e.g. "Parfum Aurora — 50ml"
  onClose: () => void
  /** Reports unsaved edits to the screen, whose leave guard covers Back and the sidebar for this layer too. */
  onDirtyChange?: (dirty: boolean) => void
}

const idr = (n: number) => n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })

/** The recipe editor, a SlideOver layered over the product editor: Escape, × and the backdrop close only this layer
 *  and ask first when there are unsaved edits. */
export function RecipeSlideOver({ productId, variantId, variantLabel, onClose, onDirtyChange }: Props) {
  const r = useRecipe({ productId, variantId })
  const readOnly = r.isViewingHistory
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    onDirtyChange?.(r.dirty)
    return () => onDirtyChange?.(false)
  }, [r.dirty, onDirtyChange])

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
    <SlideOver
      open
      onClose={onClose}
      title="Resep"
      subtitle={variantLabel}
      width="md"
      dirty={r.dirty}
      footer={
        !readOnly && (
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-ink-700">Estimasi biaya bahan</span>
              {costEstimate != null ? (
                <span className="font-black text-ink-900">{idr(costEstimate)}</span>
              ) : (
                <span
                  className="text-ink-700 italic"
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
              className="w-full border border-paper-2 rounded-lg px-3 py-2 text-sm"
            />
            <SlideOver.Footer dirty={r.dirty}>
              <Button className="w-full" loading={r.saving} onClick={() => void r.save()}>Simpan versi baru</Button>
            </SlideOver.Footer>
          </div>
        )
      }
    >
      <div className="space-y-3">
        <VersionHistoryDropdown
          versions={r.versions}
          currentVersionId={r.recipe?.currentVersionId ?? null}
          viewingVersionId={r.viewingVersionId}
          onSelect={(id) => void r.viewVersion(id)}
          onBackToCurrent={() => void r.loadCurrent()}
        />
        {readOnly && (
          <div className="flex items-center justify-between bg-warn-bg border border-warn/30 rounded-lg px-3 py-2 text-xs text-warn-strong">
            <span>Versi {r.versions.find((v) => v.id === r.viewingVersionId)?.versionNo} — hanya-baca</span>
            <div className="flex gap-2">
              <button type="button" className="font-bold underline" onClick={() => r.viewingVersionId && void r.restore(r.viewingVersionId)}>Pulihkan ke versi ini</button>
              <button type="button" className="text-warn-strong" onClick={() => void r.loadCurrent()}>Kembali ke versi kini</button>
            </div>
          </div>
        )}
        {r.loading ? (
          <p className="text-sm text-ink-700">Memuat…</p>
        ) : (
          <>
            {r.lines.length === 0 && <p className="text-sm text-ink-700">Belum ada bahan.</p>}
            {r.lines.length > 0 && (
              <div className="grid grid-cols-[1fr_5rem_3rem_2.25rem] gap-2 items-center text-[10px] font-black uppercase tracking-wider text-ink-700">
                <span>Bahan</span>
                <span className="text-right">Jumlah</span>
                <span>Satuan</span>
                <span />
              </div>
            )}
            {r.lines.map((l, i) => {
              const short = l.onHandTotal != null && l.onHandTotal < Number(l.qty)
              return (
                <div key={l.ingredientId} className="grid grid-cols-[1fr_5rem_3rem_2.25rem] gap-2 items-center">
                  <div>
                    <div className="text-sm text-ink-900">
                      {l.name}
                      {!l.isActive && <span className="text-danger text-xs ml-1">⚠ nonaktif</span>}
                    </div>
                    {l.onHandTotal != null && (
                      <div className={short ? 'text-[10.5px] text-warn-strong' : 'text-[10.5px] text-ink-700'}>
                        {short && '⚠ '}stok gudang {l.onHandTotal} {l.unit}
                      </div>
                    )}
                  </div>
                  <input
                    type="number" inputMode="decimal" value={l.qty} disabled={readOnly}
                    aria-label={`Jumlah ${l.name}`}
                    onChange={(e) => setQty(i, e.target.value)}
                    className="border border-paper-2 rounded-lg px-2 py-1.5 text-sm text-right disabled:bg-paper-1"
                  />
                  <span className="text-xs text-ink-700">{l.unit}</span>
                  {!readOnly && (
                    <IconButton tone="danger" label={`Hapus ${l.name}`} className="justify-self-end" onClick={() => removeLine(i)}><X className="w-4 h-4" aria-hidden="true" /></IconButton>
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
                    className="text-xs font-medium text-ink-700 hover:text-ink-900"
                  >
                    Tutup
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="w-full rounded-lg border-2 border-dashed border-paper-2 bg-paper-1 px-3 py-2.5 text-sm font-bold text-brand-strong hover:border-brand-strong transition-colors"
                >
                  + Tambah Bahan
                </button>
              )
            )}
          </>
        )}
        {r.err && <p role="alert" className="text-sm text-danger">{r.err}</p>}
      </div>
    </SlideOver>
  )
}
