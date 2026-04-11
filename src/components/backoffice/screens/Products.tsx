import { useState, useEffect, useRef } from 'react'
import type { AppUser, Product, Category, ProductVariant, Bundle, BundleItem } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore'
import { BRAND } from '../../../config/brand'
import { uploadImage } from '../../../lib/cloudinary'
import { exportToCSV, exportToXLSX, parseCSV } from '../../../lib/csvUtils'
import { Plus, Edit2, Trash2, X, Upload, Package, Search, Loader2, ImageIcon, Download, Tag, ChevronDown } from 'lucide-react'

interface Props { appUser?: AppUser }

const EMPTY_VARIANT: ProductVariant = { size: '', price: 0, stock: 0, sku: '' }
const EMPTY_PRODUCT = { name: '', brand: 'Mandalika', categoryId: '', description: '', imageUrl: '', isActive: true, isFeatured: false, variants: [{ ...EMPTY_VARIANT }] }

export default function Products({ appUser: _appUser }: Props) {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [activeTab, setActiveTab] = useState<'products' | 'categories' | 'bundles'>('products')
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterCategoryId, setFilterCategoryId] = useState('')

  // Product modal
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [formData, setFormData] = useState(EMPTY_PRODUCT)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const csvImportRef = useRef<HTMLInputElement>(null)
  const catCsvImportRef = useRef<HTMLInputElement>(null)
  const [showExportMenu, setShowExportMenu] = useState(false)

  // Category modal
  const [isCatModalOpen, setIsCatModalOpen] = useState(false)
  const [editingCat, setEditingCat] = useState<Category | null>(null)
  const [catForm, setCatForm] = useState({ name: '', description: '' })
  const [deleteCatId, setDeleteCatId] = useState<string | null>(null)

  // Bundle modal
  const [isBundleModalOpen, setIsBundleModalOpen] = useState(false)
  const [editingBundle, setEditingBundle] = useState<Bundle | null>(null)
  const [bundleForm, setBundleForm] = useState({ name: '', description: '', price: 0, imageUrl: '', isActive: true, items: [] as BundleItem[] })

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'products'), s => { setProducts(s.docs.map(d => ({ id: d.id, ...d.data() } as Product))); setIsLoading(false) })
    const u2 = onSnapshot(collection(db, 'categories'), s => setCategories(s.docs.map(d => ({ id: d.id, ...d.data() } as Category))))
    const u3 = onSnapshot(collection(db, 'bundles'), s => setBundles(s.docs.map(d => ({ id: d.id, ...d.data() } as Bundle))))
    return () => { u1(); u2(); u3() }
  }, [])

  const filtered = products.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.brand.toLowerCase().includes(searchQuery.toLowerCase())
    const matchCat = !filterCategoryId || p.categoryId === filterCategoryId
    return matchSearch && matchCat
  })

  // Product CRUD
  const openAdd = () => { setEditingProduct(null); setFormData({ ...EMPTY_PRODUCT, variants: [{ ...EMPTY_VARIANT }] }); setIsModalOpen(true) }
  const openEdit = (p: Product) => {
    setEditingProduct(p)
    setFormData({ name: p.name, brand: p.brand, categoryId: p.categoryId, description: p.description || '', imageUrl: p.imageUrl || '', isActive: p.isActive, isFeatured: p.isFeatured || false, variants: p.variants.map(v => ({ ...v })) })
    setIsModalOpen(true)
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    setIsUploadingImage(true)
    try { const r = await uploadImage(file); setFormData(f => ({ ...f, imageUrl: r.url })) }
    catch { alert('Gagal upload gambar.') }
    finally { setIsUploadingImage(false) }
  }

  const addVariant = () => setFormData(f => ({ ...f, variants: [...f.variants, { ...EMPTY_VARIANT }] }))
  const removeVariant = (i: number) => setFormData(f => ({ ...f, variants: f.variants.filter((_, idx) => idx !== i) }))
  const updateVariant = (i: number, field: keyof ProductVariant, val: string | number) => setFormData(f => { const v = [...f.variants]; v[i] = { ...v[i], [field]: val }; return { ...f, variants: v } })

  const handleSave = async () => {
    if (!formData.name.trim()) { alert('Nama produk wajib diisi'); return }
    if (!formData.categoryId) { alert('Pilih kategori'); return }
    if (formData.variants.some(v => !v.size || v.price <= 0)) { alert('Semua varian harus punya ukuran dan harga'); return }
    setIsSubmitting(true)
    try {
      const data: Omit<Product, 'id'> = { ...formData, name: formData.name.trim(), brand: formData.brand.trim(), variants: formData.variants.map(v => ({ ...v, size: v.size.trim(), price: Number(v.price), stock: Number(v.stock), sku: v.sku.trim() })), createdAt: editingProduct?.createdAt || new Date().toISOString() }
      if (editingProduct?.id) await updateDoc(doc(db, 'products', editingProduct.id), data)
      else await addDoc(collection(db, 'products'), data)
      setIsModalOpen(false)
    } catch { alert('Gagal menyimpan.') }
    finally { setIsSubmitting(false) }
  }

  const handleDelete = async (id: string) => { await deleteDoc(doc(db, 'products', id)); setDeleteConfirmId(null) }

  // CSV/XLSX Export Products
  const getProductRows = () => products.flatMap(p => p.variants.map(v => ({
    'Nama': p.name, 'Brand': p.brand, 'Kategori': categories.find(c => c.id === p.categoryId)?.name || '',
    'Deskripsi': p.description || '', 'Ukuran': v.size,
    'Harga': v.price, 'Stok': v.stock, 'SKU': v.sku, 'Aktif': p.isActive ? 'Ya' : 'Tidak', 'Unggulan': p.isFeatured ? 'Ya' : 'Tidak',
  })))

  const exportProducts = (format: 'csv' | 'xlsx') => {
    const rows = getProductRows()
    if (!rows.length) { alert('Tidak ada produk untuk diekspor'); return }
    if (format === 'xlsx') exportToXLSX(rows, 'produk_mandalika')
    else exportToCSV(rows, 'produk_mandalika')
    setShowExportMenu(false)
  }

  const downloadTemplate = () => {
    const rows = [{ 'Nama': '', 'Brand': 'Mandalika', 'Kategori': '', 'Deskripsi': '', 'Ukuran': '', 'Harga': 0, 'Stok': 0, 'SKU': '', 'Aktif': 'Ya', 'Unggulan': 'Tidak' }]
    exportToCSV(rows, 'template_import_produk')
  }

  // CSV Import Products
  const importProducts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const text = await file.text()
    const rows = parseCSV(text)
    if (!rows.length) { alert('File CSV kosong atau format salah'); return }

    const grouped = rows.reduce((acc, row) => {
      const key = `${row['Nama']}|${row['Brand']}`
      if (!acc[key]) acc[key] = { ...row, variants: [] }
      acc[key].variants.push({ size: row['Ukuran'], price: parseFloat(row['Harga']) || 0, stock: parseInt(row['Stok']) || 0, sku: row['SKU'] })
      return acc
    }, {} as Record<string, any>)

    let count = 0
    for (const item of Object.values(grouped)) {
      const catName = item['Kategori']
      const cat = categories.find(c => c.name.toLowerCase() === catName.toLowerCase())
      const data: Omit<Product, 'id'> = {
        name: item['Nama'], brand: item['Brand'], categoryId: cat?.id || '',
        description: item['Deskripsi'] || '', imageUrl: '',
        isActive: item['Aktif'] !== 'Tidak', isFeatured: item['Unggulan'] === 'Ya',
        variants: item.variants, createdAt: new Date().toISOString(),
      }
      await addDoc(collection(db, 'products'), data)
      count++
    }
    alert(`${count} produk berhasil diimport!`)
    e.target.value = ''
  }

  // CSV Export Categories
  const exportCategories = () => exportToCSV(categories.map(c => ({ 'Nama': c.name, 'Deskripsi': c.description || '', 'Urutan': c.sortOrder || 0 })), 'kategori_mandalika')

  // CSV Import Categories
  const importCategories = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const rows = parseCSV(await file.text())
    let count = 0
    for (const row of rows) {
      if (!row['Nama']?.trim()) continue
      await addDoc(collection(db, 'categories'), { name: row['Nama'].trim(), description: row['Deskripsi'] || '', sortOrder: parseInt(row['Urutan']) || 0 })
      count++
    }
    alert(`${count} kategori berhasil diimport!`)
    e.target.value = ''
  }

  // Category CRUD
  const saveCat = async () => {
    if (!catForm.name.trim()) { alert('Nama kategori wajib diisi'); return }
    setIsSubmitting(true)
    try {
      if (editingCat?.id) await updateDoc(doc(db, 'categories', editingCat.id), catForm)
      else await addDoc(collection(db, 'categories'), catForm)
      setIsCatModalOpen(false)
    } catch { alert('Gagal menyimpan.') }
    finally { setIsSubmitting(false) }
  }

  // Bundle CRUD
  const addBundleItem = (p: Product, variantIdx: number) => {
    const v = p.variants[variantIdx]
    if (bundleForm.items.find(i => i.productId === p.id && i.variantSize === v.size)) { alert('Item sudah ditambahkan'); return }
    setBundleForm(f => ({ ...f, items: [...f.items, { productId: p.id!, productName: p.name, variantSize: v.size, quantity: 1, price: v.price }] }))
  }

  const saveBundle = async () => {
    if (!bundleForm.name.trim()) { alert('Nama bundle wajib diisi'); return }
    if (!bundleForm.items.length) { alert('Tambahkan minimal 1 item'); return }
    if (!bundleForm.price) { alert('Harga bundle wajib diisi'); return }
    setIsSubmitting(true)
    try {
      const data = { ...bundleForm, createdAt: editingBundle?.createdAt || new Date().toISOString() }
      if (editingBundle?.id) await updateDoc(doc(db, 'bundles', editingBundle.id), data)
      else await addDoc(collection(db, 'bundles'), data)
      setIsBundleModalOpen(false)
    } catch { alert('Gagal menyimpan.') }
    finally { setIsSubmitting(false) }
  }

  const getCategoryName = (id: string) => categories.find(c => c.id === id)?.name || '—'

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Produk</h2>
          <p className="text-sm text-gray-400">{products.length} produk · {categories.length} kategori · {bundles.length} bundle</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {(['products', 'categories', 'bundles'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                {tab === 'products' ? 'Produk' : tab === 'categories' ? 'Kategori' : 'Bundle'}
              </button>
            ))}
          </div>
          {activeTab === 'products' && (
            <>
              <div className="relative">
                <button onClick={() => setShowExportMenu(v => !v)} className="flex items-center gap-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl text-xs transition-all">
                  <Download className="w-3.5 h-3.5" /> Export <ChevronDown className="w-3 h-3" />
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-32 overflow-hidden">
                    <button onClick={() => exportProducts('csv')} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700">CSV (.csv)</button>
                    <button onClick={() => exportProducts('xlsx')} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700">Excel (.xlsx)</button>
                  </div>
                )}
              </div>
              <button onClick={() => csvImportRef.current?.click()} className="flex items-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs transition-all">
                <Upload className="w-3.5 h-3.5" /> Import
              </button>
              <input ref={csvImportRef} type="file" accept=".csv" onChange={importProducts} className="hidden" />
              <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-indigo-100">
                <Plus className="w-4 h-4" /> Tambah
              </button>
            </>
          )}
          {activeTab === 'categories' && (
            <>
              <button onClick={exportCategories} className="flex items-center gap-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl text-xs">
                <Download className="w-3.5 h-3.5" /> Export
              </button>
              <button onClick={() => catCsvImportRef.current?.click()} className="flex items-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs">
                <Upload className="w-3.5 h-3.5" /> Import
              </button>
              <input ref={catCsvImportRef} type="file" accept=".csv" onChange={importCategories} className="hidden" />
              <button onClick={() => { setEditingCat(null); setCatForm({ name: '', description: '' }); setIsCatModalOpen(true) }}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-indigo-100">
                <Plus className="w-4 h-4" /> Tambah
              </button>
            </>
          )}
          {activeTab === 'bundles' && (
            <button onClick={() => { setEditingBundle(null); setBundleForm({ name: '', description: '', price: 0, imageUrl: '', isActive: true, items: [] }); setIsBundleModalOpen(true) }}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-indigo-100">
              <Plus className="w-4 h-4" /> Tambah Bundle
            </button>
          )}
        </div>
      </div>

      {/* PRODUCTS TAB */}
      {activeTab === 'products' && (
        <>
          <div className="flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Cari produk..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <select value={filterCategoryId} onChange={e => setFilterCategoryId(e.target.value)}
              className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none">
              <option value="">Semua Kategori</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-xs text-yellow-700 flex items-start justify-between gap-3">
            <div>
              <p className="font-bold mb-0.5">Format CSV Import:</p>
              <p>Kolom: Nama, Brand, Kategori, Deskripsi, Ukuran, Harga, Stok, SKU, Aktif, Unggulan</p>
              <p>Satu baris per varian. Produk dengan nama+brand sama akan digabung. Gambar diupload manual per produk.</p>
            </div>
            <button onClick={downloadTemplate} className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 text-white font-bold rounded-lg text-xs transition-all">
              <Download className="w-3 h-3" /> Template
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {isLoading ? <div className="p-8 text-center text-gray-300">Memuat...</div>
              : filtered.length === 0 ? (
                <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
                  <Package className="w-12 h-12" /><p className="font-bold">Tidak ada produk</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        {['Produk', 'Kategori', 'Varian & Stok', 'Status', 'Aksi'].map(h => (
                          <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {filtered.map(product => (
                        <tr key={product.id} className="hover:bg-gray-50 transition-all">
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0">
                                {product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
                                  : <div className="w-full h-full flex items-center justify-center"><Package className="w-5 h-5 text-gray-300" /></div>}
                              </div>
                              <div>
                                <p className="font-bold text-gray-900 text-sm">{product.name}</p>
                                <p className="text-xs text-gray-400">{product.brand}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3">
                            <span className="px-2.5 py-1 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-lg">{getCategoryName(product.categoryId)}</span>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex flex-wrap gap-1">
                              {product.variants.map(v => (
                                <span key={v.size} className={`px-2 py-0.5 text-xs font-bold rounded-lg ${v.stock <= 5 ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}>
                                  {v.size}: {v.stock}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-5 py-3">
                            <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${product.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                              {product.isActive ? 'Aktif' : 'Nonaktif'}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => openEdit(product)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                              <button onClick={() => setDeleteConfirmId(product.id!)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
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

      {/* CATEGORIES TAB */}
      {activeTab === 'categories' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {categories.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-gray-300"><Tag className="w-12 h-12" /><p>Belum ada kategori</p></div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Nama', 'Deskripsi', 'Jumlah Produk', 'Aksi'].map(h => (
                    <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {categories.map(cat => (
                  <tr key={cat.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-bold text-gray-900">{cat.name}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{cat.description || '—'}</td>
                    <td className="px-5 py-3 text-sm font-bold text-indigo-600">{products.filter(p => p.categoryId === cat.id).length}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setEditingCat(cat); setCatForm({ name: cat.name, description: cat.description || '' }); setIsCatModalOpen(true) }}
                          className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                        <button onClick={() => setDeleteCatId(cat.id!)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* BUNDLES TAB */}
      {activeTab === 'bundles' && (
        <div className="space-y-3">
          {bundles.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300">
              <Package className="w-12 h-12" />
              <p className="font-bold">Belum ada bundle</p>
              <p className="text-sm text-center">Bundle memungkinkan kamu mengelompokkan beberapa produk dengan harga khusus</p>
            </div>
          ) : bundles.map(bundle => (
            <div key={bundle.id} className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-black text-gray-900">{bundle.name}</p>
                  <p className="text-sm text-indigo-600 font-bold">{BRAND.currency.format(bundle.price)}</p>
                  <p className="text-xs text-gray-400 mt-1">{bundle.items.length} item</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 text-xs font-bold rounded-lg ${bundle.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {bundle.isActive ? 'Aktif' : 'Nonaktif'}
                  </span>
                  <button onClick={() => { setEditingBundle(bundle); setBundleForm({ name: bundle.name, description: bundle.description || '', price: bundle.price, imageUrl: bundle.imageUrl || '', isActive: bundle.isActive, items: [...bundle.items] }); setIsBundleModalOpen(true) }}
                    className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                  <button onClick={async () => { if (bundle.id && confirm('Hapus bundle?')) await deleteDoc(doc(db, 'bundles', bundle.id)) }}
                    className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {bundle.items.map((item, i) => (
                  <span key={i} className="px-2.5 py-1 bg-gray-100 text-gray-700 text-xs font-bold rounded-lg">
                    {item.productName} {item.variantSize} ×{item.quantity}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PRODUCT MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingProduct ? 'Edit Produk' : 'Tambah Produk'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-5">
              {/* Image */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Foto Produk</label>
                <div className="flex items-center gap-4">
                  <div className="w-20 h-20 rounded-2xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {formData.imageUrl ? <img src={formData.imageUrl} alt="preview" className="w-full h-full object-cover" /> : <ImageIcon className="w-8 h-8 text-gray-300" />}
                  </div>
                  <div className="flex-1 space-y-2">
                    <button onClick={() => fileInputRef.current?.click()} disabled={isUploadingImage}
                      className="flex items-center gap-2 px-4 py-2 border-2 border-dashed border-gray-300 hover:border-indigo-400 hover:bg-indigo-50 text-gray-500 hover:text-indigo-600 text-sm font-bold rounded-xl transition-all w-full justify-center">
                      {isUploadingImage ? <><Loader2 className="w-4 h-4 animate-spin" />Mengupload...</> : <><Upload className="w-4 h-4" />Upload Foto</>}
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                    <input type="text" placeholder="Atau tempel URL gambar..." value={formData.imageUrl} onChange={e => setFormData(f => ({ ...f, imageUrl: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {[{ key: 'name', label: 'Nama Produk *', placeholder: 'Contoh: Rose Elégante' }, { key: 'brand', label: 'Brand *', placeholder: 'Mandalika' }].map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{label}</label>
                    <input type="text" value={formData[key as 'name' | 'brand']} onChange={e => setFormData(f => ({ ...f, [key]: e.target.value }))} placeholder={placeholder}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Kategori *</label>
                <select value={formData.categoryId} onChange={e => setFormData(f => ({ ...f, categoryId: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Pilih kategori...</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Deskripsi</label>
                <textarea value={formData.description} onChange={e => setFormData(f => ({ ...f, description: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="flex gap-4">
                {[{ key: 'isActive', label: 'Produk Aktif' }, { key: 'isFeatured', label: 'Produk Unggulan' }].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={formData[key as 'isActive' | 'isFeatured']} onChange={e => setFormData(f => ({ ...f, [key]: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                    <span className="text-sm font-bold text-gray-700">{label}</span>
                  </label>
                ))}
              </div>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-xs font-black text-gray-400 uppercase tracking-widest">Varian *</label>
                  <button onClick={addVariant} className="flex items-center gap-1 text-xs font-bold text-indigo-600"><Plus className="w-3 h-3" />Tambah</button>
                </div>
                <div className="grid grid-cols-12 gap-2 px-1 mb-1">
                  {['Ukuran', 'Harga (Rp)', 'Stok', 'SKU', ''].map(h => <span key={h} className="col-span-3 text-xs font-black text-gray-300 uppercase last:col-span-1">{h}</span>)}
                </div>
                <div className="space-y-2">
                  {formData.variants.map((variant, index) => (
                    <div key={index} className="grid grid-cols-12 gap-2 items-center">
                      {(['size', 'price', 'stock', 'sku'] as (keyof ProductVariant)[]).map((field, fi) => (
                        <input key={field} type={['price', 'stock'].includes(field) ? 'number' : 'text'} value={variant[field]}
                          onChange={e => updateVariant(index, field, e.target.value)}
                          placeholder={['30ml', '150000', '10', 'MND-01'][fi]}
                          className="col-span-3 px-2.5 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                      ))}
                      <button onClick={() => removeVariant(index)} disabled={formData.variants.length === 1} className="col-span-1 flex justify-center text-gray-300 hover:text-red-500 disabled:opacity-0"><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setIsModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={handleSave} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : editingProduct ? 'Simpan' : 'Tambah'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CATEGORY MODAL */}
      {isCatModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editingCat ? 'Edit Kategori' : 'Tambah Kategori'}</h2>
              <button onClick={() => setIsCatModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama *</label>
                <input type="text" value={catForm.name} onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))} placeholder="Contoh: Floral"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Deskripsi</label>
                <textarea value={catForm.description} onChange={e => setCatForm(f => ({ ...f, description: e.target.value }))} rows={2}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none" />
              </div>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setIsCatModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveCat} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" /></> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BUNDLE MODAL */}
      {isBundleModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingBundle ? 'Edit Bundle' : 'Buat Bundle'}</h2>
              <button onClick={() => setIsBundleModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Bundle *</label>
                  <input type="text" value={bundleForm.name} onChange={e => setBundleForm(f => ({ ...f, name: e.target.value }))} placeholder="Contoh: Starter Pack"
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Harga Bundle (Rp) *</label>
                  <input type="number" value={bundleForm.price || ''} onChange={e => setBundleForm(f => ({ ...f, price: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Deskripsi</label>
                <input type="text" value={bundleForm.description || ''} onChange={e => setBundleForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
              </div>

              {/* Added items */}
              {bundleForm.items.length > 0 && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Item Bundle ({bundleForm.items.length})</label>
                  <div className="space-y-2">
                    {bundleForm.items.map((item, i) => (
                      <div key={i} className="flex items-center justify-between bg-indigo-50 rounded-xl px-3 py-2">
                        <span className="text-sm font-bold text-indigo-900">{item.productName} — {item.variantSize}</span>
                        <div className="flex items-center gap-2">
                          <input type="number" value={item.quantity} min={1}
                            onChange={e => setBundleForm(f => { const items = [...f.items]; items[i] = { ...items[i], quantity: parseInt(e.target.value) || 1 }; return { ...f, items } })}
                            className="w-14 text-center px-2 py-1 bg-white border border-indigo-200 rounded-lg text-sm" />
                          <button onClick={() => setBundleForm(f => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }))}
                            className="text-indigo-300 hover:text-red-500"><X className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Product picker */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tambah Item dari Produk</label>
                <div className="border border-gray-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                  {products.map(p => (
                    <div key={p.id} className="border-b border-gray-50 last:border-0">
                      <p className="px-3 py-1.5 text-xs font-black text-gray-500 bg-gray-50">{p.name}</p>
                      <div className="flex flex-wrap gap-1 px-3 py-1.5">
                        {p.variants.map((v, vi) => (
                          <button key={v.size} onClick={() => addBundleItem(p, vi)}
                            className="px-2.5 py-1 bg-white border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 text-gray-600 hover:text-indigo-700 text-xs font-bold rounded-lg transition-all">
                            {v.size} — {BRAND.currency.format(v.price)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {bundleForm.items.length > 0 && (
                <div className="bg-indigo-50 rounded-xl p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-indigo-700">Harga normal</span>
                    <span className="font-bold text-indigo-700">{BRAND.currency.format(bundleForm.items.reduce((s, i) => s + i.price * i.quantity, 0))}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-green-700 font-bold">Harga bundle</span>
                    <span className="font-black text-green-700">{BRAND.currency.format(bundleForm.price)}</span>
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={bundleForm.isActive} onChange={e => setBundleForm(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Bundle Aktif</span>
              </label>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setIsBundleModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveBundle} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" /></> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirms */}
      {(deleteConfirmId || deleteCatId) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Konfirmasi Hapus</h3>
            <p className="text-sm text-gray-400 mb-6">Data tidak dapat dikembalikan.</p>
            <div className="flex gap-3">
              <button onClick={() => { setDeleteConfirmId(null); setDeleteCatId(null) }} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={async () => {
                if (deleteConfirmId) { await handleDelete(deleteConfirmId) }
                if (deleteCatId) { await deleteDoc(doc(db, 'categories', deleteCatId)); setDeleteCatId(null) }
              }} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}