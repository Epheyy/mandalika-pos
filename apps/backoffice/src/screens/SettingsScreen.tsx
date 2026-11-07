import { useCallback, useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { uploadImage, getThumbnailUrl } from '../lib/uploadImage'
import { useUnsavedChanges } from '../lib/useUnsavedChanges'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Input, Field, Textarea } from '../ui/Field'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { PageHeader } from '../ui/PageHeader'
import { SaveBar } from '../ui/SaveBar'
import { Tabs } from '../ui/Tabs'
import { routeById } from '../lib/router/routes'
import { useScreenTabs } from '../lib/router/useScreenTabs'
import { LocationsSection } from './settings/LocationsSection'
import { SettingsCard } from './settings/SettingsCard'
import { SettingRow } from './settings/SettingRow'
import { TransaksiSection } from './settings/TransaksiSection'
import { Switch } from '../ui/Switch'
import { SAVED_MESSAGE, useSettingsDraft } from './settings/useSettingsDraft'
import { CARD_TITLE, changeAt, type TabId } from './settings/settingsDiff'

// Moves inside Pengaturan (its own tabs) are not a leave: the draft survives them, so the guard only asks for moves out.
const SETTINGS_SCOPE = [routeById('settings')?.path ?? 'pengaturan'] as const

export default function SettingsScreen() {
  const { draft: s, setDraft: setS, changes, items, markers, conflicts, resolve, status, save, discard, fail, loaded, loadError } = useSettingsDraft()
  const [newPay, setNewPay] = useState('')
  // The section lives in the path (#/pengaturan/transaksi); a bare #/pengaturan is Outlet & Gudang.
  const { strip: sections, tab: routedSection, setTab: setSection } = useScreenTabs<TabId>('settings', null)
  const section: TabId = routedSection ?? 'locations'
  const [logoUploading, setLogoUploading] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)
  const [leaveAsk, setLeaveAsk] = useState<((leave: boolean) => void) | null>(null)
  const changed = markers.cards
  const approverRoles = s.receiveApproverRoles ?? []

  // #15: the leave question names the sections that hold changes (from the same `changes` the save bar counts).
  const changedCards = [...new Set(changes.map((c) => CARD_TITLE[c.card]))]
  const leaveDetail = changedCards.length > 0 ? ` (${changedCards.join(', ')})` : ''

  const askLeave = useCallback(() => new Promise<boolean>((resolveLeave) => setLeaveAsk(() => resolveLeave)), [])
  useUnsavedChanges(changes.length > 0, askLeave, SETTINGS_SCOPE)
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
        <PageHeader title="Pengaturan" subtitle="Berlaku untuk semua outlet; tablet mengambilnya saat sinkron berikutnya." />
        {loadError ? (
          <p role="alert" className="text-sm font-bold text-danger">Gagal memuat pengaturan: {loadError}. Mencoba lagi otomatis.</p>
        ) : (
          <p className="text-sm text-ink-700">Memuat pengaturan…</p>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Pengaturan" subtitle="Berlaku untuk semua outlet; tablet mengambilnya saat sinkron berikutnya." />

      <Tabs value={section} onChange={setSection} label="Bagian Pengaturan" tabs={sections.map((t) => ({ ...t, dirty: markers.tabs.has(t.id) }))} />

      {/* ── Outlet & Gudang ── */}
      {section === 'locations' && (
        <>
          <LocationsSection />
          <SettingsCard changed={changed.has('stock')} title="Pengaturan stok" className="p-6 max-w-4xl space-y-5">
            <SettingRow title="Izinkan stok minus" hint="Jika nonaktif, kasir diberi peringatan saat menjual melebihi stok (masih bisa dilanjutkan)." change={changeAt(changes, 'allowNegativeStock')}>
              <Switch label="Izinkan stok minus" checked={s.allowNegativeStock} onChange={() => setS((p) => ({ ...p, allowNegativeStock: !p.allowNegativeStock }))} />
            </SettingRow>
          </SettingsCard>
        </>
      )}

      {/* ── Transaksi: Pajak & Pembulatan · Metode Pembayaran · Struk ── */}
      {section === 'transaksi' && (
        <TransaksiSection s={s} setS={setS} newPay={newPay} setNewPay={setNewPay} changed={changed} changes={changes} />
      )}

      {/* ── Operasional: Shift · Persetujuan Transfer · Dokumen ── */}
      {section === 'operasional' && (
        <div className="max-w-4xl space-y-5">
          {/* Sub-section: Shift */}
          <SettingsCard changed={changed.has('shift')} title="Pengaturan shift" className="p-6 space-y-5">
            <SettingRow title="Buka shift otomatis" hint="Shift dibuka otomatis saat kasir login" change={changeAt(changes, 'autoOpenShift')}>
              <Switch label="Buka shift otomatis" checked={s.autoOpenShift} onChange={() => setS((p) => ({ ...p, autoOpenShift: !p.autoOpenShift }))} />
            </SettingRow>
          </SettingsCard>

          {/* Sub-section: Persetujuan Stok */}
          <SettingsCard changed={changed.has('approval')} title="Persetujuan stok" className="p-6 space-y-5">
            <SettingRow title="Wajib persetujuan stok" hint="Koreksi stok dan opname harus disetujui peran penyetuju (di bawah) dengan PIN, penyetuju bukan pengaju (four-eyes)." change={changeAt(changes, 'inventoryApprovalRequired')}>
              <Switch label="Wajib persetujuan stok" checked={s.inventoryApprovalRequired ?? false} onChange={() => setS((p) => ({ ...p, inventoryApprovalRequired: !p.inventoryApprovalRequired }))} />
            </SettingRow>
          </SettingsCard>

          {/* Sub-section: Persetujuan Transfer */}
          <SettingsCard changed={changed.has('transfer')} title="Persetujuan penerimaan transfer" className="p-6 space-y-5">
            <p className="text-xs text-ink-700">Admin selalu boleh; pilih peran lain yang boleh menyetujui penerimaan di POS.</p>
            <div className="border border-paper-2 rounded-xl overflow-hidden mt-2">
              {/* Admin row — always-on, non-interactive */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-paper-2 opacity-60">
                <div>
                  <p className="font-bold text-ink-900 text-sm capitalize">Admin</p>
                  <p className="text-xs text-ink-700">Admin selalu dapat menyetujui.</p>
                </div>
                <Switch label="Admin selalu dapat menyetujui" checked disabled size="sm" onChange={() => {}} />
              </div>
              {/* Manager & cashier — real interactive toggles */}
              {(['manager', 'cashier'] as const).map((role) => (
                <div key={role} className="flex items-center justify-between px-4 py-3 border-b border-paper-2 last:border-0">
                  <p className="font-bold text-ink-900 text-sm capitalize">{role}</p>
                  <Switch
                    label={`Jadikan ${role} sebagai approver`}
                    checked={approverRoles.includes(role)}
                    size="sm"
                    onChange={() => setS((p) => {
                      const cur = p.receiveApproverRoles ?? []
                      return { ...p, receiveApproverRoles: cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role] }
                    })}
                  />
                </div>
              ))}
            </div>
          </SettingsCard>

          {/* Sub-section: Dokumen */}
          <SettingsCard changed={changed.has('docs')} title="Dokumen pengiriman" className="p-6 space-y-5">
            <p className="text-xs text-ink-700">
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
            <p className="text-xs text-ink-700 -mt-3">Muncul di kepala surat jalan &amp; tanda terima.</p>

            {/* Logo upload */}
            <Field label="Logo">
              <div className="flex items-center gap-3">
                {s.documents?.logoUrl ? (
                  <div className="relative w-20 h-20 rounded-xl overflow-hidden border border-paper-2 bg-paper-1 flex-shrink-0">
                    <img
                      src={getThumbnailUrl(s.documents.logoUrl, 160, 160)}
                      alt="Logo"
                      className="w-full h-full object-contain"
                    />
                    <IconButton
                      label="Hapus logo"
                      onClick={() => setDoc('logoUrl', undefined)}
                      className="absolute right-0.5 top-0.5 bg-white/90 shadow-sm"
                    >
                      <X className="w-4 h-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                ) : (
                  <div className="w-20 h-20 rounded-xl border-2 border-dashed border-paper-2 bg-paper-1 flex items-center justify-center flex-shrink-0">
                    <Upload className="w-6 h-6 text-ink-500" />
                  </div>
                )}
                <div className="space-y-1">
                  <Button
                    onClick={() => logoFileRef.current?.click()}
                    loading={logoUploading}
                  >
                    {logoUploading ? 'Mengupload...' : 'Pilih Gambar'}
                  </Button>
                  <p className="text-xs text-ink-700">PNG/JPG, maks 5 MB. Disarankan ukuran persegi.</p>
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
            <p className="text-xs text-ink-700 -mt-3">Pisahkan setiap baris dengan Enter.</p>

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
        <SettingsCard changed={changed.has('recipe')} title="Resep &amp; bahan" className="p-6 max-w-4xl space-y-5">
          <p className="text-xs text-ink-700">
            Aktifkan modul Resep &amp; Bahan untuk melacak bahan baku per gudang dan formula per
            produk. Saat dinonaktifkan, tab Bahan tidak akan muncul di layar Gudang.
          </p>
          <SettingRow title="Aktifkan modul Resep &amp; Bahan" change={changeAt(changes, 'recipesEnabled')}>
            <Switch
              label="Aktifkan modul Resep & Bahan"
              checked={s.recipesEnabled ?? false}
              onChange={() => setS((p) => ({ ...p, recipesEnabled: !p.recipesEnabled }))}
            />
          </SettingRow>
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
                <div key={c.path} role="alert" className="flex items-center gap-3 text-sm bg-warn-bg rounded-xl px-3 py-2">
                  <p className="flex-1 font-bold text-warn-strong">{c.label} baru diubah orang lain (sekarang {c.theirs}). Punya Anda: {c.mine}.</p>
                  <Button size="sm" variant="secondary" onClick={() => resolve(c.path, 'mine')}>Pakai punya saya</Button>
                  <Button size="sm" variant="secondary" onClick={() => resolve(c.path, 'theirs')}>Pakai yang baru</Button>
                </div>
              ))}
            </div>
          )
        }
      />

      <ConfirmDialog
        open={leaveAsk !== null}
        title="Simpan perubahan Pengaturan?"
        consequence={`Ada ${changes.length} perubahan yang belum disimpan${leaveDetail}. Kalau ditinggalkan, perubahan ini hilang.`}
        confirmLabel="Simpan & lanjut"
        cancelLabel="Tetap di sini"
        extra={{ label: 'Buang perubahan', tone: 'danger', onClick: discardAndLeave }}
        busy={status.kind === 'saving'}
        onConfirm={() => saveAndLeave()}
        onCancel={() => answerLeave(false)}
      />
    </div>
  )
}
