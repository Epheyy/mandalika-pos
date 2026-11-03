import { useCallback, useRef, useState } from 'react'
import { ToggleRight, Upload, X } from 'lucide-react'
import { uploadImage, getThumbnailUrl } from '../lib/uploadImage'
import { useUnsavedChanges } from '../lib/useUnsavedChanges'
import { Button } from '../ui/Button'
import { Input, Field, Textarea } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { PageHeader } from '../ui/PageHeader'
import { SaveBar } from '../ui/SaveBar'
import { Tabs } from '../ui/Tabs'
import { LocationsSection } from './settings/LocationsSection'
import { SettingsCard } from './settings/SettingsCard'
import { TransaksiSection } from './settings/TransaksiSection'
import { Toggle } from './settings/Toggle'
import { SAVED_MESSAGE, useSettingsDraft } from './settings/useSettingsDraft'
import type { TabId } from './settings/settingsDiff'

const sections = [
  { id: 'locations', label: 'Outlet & Gudang' },
  { id: 'transaksi', label: 'Transaksi' },
  { id: 'operasional', label: 'Operasional' },
  { id: 'recipe', label: 'Resep & Bahan' },
] as const

export default function SettingsScreen() {
  const { draft: s, setDraft: setS, changes, items, markers, conflicts, resolve, status, save, discard, fail, loaded, loadError } = useSettingsDraft()
  const [newPay, setNewPay] = useState('')
  const [section, setSection] = useState<TabId>('locations')
  const [logoUploading, setLogoUploading] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)
  const [leaveAsk, setLeaveAsk] = useState<((leave: boolean) => void) | null>(null)
  const changed = markers.cards
  const approverRoles = s.receiveApproverRoles ?? []

  const askLeave = useCallback(() => new Promise<boolean>((resolveLeave) => setLeaveAsk(() => resolveLeave)), [])
  useUnsavedChanges(changes.length > 0, askLeave)
  const answerLeave = (leave: boolean) => {
    leaveAsk?.(leave)
    setLeaveAsk(null)
  }
  const saveAndLeave = async () => answerLeave(await save())
  const discardAndLeave = () => {
    discard()
    answerLeave(true)
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
      fail('Gagal upload logo.')
    } finally {
      setLogoUploading(false)
      e.target.value = ''
    }
  }


  // Until the first GET lands the form would show defaults, and the load would overwrite any edit.
  if (!loaded) {
    return (
      <div className="p-6 space-y-5">
        <PageHeader title="Pengaturan" subtitle="Konfigurasi sistem POS" />
        {loadError ? (
          <p role="alert" className="text-sm font-bold text-red-600">Gagal memuat pengaturan: {loadError}. Mencoba lagi otomatis.</p>
        ) : (
          <p className="text-sm text-gray-400">Memuat pengaturan…</p>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Pengaturan" subtitle="Konfigurasi sistem POS" />

      <Tabs value={section} onChange={setSection} tabs={sections.map((t) => ({ ...t, dirty: markers.tabs.has(t.id) }))} />

      {/* ── Outlet & Gudang ── */}
      {section === 'locations' && (
        <>
          <LocationsSection />
          <SettingsCard changed={changed.has('stock')} className="p-6 max-w-2xl space-y-5">
            <h3 className="font-black text-gray-900">Pengaturan Stok</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Izinkan Stok Minus</p>
                <p className="text-xs text-gray-400">Jika nonaktif, kasir diberi peringatan saat menjual melebihi stok (masih bisa dilanjutkan).</p>
              </div>
              <Toggle label="Izinkan stok minus" checked={s.allowNegativeStock} onClick={() => setS((p) => ({ ...p, allowNegativeStock: !p.allowNegativeStock }))} />
            </div>
          </SettingsCard>
        </>
      )}

      {/* ── Transaksi: Pajak & Pembulatan · Metode Pembayaran · Struk ── */}
      {section === 'transaksi' && (
        <TransaksiSection s={s} setS={setS} newPay={newPay} setNewPay={setNewPay} changed={changed} />
      )}

      {/* ── Operasional: Shift · Persetujuan Transfer · Dokumen ── */}
      {section === 'operasional' && (
        <div className="max-w-2xl space-y-5">
          {/* Sub-section: Shift */}
          <SettingsCard changed={changed.has('shift')} className="p-6 space-y-5">
            <h3 className="font-black text-gray-900">Pengaturan Shift</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Buka Shift Otomatis</p>
                <p className="text-xs text-gray-400">Shift dibuka otomatis saat kasir login</p>
              </div>
              <Toggle label="Buka shift otomatis" checked={s.autoOpenShift} onClick={() => setS((p) => ({ ...p, autoOpenShift: !p.autoOpenShift }))} />
            </div>
          </SettingsCard>

          {/* Sub-section: Persetujuan Stok */}
          <SettingsCard changed={changed.has('approval')} className="p-6 space-y-5">
            <h3 className="font-black text-gray-900">Persetujuan Stok</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Wajib persetujuan stok</p>
                <p className="text-xs text-gray-400">Koreksi stok dan opname harus disetujui peran penyetuju (di bawah) dengan PIN, penyetuju bukan pengaju (four-eyes).</p>
              </div>
              <Toggle label="Wajib persetujuan stok" checked={s.inventoryApprovalRequired ?? false} onClick={() => setS((p) => ({ ...p, inventoryApprovalRequired: !p.inventoryApprovalRequired }))} />
            </div>
          </SettingsCard>

          {/* Sub-section: Persetujuan Transfer */}
          <SettingsCard changed={changed.has('transfer')} className="p-6 space-y-5">
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
                    onClick={() => setS((p) => {
                      const cur = p.receiveApproverRoles ?? []
                      return { ...p, receiveApproverRoles: cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role] }
                    })}
                  />
                </div>
              ))}
            </div>
          </SettingsCard>

          {/* Sub-section: Dokumen */}
          <SettingsCard changed={changed.has('docs')} className="p-6 space-y-5">
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
          </SettingsCard>
        </div>
      )}

      {/* ── Resep & Bahan ── */}
      {section === 'recipe' && (
        <SettingsCard changed={changed.has('recipe')} className="p-6 max-w-2xl space-y-5">
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
        </SettingsCard>
      )}

      <SaveBar
        count={changes.length}
        items={items}
        status={status.kind}
        message={status.kind === 'error' ? status.message : status.kind === 'saved' ? SAVED_MESSAGE : undefined}
        onSave={() => void save()}
        onDiscard={discard}
        notice={
          conflicts.length > 0 && (
            <div className="mb-3 space-y-2">
              {conflicts.map((c) => (
                <div key={c.path} role="alert" className="flex items-center gap-3 text-sm bg-amber-50 rounded-xl px-3 py-2">
                  <p className="flex-1 font-bold text-amber-800">{c.label} baru diubah orang lain (sekarang {c.theirs}). Punya Anda: {c.mine}.</p>
                  <Button size="sm" variant="secondary" onClick={() => resolve(c.path, 'mine')}>Pakai punya saya</Button>
                  <Button size="sm" variant="secondary" onClick={() => resolve(c.path, 'theirs')}>Pakai yang baru</Button>
                </div>
              ))}
            </div>
          )
        }
      />

      <Modal
        open={leaveAsk !== null}
        onClose={() => answerLeave(false)}
        title="Simpan perubahan Pengaturan?"
        size="sm"
        footer={
          <div className="flex gap-2 w-full">
            <Button variant="secondary" className="flex-1" onClick={() => answerLeave(false)} disabled={status.kind === 'saving'}>Tetap di sini</Button>
            <Button variant="danger" className="flex-1" onClick={discardAndLeave} disabled={status.kind === 'saving'}>Buang perubahan</Button>
            <Button className="flex-1" onClick={() => void saveAndLeave()} loading={status.kind === 'saving'}>Simpan &amp; lanjut</Button>
          </div>
        }
      >
        <p className="text-sm">Ada {changes.length} perubahan yang belum disimpan.</p>
      </Modal>
    </div>
  )
}
