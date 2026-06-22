import type { Dispatch, SetStateAction } from 'react'
import type { Product, PromotionInput } from '@mandalika/api'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Input, Select, Textarea, Field } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']

interface PromoFormModalProps {
  open: boolean
  editingPromo: boolean
  form: PromotionInput
  setForm: Dispatch<SetStateAction<PromotionInput>>
  products: Product[]
  variantPicker: string | null
  setVariantPicker: Dispatch<SetStateAction<string | null>>
  busy: boolean
  onSave: () => void
  onClose: () => void
}

export function PromoFormModal({
  open,
  editingPromo,
  form,
  setForm,
  products,
  variantPicker,
  setVariantPicker,
  busy,
  onSave,
  onClose,
}: PromoFormModalProps) {
  const toggleVariant = (pid: string, size: string) => {
    const key = `${pid}::${size}`
    setForm((f) => ({
      ...f,
      applicableVariantKeys: (f.applicableVariantKeys || []).includes(key)
        ? (f.applicableVariantKeys || []).filter((k) => k !== key)
        : [...(f.applicableVariantKeys || []), key],
    }))
  }
  const toggleDay = (d: number) =>
    setForm((f) => ({
      ...f,
      activeDays: (f.activeDays || []).includes(d)
        ? (f.activeDays || []).filter((x) => x !== d)
        : [...(f.activeDays || []), d],
    }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editingPromo ? 'Edit Promosi' : 'Tambah Promosi'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button className="flex-1" loading={busy} onClick={onSave}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nama Promosi *" type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Textarea label="Deskripsi" value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
        <div className="grid grid-cols-2 gap-4">
          <Select label="Tipe" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PromotionInput['type'] }))}>
            <option value="percentage">Persentase (%)</option>
            <option value="fixed">Nominal (Rp)</option>
            <option value="bogo">Buy 1 Get 1</option>
          </Select>
          {form.type !== 'bogo' && (
            <Input label="Nilai" type="number" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
          )}
        </div>
        <Input label="Minimum Pembelian (Rp)" type="number" value={form.minPurchase || ''} onChange={(e) => setForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Mulai" type="date" value={form.startDate || ''} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
          <Input label="Berakhir" type="date" value={form.endDate || ''} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
        </div>
        <Field label="Aktif Hari (kosong = semua)">
          <div className="flex gap-1.5 flex-wrap">
            {DAYS.map((d, i) => (
              <button key={d} type="button" onClick={() => toggleDay(i)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(form.activeDays || []).includes(i) ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
            ))}
          </div>
        </Field>
        <label className="flex items-start gap-3 p-3 bg-gold-50 rounded-xl cursor-pointer">
          <input type="checkbox" checked={form.combinable ?? false} onChange={(e) => setForm((f) => ({ ...f, combinable: e.target.checked }))} className="w-4 h-4 accent-gold-600 mt-0.5" />
          <span className="text-sm font-bold text-gray-900">Bisa dikombinasikan dengan promosi lain</span>
        </label>
        <label className="flex items-start gap-3 p-3 bg-gold-50 rounded-xl cursor-pointer">
          <input type="checkbox" checked={form.codeOnly ?? false} onChange={(e) => setForm((f) => ({ ...f, codeOnly: e.target.checked }))} className="w-4 h-4 accent-gold-600 mt-0.5" />
          <span className="text-sm font-bold text-gray-900">Hanya via kode (sembunyikan dari panel kasir)</span>
        </label>
        <Field label="Varian Spesifik (opsional)">
          <div className="max-h-48 overflow-y-auto space-y-1 border border-gray-200 rounded-xl p-2">
            {products.map((p) => (
              <div key={p.id}>
                <button type="button" onClick={() => setVariantPicker(variantPicker === p.id ? null : p.id)} className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-gray-50 rounded-lg text-left">
                  <span className="text-sm font-bold text-gray-700">{p.name}</span>
                  {variantPicker === p.id ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                </button>
                {variantPicker === p.id && (
                  <div className="ml-4 space-y-0.5 mt-0.5">
                    {p.variants.map((v) => {
                      const key = `${p.id}::${v.size}`
                      return (
                        <label key={v.size} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1">
                          <input type="checkbox" checked={(form.applicableVariantKeys || []).includes(key)} onChange={() => toggleVariant(p.id, v.size)} className="accent-gold-600" />
                          <span className="text-xs text-gray-600">{v.size} — {BRAND.currency.format(v.price)}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Field>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
          <span className="text-sm font-bold text-gray-700">Promosi Aktif</span>
        </label>
      </div>
    </Modal>
  )
}
