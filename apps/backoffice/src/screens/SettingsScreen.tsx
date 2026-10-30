import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@mandalika/api'
import { isCashMethod } from '@mandalika/types'
import { ToggleRight, Upload, X } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { uploadImage, getThumbnailUrl } from '../lib/uploadImage'
import { Button } from '../ui/Button'
import { Input, Field, Textarea } from '../ui/Field'
import { Card } from '../ui/Card'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { LocationsSection } from './settings/LocationsSection'
import { TransaksiSection } from './settings/TransaksiSection'
import { Toggle } from './settings/Toggle'

const DEFAULT: AppSettings = {
  taxEnabled: true,
  taxRate: 11,
  roundingEnabled: false,
  roundingType: 'nearest_500',
  roundingAmount: 1000,
  roundingDirection: 'floor',
  roundingApplyToTax: false,
  paymentMethods: [
    { id: 'cash', label: 'Tunai', isEnabled: true, isCash: true },
    { id: 'card', label: 'Kartu', isEnabled: true, isCash: false },
    { id: 'qris', label: 'QRIS', isEnabled: true, isCash: false },
    { id: 'transfer', label: 'Transfer', isEnabled: true, isCash: false },
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
  allowNegativeStock: true,
  receiveApproverRoles: [],
}

const sections = [
  { id: 'locations', label: 'Outlet & Gudang' },
  { id: 'transaksi', label: 'Transaksi' },
  { id: 'operasional', label: 'Operasional' },
  { id: 'recipe', label: 'Resep & Bahan' },
] as const

export default function SettingsScreen() {
  const q = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 30000)
  const [s, setS] = useState<AppSettings>(DEFAULT)
  const loadedRef = useRef(false)
  // splitTenderEnabled as last loaded/saved: it is sent only when the toggle moved, so a stale tab cannot undo the kill switch.
  const loadedSplitRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [approverRoles, setApproverRoles] = useState<string[]>(DEFAULT.receiveApproverRoles ?? [])
  const [newPay, setNewPay] = useState('')
  const [section, setSection] = useState<'locations' | 'transaksi' | 'operasional' | 'recipe'>('locations')
  const [logoUploading, setLogoUploading] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (q.data && !loadedRef.current) {
      setS({ ...DEFAULT, ...q.data })
      setApproverRoles((q.data.receiveApproverRoles ?? []).filter((r) => r !== 'admin'))
      loadedSplitRef.current = !!q.data.splitTenderEnabled
      loadedRef.current = true
    }
  }, [q.data])

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      // Persist the resolved cash flag explicitly for every method.
      const paymentMethods = s.paymentMethods.map((m) => ({ ...m, isCash: isCashMethod(s.paymentMethods, m.id) }))
      const { splitTenderEnabled, ...rest } = s
      const splitMoved = !!splitTenderEnabled !== loadedSplitRef.current
      await api.updateAppSettings({ ...rest, ...(splitMoved ? { splitTenderEnabled: !!splitTenderEnabled } : {}), paymentMethods, receiveApproverRoles: approverRoles })
      if (splitMoved) loadedSplitRef.current = !!splitTenderEnabled
      setMsg('Pengaturan disimpan!')
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Gagal menyimpan.')
    } finally {
      setSaving(false)
    }
  }

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

      {/* ── Outlet & Gudang ── */}
      {section === 'locations' && (
        <>
          <LocationsSection />
          <Card className="p-6 max-w-2xl space-y-5">
            <h3 className="font-black text-gray-900">Pengaturan Stok</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Izinkan Stok Minus</p>
                <p className="text-xs text-gray-400">Jika nonaktif, kasir diberi peringatan saat menjual melebihi stok (masih bisa dilanjutkan).</p>
              </div>
              <Toggle label="Izinkan stok minus" checked={s.allowNegativeStock} onClick={() => setS((p) => ({ ...p, allowNegativeStock: !p.allowNegativeStock }))} />
            </div>
          </Card>
        </>
      )}

      {/* ── Transaksi: Pajak & Pembulatan · Metode Pembayaran · Struk ── */}
      {section === 'transaksi' && (
        <TransaksiSection s={s} setS={setS} newPay={newPay} setNewPay={setNewPay} />
      )}

      {/* ── Operasional: Shift · Persetujuan Transfer · Dokumen ── */}
      {section === 'operasional' && (
        <div className="max-w-2xl space-y-5">
          {/* Sub-section: Shift */}
          <Card className="p-6 space-y-5">
            <h3 className="font-black text-gray-900">Pengaturan Shift</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Buka Shift Otomatis</p>
                <p className="text-xs text-gray-400">Shift dibuka otomatis saat kasir login</p>
              </div>
              <Toggle label="Buka shift otomatis" checked={s.autoOpenShift} onClick={() => setS((p) => ({ ...p, autoOpenShift: !p.autoOpenShift }))} />
            </div>
          </Card>

          {/* Sub-section: Persetujuan Stok */}
          <Card className="p-6 space-y-5">
            <h3 className="font-black text-gray-900">Persetujuan Stok</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Wajib persetujuan stok</p>
                <p className="text-xs text-gray-400">Koreksi stok dan opname harus disetujui peran penyetuju (di bawah) dengan PIN, penyetuju bukan pengaju (four-eyes).</p>
              </div>
              <Toggle label="Wajib persetujuan stok" checked={s.inventoryApprovalRequired ?? false} onClick={() => setS((p) => ({ ...p, inventoryApprovalRequired: !p.inventoryApprovalRequired }))} />
            </div>
          </Card>

          {/* Sub-section: Persetujuan Transfer */}
          <Card className="p-6 space-y-5">
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
                    label={`Jadikan ${role} sebagai approver`}
                    checked={approverRoles.includes(role)}
                    size="sm"
                    onClick={() => setApproverRoles((prev) =>
                      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
                    )}
                  />
                </div>
              ))}
            </div>
          </Card>

          {/* Sub-section: Dokumen */}
          <Card className="p-6 space-y-5">
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
                      aria-label="Hapus logo"
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
                aria-label="Unggah logo"
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
          </Card>
        </div>
      )}

      {/* ── Resep & Bahan ── */}
      {section === 'recipe' && (
        <Card className="p-6 max-w-2xl space-y-5">
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
              label="Aktifkan modul Resep & Bahan"
              checked={s.recipesEnabled ?? false}
              onClick={() => setS((p) => ({ ...p, recipesEnabled: !p.recipesEnabled }))}
            />
          </div>
        </Card>
      )}
    </div>
  )
}
