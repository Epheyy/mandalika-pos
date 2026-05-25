import { useEffect, useState } from 'react'
import type { AppSettings } from '@mandalika/api'
import { Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { Button, Input, Select, Field, Card, IconButton, PageHeader, Tabs } from '../ui'

const DEFAULT: AppSettings = {
  taxEnabled: true,
  taxRate: 11,
  roundingEnabled: false,
  roundingType: 'nearest_500',
  roundingAmount: 1000,
  roundingDirection: 'floor',
  roundingApplyToTax: false,
  paymentMethods: [
    { id: 'cash', label: 'Tunai', isEnabled: true },
    { id: 'card', label: 'Kartu', isEnabled: true },
    { id: 'qris', label: 'QRIS', isEnabled: true },
    { id: 'transfer', label: 'Transfer', isEnabled: true },
  ],
  receipt: {
    headerText: 'Mandalika Perfume',
    footerText: 'Terima kasih telah berbelanja!',
    showTax: true,
    showCashier: true,
    copies: 1,
    autoPrint: false,
    showOrderNumber: true,
    showCustomerName: true,
    showCustomerPhone: true,
    showDiscount: true,
    showSubtotal: true,
    showChange: true,
  },
  autoOpenShift: false,
  receiveApproverRoles: ['admin'],
}

/** Gold-toned on/off switch — semantic toggle for enable rows. */
function Toggle({
  checked,
  onClick,
  size = 'md',
}: {
  checked: boolean
  onClick: () => void
  size?: 'sm' | 'md'
}) {
  const cls = size === 'md' ? 'w-7 h-7' : 'w-6 h-6'
  return (
    <button onClick={onClick} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500/40 rounded-lg">
      {checked ? (
        <ToggleRight className={`${cls} text-gold-600`} />
      ) : (
        <ToggleLeft className={`${cls} text-gray-400`} />
      )}
    </button>
  )
}

export default function SettingsScreen() {
  const q = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 30000)
  const [s, setS] = useState<AppSettings>(DEFAULT)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [approverRoles, setApproverRoles] = useState<string[]>(DEFAULT.receiveApproverRoles ?? [])
  const [newPay, setNewPay] = useState('')
  const [section, setSection] = useState<'tax' | 'payment' | 'receipt' | 'shift' | 'approver'>('tax')

  useEffect(() => {
    if (q.data && !loaded) {
      setS({ ...DEFAULT, ...q.data })
      setApproverRoles(q.data.receiveApproverRoles ?? [])
      setLoaded(true)
    }
  }, [q.data, loaded])

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      await api.updateAppSettings({ ...s, receiveApproverRoles: approverRoles })
      setMsg('Pengaturan disimpan!')
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Gagal menyimpan.')
    } finally {
      setSaving(false)
    }
  }

  const setReceipt = (k: string, v: unknown) =>
    setS((p) => ({ ...p, receipt: { ...p.receipt, [k]: v } }))

  const sections = [
    { id: 'tax', label: 'Pajak & Pembulatan' },
    { id: 'payment', label: 'Metode Pembayaran' },
    { id: 'receipt', label: 'Struk' },
    { id: 'shift', label: 'Shift' },
    { id: 'approver', label: 'Persetujuan Transfer' },
  ] as const

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Pengaturan"
        subtitle="Konfigurasi sistem POS"
        actions={
          <Button onClick={save} loading={saving}>
            {saving ? 'Menyimpan...' : 'Simpan Semua'}
          </Button>
        }
      />
      {msg && (
        <p className={`text-sm ${msg.includes('disimpan') ? 'text-green-600' : 'text-red-600'}`}>{msg}</p>
      )}

      <Tabs value={section} onChange={setSection} tabs={sections} />

      <Card className="p-6 max-w-2xl space-y-5">
        {section === 'tax' && (
          <>
            <h3 className="font-black text-gray-900">Pajak & Pembulatan</h3>
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Aktifkan PPN</p>
                <p className="text-xs text-gray-400">Pajak dihitung di kasir</p>
              </div>
              <Toggle checked={s.taxEnabled} onClick={() => setS((p) => ({ ...p, taxEnabled: !p.taxEnabled }))} />
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
              <Toggle checked={s.roundingEnabled} onClick={() => setS((p) => ({ ...p, roundingEnabled: !p.roundingEnabled }))} />
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
          </>
        )}

        {section === 'payment' && (
          <>
            <h3 className="font-black text-gray-900">Metode Pembayaran</h3>
            <div className="space-y-2">
              {s.paymentMethods.map((pm) => (
                <div key={pm.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                  <span className="font-bold text-gray-900 text-sm">{pm.label}</span>
                  <div className="flex items-center gap-2">
                    <Toggle
                      checked={pm.isEnabled}
                      size="sm"
                      onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.map((x) => x.id === pm.id ? { ...x, isEnabled: !x.isEnabled } : x) }))}
                    />
                    {!['cash', 'card', 'qris', 'transfer'].includes(pm.id) && (
                      <IconButton tone="danger" onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.filter((x) => x.id !== pm.id) }))}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </IconButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 items-stretch">
              <input
                type="text"
                value={newPay}
                onChange={(e) => setNewPay(e.target.value)}
                placeholder="Nama metode baru..."
                className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition"
              />
              <Button
                icon={<Plus className="w-4 h-4" />}
                onClick={() => {
                  if (!newPay.trim()) return
                  const pid = newPay.toLowerCase().replace(/\s+/g, '_')
                  if (s.paymentMethods.some((p) => p.id === pid)) return
                  setS((p) => ({ ...p, paymentMethods: [...p.paymentMethods, { id: pid, label: newPay.trim(), isEnabled: true }] }))
                  setNewPay('')
                }}
              />
            </div>
          </>
        )}

        {section === 'receipt' && (
          <>
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
              <Toggle checked={!!s.receipt.autoPrint} size="sm" onClick={() => setReceipt('autoPrint', !s.receipt.autoPrint)} />
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
                    <Toggle checked={!!s.receipt[k]} size="sm" onClick={() => setReceipt(k, !s.receipt[k])} />
                  </div>
                ))}
              </div>
            </Field>
          </>
        )}

        {section === 'shift' && (
          <>
            <h3 className="font-black text-gray-900">Pengaturan Shift</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Buka Shift Otomatis</p>
                <p className="text-xs text-gray-400">Shift dibuka otomatis saat kasir login</p>
              </div>
              <Toggle checked={s.autoOpenShift} onClick={() => setS((p) => ({ ...p, autoOpenShift: !p.autoOpenShift }))} />
            </div>
          </>
        )}

        {section === 'approver' && (
          <>
            <h3 className="font-black text-gray-900">Persetujuan Penerimaan Transfer</h3>
            <p className="text-xs text-gray-400">Peran yang boleh menyetujui penerimaan transfer di POS.</p>
            <div className="border border-gray-100 rounded-xl overflow-hidden mt-2">
              {(['admin', 'manager', 'cashier'] as const).map((role) => (
                <div key={role} className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0">
                  <p className="font-bold text-gray-900 text-sm capitalize">{role}</p>
                  <Toggle
                    checked={approverRoles.includes(role)}
                    size="sm"
                    onClick={() => setApproverRoles((prev) =>
                      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
                    )}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
