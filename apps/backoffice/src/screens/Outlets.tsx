import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Outlet } from '@mandalika/api'
import { Plus, Edit2, Store, MapPin, Phone, ToggleLeft, ToggleRight, Upload, X } from 'lucide-react'
import { api } from '../api'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { uploadImage, getThumbnailUrl } from '../lib/uploadImage'
import { TableSkeleton } from '../components/Skeleton'
import { Button, Input, Textarea, Modal, Card, Badge, IconButton, EmptyState, PageHeader, Field } from '../ui'

const EMPTY = { name: '', code: '', address: '', phone: '', isActive: true, logoUrl: undefined as string | undefined }

export default function Outlets() {
  const { refreshOutlets } = useOutlet()
  const q = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const outlets = q.data ?? []
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Outlet | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const openAdd = () => {
    setEditing(null)
    setForm(EMPTY)
    setErr(null)
    setOpen(true)
  }
  const openEdit = (o: Outlet) => {
    setEditing(o)
    setForm({ name: o.name, code: o.code || '', address: o.address || '', phone: o.phone || '', isActive: o.isActive, logoUrl: o.logoUrl ?? undefined })
    setErr(null)
    setOpen(true)
  }

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
      if (editing) await api.updateOutlet(editing.id, body)
      else await api.createOutlet(body)
      setOpen(false)
      await q.refetch()
      refreshOutlets() // update the global outlet switcher immediately
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan outlet.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (o: Outlet) => {
    await api.updateOutlet(o.id, {
      name: o.name,
      code: o.code || '',
      address: o.address || '',
      phone: o.phone || '',
      logoUrl: o.logoUrl ?? null,
      isActive: !o.isActive,
    })
    await q.refetch()
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Outlet"
        subtitle={`${outlets.length} outlet terdaftar`}
        actions={
          <Button onClick={openAdd} icon={<Plus className="w-4 h-4" />}>
            Tambah Outlet
          </Button>
        }
      />

      {q.loading ? (
        <TableSkeleton />
      ) : outlets.length === 0 ? (
        <EmptyState icon={<Store />} title="Belum ada outlet" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {outlets.map((o) => (
            <Card key={o.id} className={`p-5 ${o.isActive ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 bg-gold-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Store className="w-5 h-5 text-gold-600" />
                </div>
                <IconButton onClick={() => openEdit(o)} aria-label="Edit outlet">
                  <Edit2 className="w-3.5 h-3.5" />
                </IconButton>
              </div>
              <h3 className="font-black text-gray-900 mb-2">{o.name}</h3>
              <div className="space-y-1.5">
                {o.address && (
                  <div className="flex items-start gap-2 text-xs text-gray-500">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>{o.address}</span>
                  </div>
                )}
                {o.phone && (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{o.phone}</span>
                  </div>
                )}
              </div>
              <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
                <Badge tone={o.isActive ? 'success' : 'neutral'}>
                  {o.isActive ? 'Aktif' : 'Nonaktif'}
                </Badge>
                <button onClick={() => toggle(o)} className="text-gray-400 hover:text-gold-600">
                  {o.isActive ? <ToggleRight className="w-6 h-6 text-gold-600" /> : <ToggleLeft className="w-6 h-6" />}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit Outlet' : 'Tambah Outlet'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
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
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))}
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
            <p className="text-xs text-gray-500 mt-1">Juga digunakan sebagai alamat surat jalan / tanda terima.</p>
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
                  <img src={getThumbnailUrl(form.logoUrl, 64)} alt="" className="w-16 h-16 rounded border object-contain" />
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
              <input ref={logoFileRef} type="file" accept="image/*" className="hidden" onChange={onLogoFile} />
              <Button variant="secondary" loading={logoUploading} onClick={() => logoFileRef.current?.click()}>
                {form.logoUrl ? 'Ganti' : 'Unggah'}
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-1">Kosongkan untuk pakai logo merek dari halaman Pengaturan.</p>
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
    </div>
  )
}
