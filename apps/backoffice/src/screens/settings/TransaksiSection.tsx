import { useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings } from '@mandalika/api'
import { isCashMethod } from '@mandalika/types'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Input, Select, Field } from '../../ui/Field'
import { SettingsCard } from './SettingsCard'
import type { CardId } from './settingsDiff'
import { IconButton } from '../../ui/IconButton'
import { Toggle } from './Toggle'
import { SplitTenderCard } from './SplitTenderCard'
import { isSplitMethodId } from '../../lib/splitPayment'

interface TransaksiSectionProps {
  s: AppSettings
  setS: Dispatch<SetStateAction<AppSettings>>
  newPay: string
  setNewPay: Dispatch<SetStateAction<string>>
  changed: ReadonlySet<CardId>
}

/** Transaksi tab: Pajak & Pembulatan · Metode Pembayaran · Struk. */
export function TransaksiSection({ s, setS, newPay, setNewPay, changed }: TransaksiSectionProps) {
  const [payError, setPayError] = useState<string | null>(null)
  const setReceipt = (k: string, v: unknown) =>
    setS((p) => ({ ...p, receipt: { ...p.receipt, [k]: v } }))

  return (
    <div className="max-w-2xl space-y-5">
      {/* Sub-section: Pajak & Pembulatan */}
      <SettingsCard changed={changed.has('tax')} className="p-6 space-y-5">
        <h3 className="font-black text-gray-900">Pajak &amp; Pembulatan</h3>
        <div className="flex items-center justify-between py-3 border-b border-gray-100">
          <div>
            <p className="font-bold text-gray-900">Aktifkan PPN</p>
            <p className="text-xs text-gray-400">Pajak dihitung di kasir</p>
          </div>
          <Toggle label="Aktifkan pajak" checked={s.taxEnabled} onClick={() => setS((p) => ({ ...p, taxEnabled: !p.taxEnabled }))} />
        </div>
        {s.taxEnabled && (
          <Input
            label="Tarif Pajak (%)"
            type="number"
            value={s.taxRate}
            onChange={(e) => setS((p) => ({ ...p, taxRate: parseFloat(e.target.value) || 0 }))}
            className="w-32"
          />
        )}
        <div className="flex items-center justify-between py-3 border-b border-gray-100">
          <div>
            <p className="font-bold text-gray-900">Pembulatan Harga</p>
            <p className="text-xs text-gray-400">Membulatkan total transaksi</p>
          </div>
          <Toggle label="Aktifkan pembulatan" checked={s.roundingEnabled} onClick={() => setS((p) => ({ ...p, roundingEnabled: !p.roundingEnabled }))} />
        </div>
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
      <SettingsCard changed={changed.has('payments')} className="p-6 space-y-5">
        <h3 className="font-black text-gray-900">Metode Pembayaran</h3>
        <div className="space-y-2">
          {s.paymentMethods.map((pm) => {
            // Always the RESOLVED value (id default when no explicit flag), never `?? false`.
            const isCash = isCashMethod(s.paymentMethods, pm.id)
            return (
              <div key={pm.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                <span className="font-bold text-gray-900 text-sm">{pm.label}</span>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 text-xs text-gray-500">
                    Tunai (masuk laci kas)
                    <Toggle
                      label={`Metode ${pm.label} masuk laci kas`}
                      checked={isCash}
                      size="sm"
                      onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.map((x) => x.id === pm.id ? { ...x, isCash: !isCash } : x) }))}
                    />
                  </span>
                  <Toggle
                    label={`Aktifkan metode ${pm.label}`}
                    checked={pm.isEnabled}
                    size="sm"
                    onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.map((x) => x.id === pm.id ? { ...x, isEnabled: !x.isEnabled } : x) }))}
                  />
                  {!['cash', 'card', 'qris', 'transfer'].includes(pm.id) && !isCash && (
                    <IconButton tone="danger" onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.filter((x) => x.id !== pm.id) }))}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconButton>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {!s.paymentMethods.some((m) => m.isEnabled && isCashMethod(s.paymentMethods, m.id)) && (
          <p className="text-xs font-bold text-amber-700 bg-amber-50 rounded-xl px-3 py-2">
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
            className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition"
          />
          <Button
            icon={<Plus className="w-4 h-4" />}
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
        {payError && <p role="alert" className="text-xs font-bold text-red-600">{payError}</p>}
      </SettingsCard>

      <SplitTenderCard changed={changed.has('split')} enabled={!!s.splitTenderEnabled} onChange={(v) => setS((p) => ({ ...p, splitTenderEnabled: v }))} />

      {/* Sub-section: Struk */}
      <SettingsCard changed={changed.has('receipt')} className="p-6 space-y-5">
        <h3 className="font-black text-gray-900">Pengaturan Struk</h3>
        <Input
          label="Jumlah Salinan"
          type="number"
          min={1}
          max={5}
          value={s.receipt.copies ?? 1}
          onChange={(e) => setReceipt('copies', parseInt(e.target.value) || 1)}
          className="w-32"
        />
        <div className="flex items-center justify-between py-2 border-b border-gray-100">
          <p className="font-bold text-gray-900 text-sm">Cetak struk otomatis</p>
          <Toggle label="Cetak struk otomatis" checked={!!s.receipt.autoPrint} size="sm" onClick={() => setReceipt('autoPrint', !s.receipt.autoPrint)} />
        </div>
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
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            {([
              ['showOrderNumber', 'Nomor pesanan'],
              ['showCashier', 'Dicetak oleh'],
              ['showCustomerName', 'Nama Pelanggan'],
              ['showCustomerPhone', 'Nomor Telepon'],
              ['showTax', 'Tampilkan Pajak'],
              ['showDiscount', 'Tampilkan Diskon'],
              ['showSubtotal', 'Tampilkan Subtotal'],
              ['showChange', 'Tampilkan Kembalian'],
            ] as const).map(([k, label]) => (
              <div key={k} className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0">
                <p className="font-bold text-gray-900 text-sm">{label}</p>
                <Toggle label={label} checked={!!s.receipt[k]} size="sm" onClick={() => setReceipt(k, !s.receipt[k])} />
              </div>
            ))}
          </div>
        </Field>
      </SettingsCard>
    </div>
  )
}
