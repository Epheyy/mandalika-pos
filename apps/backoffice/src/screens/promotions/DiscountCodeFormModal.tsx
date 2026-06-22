import type { Dispatch, SetStateAction } from 'react'
import type { Promotion, DiscountCodeInput } from '@mandalika/api'
import { RefreshCw } from 'lucide-react'
import { generateCode } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { Input, Select, Field, fieldClass } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface DiscountCodeFormModalProps {
  open: boolean
  editingCode: boolean
  form: DiscountCodeInput
  setForm: Dispatch<SetStateAction<DiscountCodeInput>>
  promotions: Promotion[]
  busy: boolean
  onSave: () => void
  onClose: () => void
}

export function DiscountCodeFormModal({
  open,
  editingCode,
  form,
  setForm,
  promotions,
  busy,
  onSave,
  onClose,
}: DiscountCodeFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingCode ? 'Edit Kode' : 'Tambah Kode Diskon'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button className="flex-1" loading={busy} onClick={onSave}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Kode *">
          <div className="flex gap-2">
            <input type="text" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} aria-label="Kode diskon" className={`${fieldClass} flex-1 font-mono tracking-wider`} />
            <Button variant="secondary" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => setForm((f) => ({ ...f, code: generateCode() }))} />
          </div>
        </Field>
        <Select
          label="Tautkan ke promosi"
          value={form.promotionId ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, promotionId: e.target.value || undefined }))}
        >
          <option value="">— Tidak ditautkan —</option>
          {promotions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Tipe"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as DiscountCodeInput['type'] }))}
            disabled={!!form.promotionId}
          >
            <option value="percentage">Persentase (%)</option>
            <option value="fixed">Nominal (Rp)</option>
          </Select>
          <Input
            label="Nilai"
            type="number"
            value={form.value}
            onChange={(e) => setForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))}
            disabled={!!form.promotionId}
          />
        </div>
        {!!form.promotionId && (
          <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg -mt-2">
            Tipe &amp; nilai diikuti dari promosi tertaut.
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Input label="Min. Beli" type="number" value={form.minPurchase || ''} onChange={(e) => setForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />
          <Input label="Batas Pakai" type="number" value={form.usageLimit || ''} onChange={(e) => setForm((f) => ({ ...f, usageLimit: parseInt(e.target.value) || 0 }))} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label="Mulai" type="date" value={form.startDate || ''} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
          <Input label="Berakhir" type="date" value={form.endDate || ''} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
        </div>
        <label className="flex items-start gap-3 p-3 bg-gold-50 rounded-xl cursor-pointer">
          <input type="checkbox" checked={form.combinable ?? false} onChange={(e) => setForm((f) => ({ ...f, combinable: e.target.checked }))} className="w-4 h-4 accent-gold-600 mt-0.5" />
          <span className="text-sm font-bold text-gray-900">Bisa dikombinasikan dengan promo/kode lain (combinable)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
          <span className="text-sm font-bold text-gray-700">Kode Aktif</span>
        </label>
      </div>
    </Modal>
  )
}
