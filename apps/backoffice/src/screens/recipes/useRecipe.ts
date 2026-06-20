import { useCallback, useEffect, useState } from 'react'
import { ApiError, type Recipe, type RecipeVersionSummary, type RecipeIngredientLine } from '@mandalika/api'
import { api } from '../../api'

export interface EditLine {
  ingredientId: string
  name: string
  unit: string
  qty: string // string for the input; parsed on save
  costAtSave?: number | null
  defaultUnitCost?: number | null
  isActive: boolean
  onHandTotal?: number
}

function lineFromServer(l: RecipeIngredientLine): EditLine {
  return {
    ingredientId: l.ingredientId,
    name: l.name,
    unit: l.unitAtSave,
    qty: String(l.qty),
    costAtSave: l.costAtSave,
    defaultUnitCost: l.defaultUnitCost,
    isActive: l.isActive,
    onHandTotal: l.onHandTotal,
  }
}

interface UseRecipeArgs { productId: string; variantId: string }

export function useRecipe({ productId, variantId }: UseRecipeArgs) {
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [versions, setVersions] = useState<RecipeVersionSummary[]>([])
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null) // null = current
  const [lines, setLines] = useState<EditLine[]>([])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const loadCurrent = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [rec, vers] = await Promise.all([
        api.getVariantRecipe(productId, variantId),
        api.listRecipeVersions(productId, variantId),
      ])
      setRecipe(rec)
      setVersions(vers)
      setViewingVersionId(null)
      setLines((rec?.items ?? []).map(lineFromServer))
      setNotes('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat resep.')
    } finally {
      setLoading(false)
    }
  }, [productId, variantId])

  useEffect(() => { void loadCurrent() }, [loadCurrent])

  const viewVersion = useCallback(async (versionId: string) => {
    setLoading(true)
    try {
      const v = await api.getRecipeVersion(productId, variantId, versionId)
      setViewingVersionId(versionId)
      setLines(v.items.map(lineFromServer))
      setNotes(v.notes ?? '')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat versi.')
    } finally {
      setLoading(false)
    }
  }, [productId, variantId])

  const save = useCallback(async (): Promise<boolean> => {
    setErr(null)
    for (const l of lines) {
      const n = Number(l.qty)
      if (!l.qty.trim() || Number.isNaN(n) || n <= 0) {
        setErr(`Jumlah untuk "${l.name}" harus lebih dari 0.`)
        return false
      }
    }
    try {
      await api.saveVariantRecipe(productId, variantId, {
        expectedCurrentVersionId: recipe?.currentVersionId ?? undefined,
        notes: notes.trim() || undefined,
        items: lines.map((l, i) => ({ ingredientId: l.ingredientId, qty: Number(l.qty), sortOrder: i })),
      })
      await loadCurrent()
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErr('Resep sudah diubah orang lain. Memuat ulang…')
        await loadCurrent()
        return false
      }
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan resep.')
      return false
    }
  }, [lines, notes, productId, variantId, recipe, loadCurrent])

  const restore = useCallback(async (versionId: string): Promise<void> => {
    setErr(null)
    try {
      await api.restoreRecipeVersion(productId, variantId, versionId, recipe?.currentVersionId ?? null)
      await loadCurrent()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErr('Resep sudah diubah orang lain. Memuat ulang…')
        await loadCurrent()
        return
      }
      setErr(e instanceof Error ? e.message : 'Gagal memulihkan versi.')
    }
  }, [productId, variantId, recipe, loadCurrent])

  const isViewingHistory = viewingVersionId !== null
  return {
    recipe, versions, lines, setLines, notes, setNotes, loading, err, setErr,
    isViewingHistory, viewingVersionId, viewVersion, loadCurrent, save, restore,
  }
}
