import { useEffect, useState } from 'react'
import type { Ingredient, IngredientUsageVariant } from '@mandalika/api'
import { AlertTriangle } from 'lucide-react'
import { api } from '../../api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'

interface DeleteIngredientDialogProps {
  ingredient: Ingredient
  onClose: () => void
  onDone: () => void
}

/**
 * Asks before an ingredient is deleted. A recipe still using it blocks the delete (the list of variants is shown and the
 * only answer is to close); a refused delete keeps the server's reason inside the dialog.
 */
export function DeleteIngredientDialog({ ingredient, onClose, onDone }: DeleteIngredientDialogProps) {
  const [usageLoading, setUsageLoading] = useState(true)
  const [variants, setVariants] = useState<IngredientUsageVariant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .getIngredientUsage(ingredient.id)
      .then((resp) => {
        if (alive) setVariants(resp.variants ?? [])
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Gagal memeriksa keterkaitan.')
      })
      .finally(() => {
        if (alive) setUsageLoading(false)
      })
    return () => {
      alive = false
    }
  }, [ingredient.id])

  const isLinked = variants.length > 0

  const handleDelete = async () => {
    if (isLinked || usageLoading) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteIngredient(ingredient.id)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal menghapus bahan.')
      return
    } finally {
      setBusy(false)
    }
    onDone()
    onClose()
  }

  if (isLinked) {
    return (
      <ConfirmDialog
        open
        title={`${ingredient.name} masih dipakai`}
        consequence={
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
              <p className="text-sm font-medium text-amber-800">Bahan ini dipakai di resep {variants.length} varian produk:</p>
            </div>
            <ul className="max-h-48 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-100 text-sm">
              {variants.map((v) => (
                <li key={`${v.productName}|${v.variantSize}`} className="px-3 py-2 text-gray-700">
                  <span className="font-medium">{v.productName}</span>
                  <span className="text-gray-400"> — </span>
                  <span>{v.variantSize}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-gray-400">Hapus bahan ini dari resep terkait dulu sebelum menghapusnya.</p>
          </div>
        }
        confirmLabel="Mengerti"
        cancelLabel="Tutup"
        onConfirm={onClose}
        onCancel={onClose}
      />
    )
  }

  return (
    <ConfirmDialog
      open
      title={`Hapus ${ingredient.name}?`}
      consequence={usageLoading ? 'Memeriksa keterkaitan…' : 'Bahan ini hilang dari daftar. Tindakan ini tidak dapat dibatalkan.'}
      confirmLabel="Hapus bahan"
      tone="danger"
      busy={busy || usageLoading}
      error={error}
      onConfirm={() => void handleDelete()}
      onCancel={onClose}
    />
  )
}
