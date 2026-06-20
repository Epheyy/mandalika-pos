import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Outlet } from '@mandalika/api'
import { Upload, X } from 'lucide-react'
import { api } from '../../api'
import { uploadImage, getThumbnailUrl } from '../../lib/uploadImage'
import { Button } from '../../ui/Button'
import { Input, Textarea, Field } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

const EMPTY_FORM = {
  name: '',
  code: '',
  address: '',
  phone: '',
  isActive: true,
  logoUrl: undefined as string | undefined,
}

interface Props {
  editing: Outlet | null
  onClose: () => void
  onDone: () => void
}

// Mounted only while open and keyed by the edited outlet at the call site, so
// the form seeds fresh on every open without an adjust-state-on-prop effect.
export function OutletFormModal({ editing, onClose, onDone }: Props) {
  const [form, setForm] = useState(() =>
    editing
      ? {
          name: editing.name,
          code: editing.code || '',
          address: editing.address || '',
          phone: editing.phone || '',
          isActive: editing.isActive,
          logoUrl: editing.logoUrl ?? undefined,
        }
      : EMPTY_FORM,
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)

  const onLogoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoUploading(true)
    try {
      const url = await uploadImage(file, 'mandalika-pos/outlets')
      setForm((f) => ({ ...f, logoUrl: url }))
    } catch {
      setErr('Gagal upload logo.')
    } finally {
      setLogoUploading(false)
      e.target.value = ''
    }
  }

  const save = async () => {
    if (!form.name.trim()) {
      setErr('Nama outlet wajib diisi')
      return
    }
    const code = form.code.trim().toUpperCase()
    if (!/^[A-Z0-9]{2,4}$/.test(code)) {
      setErr('Kode wajib 2–4 huruf/angka (mis. JKT) — dipakai sebagai prefix no. order')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body = {
        name: form.name.trim(),
        code,
        address: form.address.trim(),
        phone: form.phone.trim(),
        isActive: form.isActive,
        logoUrl: form.logoUrl ?? null,
      }
      if (editing) {
        await api.updateOutlet(editing.id, body)
      } else {
        await api.createOutlet(body)
      }
      onClose()
      onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan outlet.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit Outlet' : 'Tambah Outlet'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={save} loading={busy}>
            {busy ? 'Menyimpan...' : editing ? 'Simpan' : 'Tambah'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Nama Outlet *"
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <Input
          label="Kode *"
          type="text"
          value={form.code}
          maxLength={4}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''),
            }))
          }
          placeholder="mis. JKT"
          className="uppercase tracking-widest"
          hint={
            <>
              2–4 huruf/angka, unik. Prefix nomor order:{' '}
              <span className="font-mono">{(form.code || 'JKT')}-A0042</span>
            </>
          }
        />
        <div>
          <Textarea
            label="Alamat"
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            rows={2}
          />
          <p className="text-xs text-gray-500 mt-1">
            Juga digunakan sebagai alamat surat jalan / tanda terima.
          </p>
        </div>
        <div>
          <Input
            label="No. Telepon"
            type="tel"
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
          <p className="text-xs text-gray-500 mt-1">Juga muncul di surat jalan / tanda terima.</p>
        </div>
        <Field label="Logo (opsional, ditampilkan di surat jalan / tanda terima)">
          <div className="flex items-center gap-3">
            {form.logoUrl ? (
              <div className="relative">
                <img
                  src={getThumbnailUrl(form.logoUrl, 64)}
                  alt=""
                  className="w-16 h-16 rounded border object-contain"
                />
                <button
                  type="button"
                  aria-label="Hapus logo"
                  onClick={() => setForm((f) => ({ ...f, logoUrl: undefined }))}
                  className="absolute -top-1 -right-1 bg-white border rounded-full p-0.5 shadow"
                >
                  <X className="w-3 h-3 text-gray-500" />
                </button>
              </div>
            ) : (
              <div className="w-16 h-16 rounded border border-dashed grid place-items-center text-xs text-gray-400">
                <Upload className="w-5 h-5 text-gray-300" />
              </div>
            )}
            <input
              ref={logoFileRef}
              type="file"
              accept="image/*"
              aria-label="Unggah logo outlet"
              className="hidden"
              onChange={onLogoFile}
            />
            <Button
              variant="secondary"
              loading={logoUploading}
              onClick={() => logoFileRef.current?.click()}
            >
              {form.logoUrl ? 'Ganti' : 'Unggah'}
            </Button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Kosongkan untuk pakai logo merek dari halaman Pengaturan.
          </p>
        </Field>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            className="w-4 h-4 accent-gold-600"
          />
          <span className="text-sm font-bold text-gray-700">Outlet Aktif</span>
        </label>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
