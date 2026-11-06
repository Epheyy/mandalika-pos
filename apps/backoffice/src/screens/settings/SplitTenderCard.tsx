import { useState } from 'react'
import { Button } from '../../ui/Button'
import { SettingsCard } from './SettingsCard'
import { Modal } from '../../ui/Modal'
import { Switch } from '../../ui/Switch'

/** D-50 warning shown on the card and again in the confirm before switching on. */
export const SPLIT_TENDER_WARNING =
  'Aktifkan hanya setelah semua tablet aktif memakai POS versi 2.5.0 atau lebih baru. Tablet versi lama tidak bisa membagi pembayaran dan salah mencatat transaksi terpisah di rekap shift-nya.'
export const SPLIT_TENDER_OFF_NOTE =
  'Mematikan hanya menyembunyikan "Bayar terpisah" di kasir. Penjualan terpisah yang sudah antre di tablet tetap diterima server.'

interface Props {
  enabled: boolean
  changed?: boolean
  onChange: (next: boolean) => void
}

/** Transaksi tab: "Bayar terpisah" (split payment) switch. Switching on asks first; it still needs "Simpan perubahan". */
export function SplitTenderCard({ enabled, changed, onChange }: Props) {
  const [confirming, setConfirming] = useState(false)
  return (
    <SettingsCard changed={changed} className="p-6 space-y-4">
      <h3 className="font-black text-ink-900">Pembayaran Terpisah</h3>
      <div className="flex items-center justify-between py-1">
        <div>
          <p className="font-bold text-ink-900">Bayar terpisah</p>
          <p className="text-xs text-ink-700">Satu transaksi bisa dibayar dengan beberapa metode (label: Split-Payment)</p>
        </div>
        <Switch
          label="Bayar terpisah"
          checked={enabled}
          onChange={() => (enabled ? onChange(false) : setConfirming(true))}
        />
      </div>
      <p className="text-xs font-bold text-warn-strong bg-warn-bg rounded-xl px-3 py-2">{SPLIT_TENDER_WARNING}</p>
      <p className="text-xs text-ink-700">{SPLIT_TENDER_OFF_NOTE}</p>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Aktifkan Bayar terpisah?"
        size="sm"
        footer={
          <div className="flex gap-2 w-full">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirming(false)}>Batal</Button>
            <Button className="flex-1" onClick={() => { setConfirming(false); onChange(true) }}>Ya, aktifkan</Button>
          </div>
        }
      >
        <div className="space-y-2 text-sm">
          <p>{SPLIT_TENDER_WARNING}</p>
          <p className="text-xs text-ink-700">Berlaku setelah Anda menekan Simpan perubahan. Tablet mengambilnya saat sinkron berikutnya.</p>
        </div>
      </Modal>
    </SettingsCard>
  )
}
