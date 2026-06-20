import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Warehouse, WarehouseInput } from '@mandalika/api'
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
  open: boolean
  editing: Warehouse | null
  onClose: () => void
  onDone: () => void
}

export function WarehouseFormModal({ open, editing, onClose, onDone }: Props) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)

  // Reset the form whenever the modal opens (or the edited warehouse changes).
  useEffect(() => {
    if (!open) return
    setForm(
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
    setErr(null)
  }, [open, editing])

  const onLogoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoUploading(true)
    try {
      const url = await uploadImage(file, 'mandalika-pos/warehouses')
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
      setErr('Nama gudang wajib diisi')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body: WarehouseInput = {
        name: form.name.trim(),
        code: form.code.trim() || null,
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        isActive: form.isActive,
        logoUrl: form.logoUrl ?? null,
      }
      if (editing) {
        await api.updateWarehouse(editing.id, body)
      } else {
        await api.createWarehouse(body)
      }
      onClose()
      onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan gudang.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Gudang' : 'Tambah Gudang'}
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
          label="Nama Gudang *"
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <Input
          label="Kode"
          type="text"
          value={form.code}
          onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
          placeholder="mis. GDG-01"
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
          <p className="text-xs text-gray-500 mt-1">
            Juga muncul di surat jalan / tanda terima.
          </p>
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
              aria-label="Unggah logo gudang"
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
          <span className="text-sm font-bold text-gray-700">Gudang Aktif</span>
        </label>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
