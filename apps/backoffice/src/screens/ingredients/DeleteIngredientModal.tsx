import { useEffect, useState } from 'react'
import type { Ingredient, IngredientUsageVariant } from '@mandalika/api'
import { AlertTriangle } from 'lucide-react'
import { api } from '../../api'
import { Button, Modal } from '../../ui'

interface DeleteIngredientModalProps {
  ingredient: Ingredient
  onClose: () => void
  onDone: () => void
}

export function DeleteIngredientModal({ ingredient, onClose, onDone }: DeleteIngredientModalProps) {
  const [usageLoading, setUsageLoading] = useState(true)
  const [variants, setVariants] = useState<IngredientUsageVariant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setUsageLoading(true)
    setError(null)
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
    return () => { alive = false }
  }, [ingredient.id])

  const isLinked = variants.length > 0

  const handleDelete = async () => {
    if (isLinked) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteIngredient(ingredient.id)
      onDone()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal menghapus bahan.')
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={busy} className="flex-1">
        Batal
      </Button>
      <Button
        variant="danger"
        onClick={handleDelete}
        disabled={isLinked || usageLoading || busy}
        loading={busy}
        className="flex-1"
      >
        Hapus
      </Button>
    </>
  )

  return (
    <Modal open onClose={onClose} title="Hapus Bahan" size="sm" footer={footer}>
      {usageLoading ? (
        <p className="text-sm text-gray-500">Memeriksa keterkaitan…</p>
      ) : isLinked ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-amber-800 font-medium">
              Bahan ini dipakai di resep {variants.length} varian produk:
            </p>
          </div>
          <ul className="max-h-48 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-xl text-sm">
            {variants.map((v, i) => (
              <li key={i} className="px-3 py-2 text-gray-700">
                <span className="font-medium">{v.productName}</span>
                <span className="text-gray-400"> — </span>
                <span>{v.variantSize}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400">
            Hapus bahan ini dari resep terkait dulu sebelum menghapusnya.
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-700">
          Hapus bahan <span className="font-semibold">{ingredient.name}</span>? Tindakan ini tidak
          dapat dibatalkan.
        </p>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600">{error}</p>
      )}
    </Modal>
  )
}
