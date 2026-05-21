import { useRef, useState } from 'react'
import type { Product, Category, Bundle, ProductVariant, ProductInput } from '@mandalika/api'
import {
  Plus, Edit2, Trash2, X, Upload, Package, Search, Loader2,
  ImageIcon, Download, Tag, ChevronDown,
} from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { uploadImage } from '../lib/uploadImage'
import { exportToCSV, exportToXLSX, parseCSV } from '../lib/csvUtils'
import { BRAND } from '../lib/brand'

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
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Produk</h2>
          <p className="text-sm text-gray-400">{products.length} produk · {categories.length} kategori · {bundles.length} bundle</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {(['products', 'categories', 'bundles'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                {t === 'products' ? 'Produk' : t === 'categories' ? 'Kategori' : 'Bundle'}
              </button>
            ))}
          </div>
          {tab === 'products' && (
            <>
              <div className="relative">
                <button onClick={() => setExportMenu((v) => !v)} className="flex items-center gap-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl text-xs">
                  <Download className="w-3.5 h-3.5" /> Export <ChevronDown className="w-3 h-3" />
                </button>
                {exportMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-32 overflow-hidden">
                    <button onClick={() => exportProducts('csv')} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700">CSV (.csv)</button>
                    <button onClick={() => exportProducts('xlsx')} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700">Excel (.xlsx)</button>
                  </div>
                )}
              </div>
              <button onClick={() => csvRef.current?.click()} className="flex items-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs">
                <Upload className="w-3.5 h-3.5" /> Import
              </button>
              <input ref={csvRef} type="file" accept=".csv" onChange={importProducts} className="hidden" />
              <button onClick={() => { setEditing(null); setForm({ ...EMPTY, variants: [{ ...EMPTY_VARIANT }] }); setErr(null); setOpen(true) }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
                <Plus className="w-4 h-4" /> Tambah
              </button>
            </>
          )}
          {tab === 'categories' && (
            <>
              <button onClick={() => exportToCSV(categories.map((c) => ({ Nama: c.name, Deskripsi: c.description || '', Urutan: c.sortOrder || 0 })), 'kategori_mandalika')} className="flex items-center gap-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl text-xs">
                <Download className="w-3.5 h-3.5" /> Export
              </button>
              <button onClick={() => catCsvRef.current?.click()} className="flex items-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs">
                <Upload className="w-3.5 h-3.5" /> Import
              </button>
              <input ref={catCsvRef} type="file" accept=".csv" onChange={importCats} className="hidden" />
              <button onClick={() => { setEditingCat(null); setCatForm({ name: '', description: '' }); setCatOpen(true) }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
                <Plus className="w-4 h-4" /> Tambah
              </button>
            </>
          )}
        </div>
      </div>

      {tab === 'products' && (
        <>
          <div className="flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Cari produk..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <select value={fCat} onChange={(e) => setFCat(e.target.value)} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none">
              <option value="">Semua Kategori</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {pq.loading ? (
              <TableSkeleton />
            ) : filtered.length === 0 ? (
              <div className="p-12 flex flex-col items-center gap-3 text-gray-300"><Package className="w-12 h-12" /><p className="font-bold">Tidak ada produk</p></div>
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
                        <td className="px-5 py-3"><span className="px-2.5 py-1 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-lg">{catName(p.categoryId)}</span></td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {p.variants.map((v) => (
                              <span key={v.size} className={`px-2 py-0.5 text-xs font-bold rounded-lg ${v.stock <= 5 ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}>{v.size}: {v.stock}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${p.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{p.isActive ? 'Aktif' : 'Nonaktif'}</span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => openEdit(p)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                            <button onClick={() => setDelId(p.id)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'categories' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {categories.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-gray-300"><Tag className="w-12 h-12" /><p>Belum ada kategori</p></div>
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
                    <td className="px-5 py-3 text-sm font-bold text-indigo-600">{products.filter((p) => p.categoryId === c.id).length}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setEditingCat(c); setCatForm({ name: c.name, description: c.description || '' }); setCatOpen(true) }} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                        <button onClick={() => setDelCatId(c.id)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'bundles' && (
        <div className="space-y-3">
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-xs text-yellow-700">
            Bundle dikelola read-only dari katalog. Editor bundle menyusul.
          </div>
          {bundles.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300"><Package className="w-12 h-12" /><p className="font-bold">Belum ada bundle</p></div>
          ) : bundles.map((b) => (
            <div key={b.id} className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-black text-gray-900">{b.name}</p>
                  <p className="text-sm text-indigo-600 font-bold">{BRAND.currency.format(b.price)}</p>
                  <p className="text-xs text-gray-400 mt-1">{b.items.length} item</p>
                </div>
                <span className={`px-2 py-1 text-xs font-bold rounded-lg ${b.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{b.isActive ? 'Aktif' : 'Nonaktif'}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {b.items.map((it, i) => (
                  <span key={i} className="px-2.5 py-1 bg-gray-100 text-gray-700 text-xs font-bold rounded-lg">{it.productName} {it.variantSize} ×{it.quantity}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editing ? 'Edit Produk' : 'Tambah Produk'}</h2>
              <button onClick={() => setOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-5">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Foto Produk</label>
                <div className="flex items-center gap-4">
                  <div className="w-20 h-20 rounded-2xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {form.imageUrl ? <img src={form.imageUrl} alt="" className="w-full h-full object-cover" /> : <ImageIcon className="w-8 h-8 text-gray-300" />}
                  </div>
                  <div className="flex-1 space-y-2">
                    <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex items-center gap-2 px-4 py-2 border-2 border-dashed border-gray-300 hover:border-indigo-400 text-gray-500 text-sm font-bold rounded-xl w-full justify-center">
                      {uploading ? <><Loader2 className="w-4 h-4 animate-spin" />Mengupload...</> : <><Upload className="w-4 h-4" />Upload Foto</>}
                    </button>
                    <input ref={fileRef} type="file" accept="image/*" onChange={onImage} className="hidden" />
                    <input type="text" placeholder="Atau tempel URL gambar..." value={form.imageUrl} onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {(['name', 'brand'] as const).map((k) => (
                  <div key={k}>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{k === 'name' ? 'Nama Produk *' : 'Brand *'}</label>
                    <input type="text" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Kategori *</label>
                <select value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Pilih kategori...</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Deskripsi</label>
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="flex gap-4">
                {(['isActive', 'isFeatured'] as const).map((k) => (
                  <label key={k} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                    <span className="text-sm font-bold text-gray-700">{k === 'isActive' ? 'Produk Aktif' : 'Produk Unggulan'}</span>
                  </label>
                ))}
              </div>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-xs font-black text-gray-400 uppercase tracking-widest">Varian *</label>
                  <button onClick={() => setForm((f) => ({ ...f, variants: [...f.variants, { ...EMPTY_VARIANT }] }))} className="flex items-center gap-1 text-xs font-bold text-indigo-600"><Plus className="w-3 h-3" />Tambah</button>
                </div>
                <div className="space-y-2">
                  {form.variants.map((v, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      {(['size', 'price', 'stock', 'sku'] as const).map((field, fi) => (
                        <input key={field} type={field === 'price' || field === 'stock' ? 'number' : 'text'} value={v[field]} onChange={(e) => updVariant(i, field, e.target.value)} placeholder={['30ml', '150000', '10', 'MND-01'][fi]} className="col-span-3 px-2.5 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                      ))}
                      <button onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))} disabled={form.variants.length === 1} className="col-span-1 flex justify-center text-gray-300 hover:text-red-500 disabled:opacity-0"><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
              </div>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={save} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : editing ? 'Simpan' : 'Tambah'}
              </button>
            </div>
          </div>
        </div>
      )}

      {catOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editingCat ? 'Edit Kategori' : 'Tambah Kategori'}</h2>
              <button onClick={() => setCatOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama *</label>
                <input type="text" value={catForm.name} onChange={(e) => setCatForm((f) => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Deskripsi</label>
                <textarea value={catForm.description} onChange={(e) => setCatForm((f) => ({ ...f, description: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none" />
              </div>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setCatOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveCat} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {(delId || delCatId) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Konfirmasi Hapus</h3>
            <p className="text-sm text-gray-400 mb-6">Data tidak dapat dikembalikan.</p>
            <div className="flex gap-3">
              <button onClick={() => { setDelId(null); setDelCatId(null) }} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={async () => { if (delId) await del(delId); if (delCatId) { await api.deleteCategory(delCatId); setDelCatId(null); await cq.refetch() } }} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
