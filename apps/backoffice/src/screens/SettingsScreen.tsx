import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@mandalika/api'
import { Plus, Trash2, ToggleLeft, ToggleRight, Upload, X } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { uploadImage, getThumbnailUrl } from '../lib/uploadImage'
import { Button, Input, Select, Field, Card, IconButton, PageHeader, Tabs, Textarea } from '../ui'

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
  receiveApproverRoles: [],
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
  const [section, setSection] = useState<'tax' | 'payment' | 'receipt' | 'shift' | 'approver' | 'documents' | 'recipes'>('tax')
  const [logoUploading, setLogoUploading] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (q.data && !loaded) {
      setS({ ...DEFAULT, ...q.data })
      setApproverRoles((q.data.receiveApproverRoles ?? []).filter((r) => r !== 'admin'))
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

  const setDoc = (k: string, v: string | undefined) =>
    setS((p) => ({ ...p, documents: { ...p.documents, [k]: v } }))

  const onLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoUploading(true)
    try {
      const url = await uploadImage(file, 'mandalika-pos/settings')
      setDoc('logoUrl', url)
    } catch {
      setMsg('Gagal upload logo.')
    } finally {
      setLogoUploading(false)
      e.target.value = ''
    }
  }

  const sections = [
    { id: 'tax', label: 'Pajak & Pembulatan' },
    { id: 'payment', label: 'Metode Pembayaran' },
    { id: 'receipt', label: 'Struk' },
    { id: 'shift', label: 'Shift' },
    { id: 'approver', label: 'Persetujuan Transfer' },
    { id: 'documents', label: 'Dokumen' },
    { id: 'recipes', label: 'Resep & Bahan' },
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
            <p className="text-xs text-gray-400">Admin selalu boleh; pilih peran lain yang boleh menyetujui penerimaan di POS.</p>
            <div className="border border-gray-100 rounded-xl overflow-hidden mt-2">
              {/* Admin row — always-on, non-interactive */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-50 opacity-60">
                <div>
                  <p className="font-bold text-gray-900 text-sm capitalize">Admin</p>
                  <p className="text-xs text-gray-400">Admin selalu dapat menyetujui.</p>
                </div>
                <ToggleRight className="w-6 h-6 text-gold-600" />
              </div>
              {/* Manager & cashier — real interactive toggles */}
              {(['manager', 'cashier'] as const).map((role) => (
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

        {section === 'recipes' && (
          <>
            <h3 className="font-black text-gray-900">Resep &amp; Bahan</h3>
            <p className="text-xs text-gray-400">
              Aktifkan modul Resep &amp; Bahan untuk melacak bahan baku per gudang dan formula per
              produk. Saat dinonaktifkan, tab Bahan tidak akan muncul di layar Gudang.
            </p>
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Aktifkan modul Resep &amp; Bahan</p>
              </div>
              <Toggle
                checked={s.recipesEnabled ?? false}
                onClick={() => setS((p) => ({ ...p, recipesEnabled: !p.recipesEnabled }))}
              />
            </div>
          </>
        )}

        {section === 'documents' && (
          <>
            <h3 className="font-black text-gray-900">Dokumen Pengiriman</h3>
            <p className="text-xs text-gray-400">
              Identitas merek yang muncul di surat jalan dan tanda terima. Bisa ditimpa per gudang/outlet (di halaman masing-masing).
            </p>

            {/* Brand name */}
            <Input
              label="Nama Merek"
              type="text"
              value={s.documents?.brandName ?? ''}
              onChange={(e) => setDoc('brandName', e.target.value || undefined)}
              placeholder="mis. Mandalika Perfume"
            />
            <p className="text-xs text-gray-400 -mt-3">Muncul di kepala surat jalan &amp; tanda terima.</p>

            {/* Logo upload */}
            <Field label="Logo">
              <div className="flex items-center gap-3">
                {s.documents?.logoUrl ? (
                  <div className="relative w-20 h-20 rounded-xl overflow-hidden border border-gray-200 bg-gray-50 flex-shrink-0">
                    <img
                      src={getThumbnailUrl(s.documents.logoUrl, 160, 160)}
                      alt="Logo"
                      className="w-full h-full object-contain"
                    />
                    <button
                      type="button"
                      onClick={() => setDoc('logoUrl', undefined)}
                      className="absolute top-1 right-1 bg-white rounded-full p-0.5 shadow hover:bg-red-50 transition"
                    >
                      <X className="w-3 h-3 text-gray-500" />
                    </button>
                  </div>
                ) : (
                  <div className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 flex items-center justify-center flex-shrink-0">
                    <Upload className="w-6 h-6 text-gray-300" />
                  </div>
                )}
                <div className="space-y-1">
                  <Button
                    onClick={() => logoFileRef.current?.click()}
                    loading={logoUploading}
                  >
                    {logoUploading ? 'Mengupload...' : 'Pilih Gambar'}
                  </Button>
                  <p className="text-xs text-gray-400">PNG/JPG, maks 5 MB. Disarankan ukuran persegi.</p>
                </div>
              </div>
              <input
                ref={logoFileRef}
                type="file"
                accept="image/*"
                onChange={onLogoFile}
                className="hidden"
              />
            </Field>

            {/* Address */}
            <Textarea
              label="Alamat"
              value={s.documents?.addressLines ?? ''}
              rows={3}
              onChange={(e) => setDoc('addressLines', e.target.value || undefined)}
              placeholder="Jl. Contoh No. 1&#10;Kota, Provinsi&#10;Kode Pos"
            />
            <p className="text-xs text-gray-400 -mt-3">Pisahkan setiap baris dengan Enter.</p>

            {/* Phone */}
            <Input
              label="Telepon"
              type="text"
              value={s.documents?.phone ?? ''}
              onChange={(e) => setDoc('phone', e.target.value || undefined)}
              placeholder="mis. +62 812 3456 7890"
            />

            {/* NPWP */}
            <Input
              label="NPWP (opsional)"
              type="text"
              value={s.documents?.npwp ?? ''}
              onChange={(e) => setDoc('npwp', e.target.value || undefined)}
              placeholder="mis. 00.000.000.0-000.000"
            />
          </>
        )}
      </Card>
    </div>
  )
}
