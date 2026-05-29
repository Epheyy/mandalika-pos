import { useEffect, useRef, useState } from 'react'
import type { Product, Category, Bundle, ProductVariant, ProductInput } from '@mandalika/api'
import {
  Plus, Edit2, Trash2, X, Upload, Package, Search,
  Download, Tag, ChevronDown, ChevronRight, Store, FlaskConical,
} from 'lucide-react'
import { api } from '../api'
import { RecipeSlideOver } from './recipes/RecipeSlideOver'
import { useOutlet } from '../outlet'
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

const EMPTY_VARIANT: ProductVariant = { size: '', price: 0, stock: 0, sku: '', barcode: '' }
const MAX_IMAGES = 5
type Form = {
  name: string; brand: string; categoryId: string; description: string
  images: string[]; sellable: boolean
  isActive: boolean; isFeatured: boolean; variants: ProductVariant[]
}
const EMPTY: Form = {
  name: '', brand: 'Mandalika', categoryId: '', description: '', images: [],
  sellable: true, isActive: true, isFeatured: false,
  variants: [{ ...EMPTY_VARIANT }],
}

// Per-outlet editable row for one (outlet, variant): null price = use base.
type OcRow = { stock: number; price: number | null; available: boolean; parLevel: number | null }
const EMPTY_OC: OcRow = { stock: 0, price: null, available: true, parLevel: null }

