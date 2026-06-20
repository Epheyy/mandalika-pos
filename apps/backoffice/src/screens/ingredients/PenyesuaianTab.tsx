import { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '../../ui/Button'
import { IngredientAdjustModal } from './IngredientAdjustModal'

export default function PenyesuaianTab() {
  const [showModal, setShowModal] = useState(false)

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-gray-700">Penyesuaian Stok Bahan</h3>
        <Button onClick={() => setShowModal(true)}>
          <SlidersHorizontal className="w-4 h-4 mr-1.5 inline-block" />
          Penyesuaian Baru
        </Button>
      </div>

      {/* Info note */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 mb-4">
        <span className="font-bold">Penyesuaian</span> = set stok bahan ke nilai absolut. Pastikan
        menyertakan alasan yang jelas agar riwayat audit tercatat dengan benar.
      </div>

      {showModal && (
        <IngredientAdjustModal
          onClose={() => setShowModal(false)}
          onDone={() => setShowModal(false)}
        />
      )}
    </div>
  )
}
