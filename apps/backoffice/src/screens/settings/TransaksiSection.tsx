import { useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings } from '@mandalika/api'
import { isCashMethod, resolveReceiptFlags } from '@mandalika/types'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Input, Select, Field } from '../../ui/Field'
import { SettingsCard } from './SettingsCard'
import { SettingRow } from './SettingRow'
import { changeAt, type CardId, type Change } from './settingsDiff'
import { IconButton } from '../../ui/IconButton'
import { Switch } from '../../ui/Switch'
import { SplitTenderCard } from './SplitTenderCard'
import { isSplitMethodId } from '../../lib/splitPayment'
import { receiptCopiesError } from '../../lib/inputRules'

interface TransaksiSectionProps {
  s: AppSettings
  setS: Dispatch<SetStateAction<AppSettings>>
  newPay: string
  setNewPay: Dispatch<SetStateAction<string>>
  changed: ReadonlySet<CardId>
  /** Pending changes: they tint the changed rows and give each its "Sebelumnya" hint. */
  changes: readonly Change[]
}

// Method name | cash-drawer switch | enabled switch | delete: the header row and every method row share it.
const PAY_GRID = 'grid grid-cols-[minmax(0,1fr)_6.5rem_3.5rem_2.25rem] items-center gap-2'

/** Transaksi tab: Pajak & Pembulatan · Metode Pembayaran · Struk. */
export function TransaksiSection({ s, setS, newPay, setNewPay, changed, changes }: TransaksiSectionProps) {
  const receiptFlags = resolveReceiptFlags(s.receipt)
  const [payError, setPayError] = useState<string | null>(null)
  const setReceipt = (k: string, v: unknown) =>
    setS((p) => ({ ...p, receipt: { ...p.receipt, [k]: v } }))

  return (
    <div className="max-w-4xl space-y-5">
      {/* Sub-section: Pajak & Pembulatan */}
      <SettingsCard changed={changed.has('tax')} title="Pajak & pembulatan" className="p-6 space-y-5">
        <SettingRow title="Aktifkan pajak (PPN)" hint="Pajak dihitung di kasir" change={changeAt(changes, 'taxEnabled')}>
          <Switch label="Aktifkan pajak" checked={s.taxEnabled} onChange={() => setS((p) => ({ ...p, taxEnabled: !p.taxEnabled }))} />
        </SettingRow>
        {s.taxEnabled && (
          <Input
            label="Tarif Pajak (%)"
            type="number"
            value={s.taxRate}
            onChange={(e) => setS((p) => ({ ...p, taxRate: parseFloat(e.target.value) || 0 }))}
            className="w-32"
          />
        )}
        <SettingRow title="Pembulatan harga" hint="Membulatkan total transaksi" change={changeAt(changes, 'roundingEnabled')}>
          <Switch label="Aktifkan pembulatan" checked={s.roundingEnabled} onChange={() => setS((p) => ({ ...p, roundingEnabled: !p.roundingEnabled }))} />
        </SettingRow>
        {s.roundingEnabled && (
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Pembulatan ke"
              value={s.roundingAmount ?? 1000}
              onChange={(e) => setS((p) => ({ ...p, roundingAmount: parseInt(e.target.value) }))}
            >
              {[1, 10, 100, 500, 1000].map((v) => (
                <option key={v} value={v}>{v.toLocaleString('id-ID')}</option>
              ))}
            </Select>
            <Select
              label="Tipe Pembulatan"
              value={s.roundingDirection ?? 'floor'}
              onChange={(e) => setS((p) => ({ ...p, roundingDirection: e.target.value as AppSettings['roundingDirection'] }))}
            >
              <option value="floor">Ke bawah</option>
              <option value="ceil">Ke atas</option>
              <option value="nearest">Terdekat</option>
            </Select>
          </div>
        )}
      </SettingsCard>

      {/* Sub-section: Metode Pembayaran */}
      <SettingsCard changed={changed.has('payments')} title="Metode pembayaran" className="p-6 space-y-5">
        <div className="space-y-2">
          {/* #18: the two switch columns are named once, here, instead of repeating the wording in every row. */}
          <div className={`${PAY_GRID} px-3 text-[11px] font-bold text-ink-700`}>
            <span>Metode</span>
            <span className="text-center">Masuk laci kas</span>
            <span className="text-center">Aktif</span>
            <span />
          </div>
          {s.paymentMethods.map((pm) => {
            // Always the RESOLVED value (id default when no explicit flag), never `?? false`.
            const isCash = isCashMethod(s.paymentMethods, pm.id)
            const enabledChange = changeAt(changes, `paymentMethods[${pm.id}].isEnabled`)
            const cashChange = changeAt(changes, `paymentMethods[${pm.id}].isCash`)
            const rowChanged = !!(enabledChange || cashChange)
            return (
              <div key={pm.id} data-changed={rowChanged ? 'true' : undefined} className={`${PAY_GRID} p-3 rounded-xl ${rowChanged ? 'bg-warn-bg' : 'bg-paper-1'}`}>
                <span>
                  <span className="block font-bold text-ink-900 text-sm">{pm.label}</span>
                  {enabledChange && <span className="block text-xs font-bold text-warn-strong">Aktif sebelumnya {enabledChange.from}</span>}
                  {cashChange && <span className="block text-xs font-bold text-warn-strong">Masuk laci kas sebelumnya {cashChange.from}</span>}
                </span>
                <span className="flex justify-center">
                  <Switch
                    label={`Metode ${pm.label} masuk laci kas`}
                    checked={isCash}
                    size="sm"
                    onChange={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.map((x) => x.id === pm.id ? { ...x, isCash: !isCash } : x) }))}
                  />
                </span>
                <span className="flex justify-center">
                  <Switch
                    label={`Aktifkan metode ${pm.label}`}
                    checked={pm.isEnabled}
                    size="sm"
                    onChange={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.map((x) => x.id === pm.id ? { ...x, isEnabled: !x.isEnabled } : x) }))}
                  />
                </span>
                {!['cash', 'card', 'qris', 'transfer'].includes(pm.id) && !isCash ? (
                  <IconButton tone="danger" label={`Hapus metode ${pm.label}`} onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.filter((x) => x.id !== pm.id) }))}>
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </IconButton>
                ) : (
                  <span aria-hidden="true" />
                )}
              </div>
            )
          })}
        </div>
        {!s.paymentMethods.some((m) => m.isEnabled && isCashMethod(s.paymentMethods, m.id)) && (
          <p className="text-xs font-bold text-warn-strong bg-warn-bg rounded-xl px-3 py-2">
            Belum ada metode pembayaran tunai yang aktif: kasir tidak bisa menerima uang tunai dan kembalian.
          </p>
        )}
        <div className="flex gap-2 items-stretch">
          <input
            type="text"
            value={newPay}
            onChange={(e) => setNewPay(e.target.value)}
            placeholder="Nama metode baru..."
            aria-label="Nama metode pembayaran baru"
            className="flex-1 px-3 py-2.5 bg-paper-1 border border-paper-2 rounded-xl text-sm text-ink-900 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-brand-strong/40 focus:border-brand-strong transition"
          />
          <Button
            icon={<Plus className="w-4 h-4" />}
            aria-label="Tambah metode pembayaran"
            onClick={() => {
              if (!newPay.trim()) return
              const pid = newPay.toLowerCase().replace(/\s+/g, '_')
              if (isSplitMethodId(pid)) {
                setPayError('Nama "split" dicadangkan untuk pembayaran terpisah dan tidak bisa dipakai sebagai metode.')
                return
              }
              setPayError(null)
              if (s.paymentMethods.some((p) => p.id.toLowerCase() === pid)) return
              setS((p) => ({ ...p, paymentMethods: [...p.paymentMethods, { id: pid, label: newPay.trim(), isEnabled: true }] }))
              setNewPay('')
            }}
          />
        </div>
        {payError && <p role="alert" className="text-xs font-bold text-danger">{payError}</p>}
      </SettingsCard>

      <SplitTenderCard changed={changed.has('split')} change={changeAt(changes, 'splitTenderEnabled')} enabled={!!s.splitTenderEnabled} onChange={(v) => setS((p) => ({ ...p, splitTenderEnabled: v }))} />

      {/* Sub-section: Struk */}
      <SettingsCard changed={changed.has('receipt')} title="Struk" className="p-6 space-y-5">
        <Input
          label="Jumlah Salinan"
          type="number"
          min={1}
          max={5}
          value={s.receipt.copies ?? ''}
          error={receiptCopiesError(s.receipt.copies)}
          onChange={(e) => setReceipt('copies', e.target.value === '' ? undefined : Number(e.target.value))}
          className="w-32"
        />
        <SettingRow title="Cetak struk otomatis" change={changeAt(changes, 'receipt.autoPrint')}>
          <Switch label="Cetak struk otomatis" checked={!!s.receipt.autoPrint} size="sm" onChange={() => setReceipt('autoPrint', !s.receipt.autoPrint)} />
        </SettingRow>
        {([['headerText', 'Teks Header'], ['footerText', 'Teks Footer']] as const).map(([k, label]) => (
          <Input
            key={k}
            label={label}
            type="text"
            value={s.receipt[k]}
            onChange={(e) => setReceipt(k, e.target.value)}
          />
        ))}
        <Field label="Tampilan Struk">
          <div className="border border-paper-2 rounded-xl overflow-hidden">
            {([
              ['showOrderNumber', 'Nomor pesanan'],
              ['showCashier', 'Dicetak oleh'],
              ['showCustomerName', 'Nama Pelanggan'],
              ['showCustomerPhone', 'Nomor Telepon'],
              ['showTax', 'Tampilkan Pajak'],
              ['showDiscount', 'Tampilkan Diskon'],
              ['showSubtotal', 'Tampilkan Subtotal'],
              ['showChange', 'Tampilkan Kembalian'],
            ] as const).map(([k, label]) => {
              const on = receiptFlags[k]
              return (
              <div key={k} className="flex items-center justify-between px-4 py-3 border-b border-paper-2 last:border-0">
                <p className="font-bold text-ink-900 text-sm">{label}</p>
                <Switch label={label} checked={on} size="sm" onChange={() => setReceipt(k, !on)} />
              </div>
              )
            })}
          </div>
        </Field>
      </SettingsCard>
    </div>
  )
}
