import { useState } from 'react'
import { PackagePlus } from 'lucide-react'
import { Button } from '../../ui/Button'
import { IngredientGoodsInModal } from './IngredientGoodsInModal'

export default function StokMasukTab() {
  const [showModal, setShowModal] = useState(false)

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-gray-700">Stok Masuk Bahan</h3>
        <Button onClick={() => setShowModal(true)}>
          <PackagePlus className="w-4 h-4 mr-1.5 inline-block" />
          Stok Masuk Baru
        </Button>
      </div>

      {/* Info note */}
      <div className="rounded-2xl border border-gold-200 bg-gold-50 px-4 py-3 text-sm text-gold-800 mb-4">
        <span className="font-bold">Stok Masuk</span> = pemasukan bahan dari supplier. Stok
        ditambahkan ke gudang yang dipilih. Riwayat stok masuk akan tersedia di versi berikutnya.
      </div>

      {showModal && (
        <IngredientGoodsInModal
          onClose={() => setShowModal(false)}
          onDone={() => setShowModal(false)}
        />
      )}
    </div>
  )
}
