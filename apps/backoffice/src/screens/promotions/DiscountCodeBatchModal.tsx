import type { Dispatch, SetStateAction } from 'react'
import type { Promotion, DiscountCodeBatchInput } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface DiscountCodeBatchModalProps {
  open: boolean
  busy: boolean
  /** A refused or failed batch (server message), shown inside the modal. */
  error?: string | null
  form: DiscountCodeBatchInput
  setForm: Dispatch<SetStateAction<DiscountCodeBatchInput>>
  promotions: Promotion[]
  onGenerate: () => void
  onClose: () => void
}

const COUNT_MIN = 1
const COUNT_MAX = 500
const SUFFIX_MIN = 4
const SUFFIX_MAX = 12

export function DiscountCodeBatchModal({
  open,
  busy,
  error,
  form,
  setForm,
  promotions,
  onGenerate,
  onClose,
}: DiscountCodeBatchModalProps) {
  const suffixLength = form.suffixLength ?? 6
  const countValid = form.count >= COUNT_MIN && form.count <= COUNT_MAX
  const suffixValid = suffixLength >= SUFFIX_MIN && suffixLength <= SUFFIX_MAX
  const typeValid = form.type === 'percentage' || form.type === 'fixed'
  const valueValid = form.value >= 0
  const canGenerate = countValid && suffixValid && typeValid && valueValid

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Buat Kode Diskon Massal"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button className="flex-1" loading={busy} disabled={!canGenerate} onClick={onGenerate}>
            {busy ? 'Membuat...' : 'Generate'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <Input
          label="Prefix"
          type="text"
          value={form.prefix ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value.toUpperCase() }))}
          placeholder="Contoh: PROMO7"
          className="font-mono tracking-wider"
          hint="Setiap kode = prefix ini + akhiran acak."
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Jumlah"
            type="number"
            min={COUNT_MIN}
            max={COUNT_MAX}
            value={form.count}
            onChange={(e) => setForm((f) => ({ ...f, count: parseInt(e.target.value) || 0 }))}
            error={!countValid ? `Harus ${COUNT_MIN}–${COUNT_MAX}` : undefined}
          />
          <Input
            label="Panjang Kode"
            type="number"
            min={SUFFIX_MIN}
            max={SUFFIX_MAX}
            value={suffixLength}
            onChange={(e) => setForm((f) => ({ ...f, suffixLength: parseInt(e.target.value) || 0 }))}
            error={!suffixValid ? `Harus ${SUFFIX_MIN}–${SUFFIX_MAX}` : undefined}
          />
        </div>
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
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as DiscountCodeBatchInput['type'] }))}
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
            error={!valueValid ? 'Tidak boleh negatif' : undefined}
          />
        </div>
        {!!form.promotionId && (
          <p className="text-xs text-warn-strong bg-warn-bg px-3 py-2 rounded-lg -mt-2">
            Tipe &amp; nilai diikuti dari promosi tertaut.
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Input label="Min. Beli" type="number" value={form.minPurchase || ''} onChange={(e) => setForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />
          <Input label="Batas Pakai per kode" type="number" value={form.usageLimit || ''} onChange={(e) => setForm((f) => ({ ...f, usageLimit: parseInt(e.target.value) || 0 }))} />
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
        <label className="flex items-start gap-3 p-3 bg-paper-1 rounded-xl cursor-pointer">
          <input type="checkbox" checked={form.combinable ?? false} onChange={(e) => setForm((f) => ({ ...f, combinable: e.target.checked }))} className="w-4 h-4 accent-brand-strong mt-0.5" />
          <span className="text-sm font-bold text-ink-900">Bisa dikombinasikan dengan promo/kode lain (combinable)</span>
        </label>
      </div>
    </Modal>
  )
}
