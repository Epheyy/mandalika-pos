import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Promotion, DiscountCodeInput, Customer } from '@mandalika/api'
import { RefreshCw } from 'lucide-react'
import { api } from '../../api'
import { generateCode } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { Input, Select, Field, fieldClass } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { CUSTOMER_PHONE_HINT } from './customerLookupMode'

interface DiscountCodeFormModalProps {
  open: boolean
  editingCode: boolean
  form: DiscountCodeInput
  setForm: Dispatch<SetStateAction<DiscountCodeInput>>
  promotions: Promotion[]
  /** Display-only name for form.customerId (DiscountCodeInput has no customerName field). */
  customerName: string
  /** The caller may only find customers by a full phone number (A30). */
  phoneOnly?: boolean
  onCustomerChange: (id: string | undefined, name: string) => void
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
  customerName,
  phoneOnly = false,
  onCustomerChange,
  busy,
  onSave,
  onClose,
}: DiscountCodeFormModalProps) {
  // Debounced customer typeahead — mirrors the pattern in Customers.tsx (phoneDupe lookup).
  const [custQuery, setCustQuery] = useState('')
  const [custResults, setCustResults] = useState<Customer[]>([])

  useEffect(() => {
    if (!custQuery.trim()) { setCustResults([]); return }
    let ignore = false
    const t = setTimeout(async () => {
      try {
        const results = phoneOnly
          ? await api.lookupCustomerByPhone(custQuery.trim())
          : await api.lookupCustomers(custQuery, 10)
        if (!ignore) setCustResults(results)
      } catch {
        if (!ignore) setCustResults([])
      }
    }, 250)
    return () => { clearTimeout(t); ignore = true }
  }, [custQuery, phoneOnly])

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
        <Field label="Khusus pelanggan (opsional)" hint="kosong = bisa dipakai siapa saja">
          {form.customerId ? (
            <div className="flex items-center justify-between px-3 py-2.5 bg-gold-50 border border-gold-200 rounded-xl">
              <span className="text-sm font-bold text-gray-900 truncate">{customerName || form.customerId}</span>
              <button
                type="button"
                onClick={() => onCustomerChange(undefined, '')}
                className="flex items-center justify-center w-7 h-7 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 text-lg font-bold shrink-0"
                aria-label="Hapus pelanggan terpilih"
              >×</button>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                value={custQuery}
                onChange={(e) => setCustQuery(e.target.value)}
                placeholder={phoneOnly ? 'No. HP lengkap pelanggan…' : 'Cari nama / no. HP pelanggan…'}
                aria-label="Cari pelanggan"
                className={fieldClass}
              />
              {phoneOnly && <p className="text-xs text-gray-500">{CUSTOMER_PHONE_HINT}</p>}
              {custQuery.trim() && (
                <div className="rounded-lg border border-gray-200 bg-white max-h-44 overflow-auto">
                  {custResults.length === 0 ? (
                    <p className="px-3 py-2.5 text-xs text-gray-400">Tidak ada pelanggan cocok.</p>
                  ) : (
                    custResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { onCustomerChange(c.id, c.name); setCustQuery(''); setCustResults([]) }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gold-50 flex justify-between items-center border-b border-gray-50 last:border-0"
                      >
                        <span className="font-medium text-gray-800">{c.name}</span>
                        <span className="text-gray-400 text-xs">{c.phone}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </Field>
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
        <Input
          label="Batas per pelanggan"
          type="number"
          min={1}
          value={form.perCustomerLimit ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, perCustomerLimit: e.target.value === '' ? undefined : Number(e.target.value) }))}
          hint="kosong = tak terbatas"
        />
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
