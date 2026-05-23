import { useRef, useState } from 'react'
import type { Product, Category, Bundle, ProductVariant, ProductInput } from '@mandalika/api'
import {
  Plus, Edit2, Trash2, X, Upload, Package, Search,
  ImageIcon, Download, Tag, ChevronDown,
} from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { uploadImage } from '../lib/uploadImage'
import { exportToCSV, exportToXLSX, parseCSV } from '../lib/csvUtils'
import { BRAND } from '../lib/brand'
import {
  Button,
  Card,
  Badge,
  Modal,
  Field,
  Input,
  Select,
  Textarea,
  IconButton,
  EmptyState,
  PageHeader,
  Tabs,
  fieldClass,
} from '../ui'

const EMPTY_VARIANT: ProductVariant = { size: '', price: 0, stock: 0, sku: '' }
type Form = {
  name: string; brand: string; categoryId: string; description: string
  imageUrl: string; isActive: boolean; isFeatured: boolean; variants: ProductVariant[]
}
const EMPTY: Form = {
  name: '', brand: 'Mandalika', categoryId: '', description: '', imageUrl: '',
  isActive: true, isFeatured: false, variants: [{ ...EMPTY_VARIANT }],
}

export default function Products() {
  const pq = usePolledQuery<Product[]>(() => api.listProducts().then((r) => r.data), [])
  const cq = usePolledQuery<Category[]>(() => api.listCategories(), [])
  const bq = usePolledQuery<Bundle[]>(() => api.listBundles(), [])
  const products = pq.data ?? []
  const categories = cq.data ?? []
  const bundles = bq.data ?? []

  const [tab, setTab] = useState<'products' | 'categories' | 'bundles'>('products')
  const [search, setSearch] = useState('')
  const [fCat, setFCat] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [delId, setDelId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const csvRef = useRef<HTMLInputElement>(null)
  const catCsvRef = useRef<HTMLInputElement>(null)
  const [exportMenu, setExportMenu] = useState(false)

  const [catOpen, setCatOpen] = useState(false)
  const [editingCat, setEditingCat] = useState<Category | null>(null)
  const [catForm, setCatForm] = useState({ name: '', description: '' })
  const [delCatId, setDelCatId] = useState<string | null>(null)

  const filtered = products.filter((p) => {
    const m =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.brand.toLowerCase().includes(search.toLowerCase())
    return m && (!fCat || p.categoryId === fCat)
  })
  const catName = (cid: string) => categories.find((c) => c.id === cid)?.name || '—'

  const openEdit = (p: Product) => {
    setEditing(p)
    setForm({
      name: p.name, brand: p.brand, categoryId: p.categoryId,
      description: p.description || '', imageUrl: p.imageUrl || '',
      isActive: p.isActive, isFeatured: p.isFeatured,
      variants: p.variants.map((v) => ({ ...v })),
    })
    setErr(null)
    setOpen(true)
  }

  const onImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const url = await uploadImage(file)
      setForm((f) => ({ ...f, imageUrl: url }))
    } catch {
      setErr('Gagal upload gambar.')
    } finally {
      setUploading(false)
    }
  }

  const updVariant = (i: number, k: keyof ProductVariant, val: string) =>
    setForm((f) => {
      const v = [...f.variants]
      v[i] = { ...v[i], [k]: k === 'price' || k === 'stock' ? Number(val) : val }
      return { ...f, variants: v }
    })

  const save = async () => {
    if (!form.name.trim()) return setErr('Nama produk wajib diisi')
    if (!form.categoryId) return setErr('Pilih kategori')
    if (form.variants.some((v) => !v.size || v.price <= 0))
      return setErr('Semua varian harus punya ukuran dan harga')
    setBusy(true)
    setErr(null)
    try {
      const body: ProductInput = {
        name: form.name.trim(),
        brand: form.brand.trim(),
        categoryId: form.categoryId,
        description: form.description,
        imageUrl: form.imageUrl,
        isActive: form.isActive,
        isFeatured: form.isFeatured,
        variants: form.variants.map((v) => ({
          size: v.size.trim(), price: Number(v.price),
          stock: Number(v.stock), sku: v.sku.trim(),
        })),
      }
      if (editing) await api.updateProduct(editing.id, body)
      else await api.createProduct(body)
      setOpen(false)
      await pq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan.')
    } finally {
      setBusy(false)
    }
  }

  const del = async (pid: string) => {
    await api.deleteProduct(pid)
    setDelId(null)
    await pq.refetch()
  }

  const exportProducts = (fmt: 'csv' | 'xlsx') => {
    const rows = products.flatMap((p) =>
      p.variants.map((v) => ({
        Nama: p.name, Brand: p.brand, Kategori: catName(p.categoryId),
        Deskripsi: p.description || '', Ukuran: v.size, Harga: v.price,
        Stok: v.stock, SKU: v.sku, Aktif: p.isActive ? 'Ya' : 'Tidak',
        Unggulan: p.isFeatured ? 'Ya' : 'Tidak',
      })),
    )
    if (!rows.length) return
    if (fmt === 'xlsx') exportToXLSX(rows, 'produk_mandalika')
    else exportToCSV(rows, 'produk_mandalika')
    setExportMenu(false)
  }

  const importProducts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const rows = parseCSV(await file.text())
    const grouped: Record<string, { row: Record<string, string>; variants: ProductVariant[] }> = {}
    for (const row of rows) {
      const key = `${row['Nama']}|${row['Brand']}`
      if (!grouped[key]) grouped[key] = { row, variants: [] }
      grouped[key].variants.push({
        size: row['Ukuran'], price: parseFloat(row['Harga']) || 0,
        stock: parseInt(row['Stok']) || 0, sku: row['SKU'] || '',
      })
    }
    let n = 0
    for (const { row, variants } of Object.values(grouped)) {
      const cat = categories.find((c) => c.name.toLowerCase() === (row['Kategori'] || '').toLowerCase())
      await api.createProduct({
        name: row['Nama'], brand: row['Brand'] || 'Mandalika',
        categoryId: cat?.id || '', description: row['Deskripsi'] || '',
        imageUrl: '', isActive: row['Aktif'] !== 'Tidak',
        isFeatured: row['Unggulan'] === 'Ya', variants,
      })
      n++
    }
    e.target.value = ''
    await pq.refetch()
    setErr(`${n} produk diimport`)
  }

  const saveCat = async () => {
    if (!catForm.name.trim()) return setErr('Nama kategori wajib diisi')
    setBusy(true)
    try {
      if (editingCat) await api.updateCategory(editingCat.id, catForm)
      else await api.createCategory(catForm)
      setCatOpen(false)
      await cq.refetch()
    } finally {
      setBusy(false)
    }
  }
  const importCats = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    for (const row of parseCSV(await file.text())) {
      if (!row['Nama']?.trim()) continue
      await api.createCategory({ name: row['Nama'].trim(), description: row['Deskripsi'] || '' })
    }
    e.target.value = ''
    await cq.refetch()
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Produk"
        subtitle={`${products.length} produk · ${categories.length} kategori · ${bundles.length} bundle`}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'products', label: 'Produk' },
                { id: 'categories', label: 'Kategori' },
                { id: 'bundles', label: 'Bundle' },
              ]}
            />
            {tab === 'products' && (
              <>
                <div className="relative">
                  <Button variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => setExportMenu((v) => !v)}>
                    Export <ChevronDown className="w-3 h-3" />
                  </Button>
                  {exportMenu && (
                    <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-32 overflow-hidden">
                      <button onClick={() => exportProducts('csv')} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700">CSV (.csv)</button>
                      <button onClick={() => exportProducts('xlsx')} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700">Excel (.xlsx)</button>
                    </div>
                  )}
                </div>
                <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => csvRef.current?.click()}>
                  Import
                </Button>
                <input ref={csvRef} type="file" accept=".csv" onChange={importProducts} className="hidden" />
                <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => { setEditing(null); setForm({ ...EMPTY, variants: [{ ...EMPTY_VARIANT }] }); setErr(null); setOpen(true) }}>
                  Tambah
                </Button>
              </>
            )}
            {tab === 'categories' && (
              <>
                <Button variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => exportToCSV(categories.map((c) => ({ Nama: c.name, Deskripsi: c.description || '', Urutan: c.sortOrder || 0 })), 'kategori_mandalika')}>
                  Export
                </Button>
                <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => catCsvRef.current?.click()}>
                  Import
                </Button>
                <input ref={catCsvRef} type="file" accept=".csv" onChange={importCats} className="hidden" />
                <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => { setEditingCat(null); setCatForm({ name: '', description: '' }); setCatOpen(true) }}>
                  Tambah
                </Button>
              </>
            )}
          </>
        }
      />

      {tab === 'products' && (
        <>
          <div className="flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 z-10" />
              <input type="text" placeholder="Cari produk..." value={search} onChange={(e) => setSearch(e.target.value)} className={`${fieldClass} pl-9`} />
            </div>
            <select value={fCat} onChange={(e) => setFCat(e.target.value)} className={`${fieldClass} w-auto`}>
              <option value="">Semua Kategori</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <Card className="overflow-hidden">
            {pq.loading ? (
              <TableSkeleton />
            ) : filtered.length === 0 ? (
              <EmptyState icon={<Package />} title="Tidak ada produk" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {['Produk', 'Kategori', 'Varian & Stok', 'Status', 'Aksi'].map((h) => (
                        <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filtered.map((p) => (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                              {p.imageUrl ? <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" /> : <Package className="w-5 h-5 text-gray-300" />}
                            </div>
                            <div>
                              <p className="font-bold text-gray-900 text-sm">{p.name}</p>
                              <p className="text-xs text-gray-400">{p.brand}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3"><Badge tone="gold">{catName(p.categoryId)}</Badge></td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {p.variants.map((v) => (
                              <Badge key={v.size} tone={v.stock <= 5 ? 'danger' : 'neutral'}>{v.size}: {v.stock}</Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <IconButton onClick={() => openEdit(p)}><Edit2 className="w-4 h-4" /></IconButton>
                            <IconButton tone="danger" onClick={() => setDelId(p.id)}><Trash2 className="w-4 h-4" /></IconButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'categories' && (
        <Card className="overflow-hidden">
          {categories.length === 0 ? (
            <EmptyState icon={<Tag />} title="Belum ada kategori" />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Nama', 'Deskripsi', 'Jumlah Produk', 'Aksi'].map((h) => <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {categories.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-bold text-gray-900">{c.name}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{c.description || '—'}</td>
                    <td className="px-5 py-3 text-sm font-bold text-gold-600">{products.filter((p) => p.categoryId === c.id).length}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton onClick={() => { setEditingCat(c); setCatForm({ name: c.name, description: c.description || '' }); setCatOpen(true) }}><Edit2 className="w-4 h-4" /></IconButton>
                        <IconButton tone="danger" onClick={() => setDelCatId(c.id)}><Trash2 className="w-4 h-4" /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === 'bundles' && (
        <div className="space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
            Bundle dikelola read-only dari katalog. Editor bundle menyusul.
          </div>
          {bundles.length === 0 ? (
            <Card>
              <EmptyState icon={<Package />} title="Belum ada bundle" />
            </Card>
          ) : bundles.map((b) => (
            <Card key={b.id} className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-black text-gray-900">{b.name}</p>
                  <p className="text-sm text-gold-600 font-bold">{BRAND.currency.format(b.price)}</p>
                  <p className="text-xs text-gray-400 mt-1">{b.items.length} item</p>
                </div>
                <Badge tone={b.isActive ? 'success' : 'neutral'}>{b.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {b.items.map((it, i) => (
                  <Badge key={i} tone="neutral">{it.productName} {it.variantSize} ×{it.quantity}</Badge>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="xl"
        title={editing ? 'Edit Produk' : 'Tambah Produk'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Batal</Button>
            <Button variant="primary" className="flex-1" loading={busy} onClick={save}>
              {editing ? 'Simpan' : 'Tambah'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <Field label="Foto Produk">
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 rounded-2xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                {form.imageUrl ? <img src={form.imageUrl} alt="" className="w-full h-full object-cover" /> : <ImageIcon className="w-8 h-8 text-gray-300" />}
              </div>
              <div className="flex-1 space-y-2">
                <Button variant="secondary" className="w-full border-dashed border-2" loading={uploading} icon={<Upload className="w-4 h-4" />} onClick={() => fileRef.current?.click()}>
                  {uploading ? 'Mengupload...' : 'Upload Foto'}
                </Button>
                <input ref={fileRef} type="file" accept="image/*" onChange={onImage} className="hidden" />
                <input type="text" placeholder="Atau tempel URL gambar..." value={form.imageUrl} onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} className={fieldClass} />
              </div>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            {(['name', 'brand'] as const).map((k) => (
              <Input key={k} label={k === 'name' ? 'Nama Produk *' : 'Brand *'} type="text" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
            ))}
          </div>
          <Select label="Kategori *" value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}>
            <option value="">Pilih kategori...</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Textarea label="Deskripsi" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
          <div className="flex gap-4">
            {(['isActive', 'isFeatured'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
                <span className="text-sm font-bold text-gray-700">{k === 'isActive' ? 'Produk Aktif' : 'Produk Unggulan'}</span>
              </label>
            ))}
          </div>
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-black text-gray-400 uppercase tracking-widest">Varian *</label>
              <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} onClick={() => setForm((f) => ({ ...f, variants: [...f.variants, { ...EMPTY_VARIANT }] }))}>Tambah</Button>
            </div>
            <div className="space-y-2">
              {form.variants.map((v, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  {(['size', 'price', 'stock', 'sku'] as const).map((field, fi) => (
                    <input key={field} type={field === 'price' || field === 'stock' ? 'number' : 'text'} value={v[field]} onChange={(e) => updVariant(i, field, e.target.value)} placeholder={['30ml', '150000', '10', 'MND-01'][fi]} className={`${fieldClass} col-span-3`} />
                  ))}
                  <button onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))} disabled={form.variants.length === 1} className="col-span-1 flex justify-center text-gray-300 hover:text-red-500 disabled:opacity-0"><X className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>

      <Modal
        open={catOpen}
        onClose={() => setCatOpen(false)}
        size="sm"
        title={editingCat ? 'Edit Kategori' : 'Tambah Kategori'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setCatOpen(false)}>Batal</Button>
            <Button variant="primary" className="flex-1" loading={busy} onClick={saveCat}>Simpan</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Nama *" type="text" value={catForm.name} onChange={(e) => setCatForm((f) => ({ ...f, name: e.target.value }))} />
          <Textarea label="Deskripsi" value={catForm.description} onChange={(e) => setCatForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
        </div>
      </Modal>

      <Modal
        open={!!(delId || delCatId)}
        onClose={() => { setDelId(null); setDelCatId(null) }}
        size="sm"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => { setDelId(null); setDelCatId(null) }}>Batal</Button>
            <Button variant="danger" className="flex-1" onClick={async () => { if (delId) await del(delId); if (delCatId) { await api.deleteCategory(delCatId); setDelCatId(null); await cq.refetch() } }}>Ya, Hapus</Button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Konfirmasi Hapus</h3>
          <p className="text-sm text-gray-400">Data tidak dapat dikembalikan.</p>
        </div>
      </Modal>
    </div>
  )
}