export default function Products() {
  const { outletId } = useOutlet()
  // Refetch the list when the admin switches outlet so stock/price/availability
  // reflect that outlet (the API client sends X-Outlet-Id from the switcher).
  const pq = usePolledQuery<Product[]>(() => api.listProducts().then((r) => r.data), [outletId])
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
  // Per-outlet stock/price/availability for the product being edited. Keyed
  // `${outletId}|${variantSize}` and rendered as outlets × current form.variants
  // so newly added variants appear (with defaults) before saving.
  const [ocfgOutlets, setOcfgOutlets] = useState<{ id: string; name: string }[]>([])
  const [ocfgMap, setOcfgMap] = useState<Record<string, OcRow>>({})
  const [ocfgLoading, setOcfgLoading] = useState(false)
  const [ocCollapsed, setOcCollapsed] = useState<Record<string, boolean>>({})

  const [catOpen, setCatOpen] = useState(false)
  const [editingCat, setEditingCat] = useState<Category | null>(null)
  const [catForm, setCatForm] = useState({ name: '', description: '' })
  const [delCatId, setDelCatId] = useState<string | null>(null)

  // Recipe module: the per-variant "Resep" button only shows when the module flag
  // is ON, mirroring how Gudang gates its "Bahan" tab (api.getAppSettings).
  const [recipesEnabled, setRecipesEnabled] = useState(false)
  const [recipeFor, setRecipeFor] = useState<{ variantId: string; label: string } | null>(null)
  const [recipeVariantIds, setRecipeVariantIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    let alive = true
    api.getAppSettings().then((s) => { if (alive) setRecipesEnabled(s.recipesEnabled === true) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const filtered = products.filter((p) => {
    const m =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.brand.toLowerCase().includes(search.toLowerCase())
    return m && (!fCat || p.categoryId === fCat)
  })
  const catName = (cid: string) => categories.find((c) => c.id === cid)?.name || '—'

  const openEdit = async (p: Product) => {
    setEditing(p)
    setForm({
      name: p.name, brand: p.brand, categoryId: p.categoryId,
      description: p.description || '', images: p.images ?? (p.imageUrl ? [p.imageUrl] : []),
      sellable: p.sellable ?? true,
      isActive: p.isActive, isFeatured: p.isFeatured,
      variants: p.variants.map((v) => ({ ...v })),
    })
    setErr(null)
    setOcfgOutlets([])
    setOcfgMap({})
    setOcCollapsed({})
    setOpen(true)
    if (recipesEnabled) {
      api.getRecipeVariantIds(p.id)
        .then((ids) => setRecipeVariantIds(new Set(ids)))
        .catch(() => setRecipeVariantIds(new Set()))
    } else {
      setRecipeVariantIds(new Set())
    }
    setOcfgLoading(true)
    try {
      // Base product (all-outlet scope) gives the true base price/size/sku for the
      // Varian section — not the currently-selected outlet's resolved values. The
      // per-outlet matrix drives stock + price overrides + availability + PAR.
      const [base, cfg] = await Promise.all([
        api.getProduct(p.id).catch(() => null),
        api.getProductOutletConfig(p.id),
      ])
      if (base)
        setForm((f) => ({
          ...f,
          images: base.images ?? f.images,
          sellable: base.sellable ?? f.sellable,
          variants: base.variants.map((v) => ({ ...v })),
        }))
      const oMap = new Map<string, string>()
      const m: Record<string, OcRow> = {}
      for (const r of cfg) {
        oMap.set(r.outletId, r.outletName)
        m[`${r.outletId}|${r.variantSize}`] = { stock: r.stock, price: r.price ?? null, available: r.available, parLevel: r.parLevel ?? null }
      }
      setOcfgOutlets([...oMap].map(([id, name]) => ({ id, name })))
      setOcfgMap(m)
    } catch {
      // non-fatal: the per-outlet section just stays empty
    } finally {
      setOcfgLoading(false)
    }
  }

  const ocKey = (oid: string, size: string) => `${oid}|${size}`
  const ocGet = (oid: string, size: string): OcRow => ocfgMap[ocKey(oid, size)] ?? EMPTY_OC
  const ocSet = (oid: string, size: string, patch: Partial<OcRow>) =>
    setOcfgMap((m) => {
      const k = ocKey(oid, size)
      return { ...m, [k]: { ...(m[k] ?? EMPTY_OC), ...patch } }
    })
  // Master tick: set availability for every variant of one outlet.
  const setOutletAllAvailable = (oid: string, available: boolean) =>
    setOcfgMap((m) => {
      const next = { ...m }
      for (const v of form.variants) {
        if (!v.size.trim()) continue
        const k = ocKey(oid, v.size)
        next[k] = { ...(next[k] ?? EMPTY_OC), available }
      }
      return next
    })
  const basePriceOf = (size: string) => form.variants.find((v) => v.size === size)?.price ?? 0

  const onImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setUploading(true)
    try {
      for (const file of files) {
        if (form.images.length >= MAX_IMAGES) break
        const url = await uploadImage(file)
        setForm((f) => (f.images.length >= MAX_IMAGES ? f : { ...f, images: [...f.images, url] }))
      }
    } catch {
      setErr('Gagal upload gambar.')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const removeImage = (i: number) =>
    setForm((f) => ({ ...f, images: f.images.filter((_, x) => x !== i) }))
  const makeMainImage = (i: number) =>
    setForm((f) => ({ ...f, images: [f.images[i], ...f.images.filter((_, x) => x !== i)] }))

  const updVariant = (i: number, k: keyof ProductVariant, val: string) => {
    // Renaming a variant size: carry its per-outlet stock/price/availability over
    // to the new size key so the values aren't lost (rows are keyed by size).
    if (k === 'size') {
      const old = form.variants[i].size
      if (old && old !== val) {
        setOcfgMap((m) => {
          const next: typeof m = {}
          for (const [key, cfg] of Object.entries(m)) {
            const sep = key.indexOf('|')
            const oid = key.slice(0, sep)
            const sz = key.slice(sep + 1)
            next[sz === old ? `${oid}|${val}` : key] = cfg
          }
          return next
        })
      }
    }
    setForm((f) => {
      const v = [...f.variants]
      v[i] = { ...v[i], [k]: k === 'price' || k === 'stock' ? Number(val) : val }
      return { ...f, variants: v }
    })
  }

  const save = async () => {
    if (!form.name.trim()) return setErr('Nama produk wajib diisi')
    if (!form.categoryId) return setErr('Pilih kategori')
    if (form.variants.some((v) => !v.size || v.price <= 0))
      return setErr('Semua varian harus punya ukuran dan harga')
    if (form.variants.some((v) => !v.sku.trim()))
      return setErr('Setiap varian wajib punya SKU')
    setBusy(true)
    setErr(null)
    try {
      const body: ProductInput = {
        name: form.name.trim(),
        brand: form.brand.trim(),
        categoryId: form.categoryId,
        description: form.description,
        imageUrl: form.images[0] ?? '',
        images: form.images,
        sellable: form.sellable,
        isActive: form.isActive,
        isFeatured: form.isFeatured,
        variants: form.variants.map((v) => ({
          id: v.id, size: v.size.trim(), price: Number(v.price),
          stock: Number(v.stock), sku: v.sku.trim(),
          barcode: (v.barcode ?? '').trim() || v.sku.trim(),
        })),
      }
      if (editing) {
        await api.updateProduct(editing.id, body)
        if (ocfgOutlets.length > 0) {
          const items = ocfgOutlets.flatMap((o) =>
            form.variants
              .filter((v) => v.size.trim())
              .map((v) => {
                const c = ocfgMap[`${o.id}|${v.size}`] ?? EMPTY_OC
                return {
                  outletId: o.id,
                  outletName: o.name,
                  variantSize: v.size.trim(),
                  stock: c.stock,
                  price: c.price,
                  available: c.available,
                  parLevel: c.parLevel,
                }
              }),
          )
          await api.updateProductOutletConfig(editing.id, items)
        }
      } else {
        await api.createProduct(body)
      }
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
        Stok: v.stock, SKU: v.sku, Barcode: v.barcode || v.sku,
        Jual: p.sellable === false ? 'Tidak' : 'Ya',
        Aktif: p.isActive ? 'Ya' : 'Tidak',
        Unggulan: p.isFeatured ? 'Ya' : 'Tidak',
      })),
    )
    if (!rows.length) return
    if (fmt === 'xlsx') exportToXLSX(rows, 'produk_mandalika')
    else exportToCSV(rows, 'produk_mandalika')
    setExportMenu(false)
  }

  // Downloadable CSV template: the exact importer columns + two example rows
  // (one product, two variants → same Nama+Brand) so the grouping is self-evident.
  // First row leaves Barcode blank to show it defaults to the SKU.
  const downloadTemplate = () => {
    const example = [
      { Nama: 'Contoh Parfum', Brand: 'Mandalika', Kategori: 'Parfum', Deskripsi: 'Deskripsi singkat', Ukuran: '30ml', Harga: 150000, Stok: 10, SKU: 'CP-30', Barcode: '', Jual: 'Ya', Aktif: 'Ya', Unggulan: 'Tidak' },
      { Nama: 'Contoh Parfum', Brand: 'Mandalika', Kategori: 'Parfum', Deskripsi: '', Ukuran: '50ml', Harga: 220000, Stok: 5, SKU: 'CP-50', Barcode: '8991234567890', Jual: 'Ya', Aktif: 'Ya', Unggulan: 'Tidak' },
    ]
    exportToCSV(example, 'template_produk_mandalika')
  }

  const importProducts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Upsert: a product is matched by Nama+Brand; within it, variants are matched
    // by SKU (keep SKU, change Ukuran = rename → stock preserved server-side).
    // Rows without a SKU can't be correlated, so they're skipped.
    const rows = parseCSV(await file.text())
    const grouped: Record<string, { row: Record<string, string>; variants: ProductVariant[] }> = {}
    let skipped = 0
    for (const row of rows) {
      if (!row['Nama']?.trim()) continue
      if (!row['SKU']?.trim()) {
        skipped++
        continue
      }
      const key = `${row['Nama'].trim().toLowerCase()}|${(row['Brand'] || '').trim().toLowerCase()}`
      if (!grouped[key]) grouped[key] = { row, variants: [] }
      grouped[key].variants.push({
        size: row['Ukuran'] || '', price: parseFloat(row['Harga']) || 0,
        stock: parseInt(row['Stok']) || 0, sku: row['SKU'].trim(),
        barcode: (row['Barcode'] || '').trim() || row['SKU'].trim(),
      })
    }
    let created = 0
    let updated = 0
    for (const { row, variants } of Object.values(grouped)) {
      if (variants.length === 0) continue
      const cat = categories.find((c) => c.name.toLowerCase() === (row['Kategori'] || '').toLowerCase())
      const existing = products.find(
        (p) =>
          p.name.trim().toLowerCase() === row['Nama'].trim().toLowerCase() &&
          p.brand.trim().toLowerCase() === (row['Brand'] || '').trim().toLowerCase(),
      )
      const body: ProductInput = {
        name: row['Nama'].trim(),
        brand: row['Brand'] || 'Mandalika',
        categoryId: cat?.id || existing?.categoryId || '',
        description: row['Deskripsi'] || '',
        imageUrl: existing?.imageUrl || '',
        images: existing?.images ?? [],
        sellable: row['Jual'] ? row['Jual'] !== 'Tidak' : (existing?.sellable ?? true),
        isActive: row['Aktif'] !== 'Tidak',
        isFeatured: row['Unggulan'] === 'Ya',
        variants,
      }
      if (existing) {
        await api.updateProduct(existing.id, body)
        updated++
      } else {
        await api.createProduct(body)
        created++
      }
    }
    e.target.value = ''
    await pq.refetch()
    setErr(
      `${created} produk dibuat, ${updated} diperbarui` +
        (skipped ? `, ${skipped} baris dilewati (tanpa SKU)` : ''),
    )
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
                <Button variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={downloadTemplate}>
                  Template
                </Button>
                <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => csvRef.current?.click()}>
                  Import
                </Button>
                <input ref={csvRef} type="file" accept=".csv" onChange={importProducts} className="hidden" />
                <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => { setEditing(null); setForm({ ...EMPTY, variants: [{ ...EMPTY_VARIANT }] }); setErr(null); setOcfgOutlets([]); setOcfgMap({}); setOpen(true) }}>
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
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
                            {p.sellable === false && <Badge tone="warning">Internal</Badge>}
                          </div>
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
          <Field label={`Foto Produk (maks ${MAX_IMAGES}, foto pertama = utama)`}>
            <div className="flex flex-wrap gap-2">
              {form.images.map((url, i) => (
                <div key={i} className="relative w-20 h-20 rounded-2xl overflow-hidden border border-gray-200 group">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  {i === 0 && (
                    <span className="absolute top-0 left-0 bg-gold-600 text-white text-[9px] font-bold px-1 rounded-br-lg">Utama</span>
                  )}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1 transition">
                    {i !== 0 && (
                      <button type="button" onClick={() => makeMainImage(i)} title="Jadikan utama" className="text-white text-[10px] font-bold bg-gold-600 px-1.5 py-0.5 rounded">
                        Utama
                      </button>
                    )}
                    <button type="button" onClick={() => removeImage(i)} title="Hapus" className="text-white bg-red-600 rounded p-1">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
              {form.images.length < MAX_IMAGES && (
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="w-20 h-20 rounded-2xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400 hover:border-gold-400 hover:text-gold-600 disabled:opacity-50">
                  {uploading ? (
                    <span className="text-[10px]">...</span>
                  ) : (
                    <>
                      <Upload className="w-5 h-5" />
                      <span className="text-[10px] mt-0.5">Tambah</span>
                    </>
                  )}
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" multiple onChange={onImage} className="hidden" />
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
          <div className="flex gap-4 flex-wrap">
            {(['isActive', 'isFeatured', 'sellable'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
                <span className="text-sm font-bold text-gray-700">{k === 'isActive' ? 'Produk Aktif' : k === 'isFeatured' ? 'Produk Unggulan' : 'Dijual ke pelanggan'}</span>
              </label>
            ))}
          </div>
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-black text-gray-400 uppercase tracking-widest">Varian *</label>
              <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} onClick={() => setForm((f) => ({ ...f, variants: [...f.variants, { ...EMPTY_VARIANT }] }))}>Tambah</Button>
            </div>
            {!editing && (
              <p className="text-[11px] text-gray-400 mb-2 -mt-1 flex items-center gap-1">
                <Store className="w-3 h-3" /> Harga dasar di sini. Stok diatur per outlet
                setelah produk dibuat (Edit → Stok &amp; Harga per Outlet).
              </p>
            )}
            <div className="grid grid-cols-12 gap-2 px-1 mb-1">
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Ukuran</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Harga Dasar</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">SKU</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Barcode</span>
              <span className="col-span-1" />
            </div>
            <div className="space-y-2">
              {form.variants.map((v, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  {([
                    { k: 'size', span: 'col-span-3', ph: '30ml', num: false },
                    { k: 'price', span: 'col-span-3', ph: '150000', num: true },
                    { k: 'sku', span: 'col-span-3', ph: 'MND-01', num: false },
                  ] as const).map(({ k, span, ph, num }) => (
                    <input key={k} type={num ? 'number' : 'text'} value={num && v[k] === 0 ? '' : v[k]} onChange={(e) => updVariant(i, k, e.target.value)} placeholder={ph} className={`${fieldClass} ${span}`} />
                  ))}
                  <input
                    type="text"
                    value={v.barcode ?? ''}
                    onChange={(e) => updVariant(i, 'barcode', e.target.value)}
                    placeholder={v.sku.trim() || '= SKU'}
                    title="Kosongkan untuk memakai SKU sebagai barcode"
                    className={`${fieldClass} col-span-2`}
                  />
                  <div className="col-span-1 flex items-center justify-center gap-1">
                    {recipesEnabled && (
                      <button type="button"
                        title={!v.id ? 'Simpan produk dulu' : (recipeVariantIds.has(v.id) ? 'Resep tersedia' : 'Belum ada resep')}
                        disabled={!v.id}
                        onClick={() => v.id && setRecipeFor({ variantId: v.id, label: `${form.name || 'Produk'} — ${v.size}` })}
                        className={`${v.id && recipeVariantIds.has(v.id) ? 'text-gold-600 bg-gold-50 rounded' : 'text-gray-400'} hover:text-gold-600 disabled:opacity-30`}>
                        <FlaskConical className="w-4 h-4" />
                      </button>
                    )}
                    <button onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))}
                      disabled={form.variants.length === 1} className="text-gray-300 hover:text-red-500 disabled:opacity-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {editing && (
            <div>
              <label className="text-xs font-black text-gray-400 uppercase tracking-widest">
                Stok &amp; Harga per Outlet
              </label>
              {ocfgLoading ? (
                <p className="text-sm text-gray-400 py-3">Memuat data outlet…</p>
              ) : ocfgOutlets.length === 0 ? (
                <p className="text-sm text-gray-400 py-3">Tidak ada outlet aktif.</p>
              ) : (
                <div className="mt-2 space-y-3">
                  {ocfgOutlets.map((o) => {
                    const sizes = form.variants.filter((v) => v.size.trim())
                    const allOn = sizes.length > 0 && sizes.every((v) => ocGet(o.id, v.size).available)
                    const collapsed = ocCollapsed[o.id]
                    return (
                      <div key={o.id} className="border border-gray-100 rounded-xl">
                        <div className="flex items-center justify-between p-3">
                          <button type="button" onClick={() => setOcCollapsed((c) => ({ ...c, [o.id]: !c[o.id] }))} className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
                            {collapsed ? <ChevronRight className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                            <Store className="w-3.5 h-3.5 text-gold-600" /> {o.name}
                          </button>
                          <label className="flex items-center gap-1.5 cursor-pointer text-xs font-bold text-gray-500">
                            <input type="checkbox" checked={allOn} onChange={(e) => setOutletAllAvailable(o.id, e.target.checked)} className="w-4 h-4 accent-gold-600" />
                            Dijual di sini (semua)
                          </label>
                        </div>
                        {!collapsed && (
                          <div className="px-3 pb-3 space-y-1.5">
                            {sizes.length === 0 ? (
                              <p className="text-[11px] text-gray-400">Tambahkan varian dulu di atas.</p>
                            ) : (
                              <>
                                <div className="grid grid-cols-12 gap-2 px-1">
                                  <span className="col-span-5" />
                                  <span className="col-span-2 text-[10px] font-bold text-gray-400">Stok</span>
                                  <span className="col-span-3 text-[10px] font-bold text-gray-400">Harga</span>
                                  <span className="col-span-2 text-[10px] font-bold text-gray-400">PAR</span>
                                </div>
                                {sizes.map((v) => {
                                  const c = ocGet(o.id, v.size)
                                  return (
                                    <div key={v.size} className="grid grid-cols-12 gap-2 items-center">
                                      <label className="col-span-1 flex justify-center cursor-pointer">
                                        <input type="checkbox" checked={c.available} onChange={(e) => ocSet(o.id, v.size, { available: e.target.checked })} className="w-4 h-4 accent-gold-600" />
                                      </label>
                                      <span className={`col-span-4 text-xs truncate ${c.available ? 'text-gray-600' : 'text-gray-300 line-through'}`}>{v.size}</span>
                                      <input type="number" value={c.stock === 0 ? '' : c.stock} onChange={(e) => ocSet(o.id, v.size, { stock: e.target.value === '' ? 0 : Number(e.target.value) })} placeholder="0" disabled={!c.available} className={`${fieldClass} col-span-2 py-1.5 disabled:opacity-40`} />
                                      <input type="number" value={c.price ?? ''} onChange={(e) => ocSet(o.id, v.size, { price: e.target.value === '' ? null : Number(e.target.value) })} placeholder={`${basePriceOf(v.size)}`} disabled={!c.available} className={`${fieldClass} col-span-3 py-1.5 disabled:opacity-40`} />
                                      <input type="number" value={c.parLevel ?? ''} onChange={(e) => ocSet(o.id, v.size, { parLevel: e.target.value === '' ? null : Number(e.target.value) })} placeholder="—" disabled={!c.available} title="Batas stok menipis (low-stock)" className={`${fieldClass} col-span-2 py-1.5 disabled:opacity-40`} />
                                    </div>
                                  )
                                })}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <p className="text-[11px] text-gray-400">Centang = dijual di outlet itu. Harga kosong = pakai harga dasar varian.</p>
                </div>
              )}
            </div>
          )}

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

      {recipeFor && (
        <RecipeSlideOver
          productId={editing?.id ?? ''}
          variantId={recipeFor.variantId}
          variantLabel={recipeFor.label}
          onClose={() => {
            setRecipeFor(null)
            if (editing?.id && recipesEnabled) {
              api.getRecipeVariantIds(editing.id)
                .then((ids) => setRecipeVariantIds(new Set(ids)))
                .catch(() => {})
            }
          }}
        />
      )}
    </div>
  )
}
