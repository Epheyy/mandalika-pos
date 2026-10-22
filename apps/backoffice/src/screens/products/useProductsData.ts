import { useEffect, useState } from 'react'
import type { Product, Category, Bundle, ProductVariant, ProductInput } from '@mandalika/api'
import { SINGLE_UNIT_SIZE } from '@mandalika/types'
import { api } from '../../api'
import { validateProductForm } from './validateForm'
import { loadAllProducts } from '../../lib/loadAll'
import { useOutlet } from '../../outlet'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { uploadImage } from '../../lib/uploadImage'
import { exportToCSV, exportToXLSX, buildExportName } from '../../lib/csvUtils'
import { PRODUCT_TEMPLATE_ROWS } from '../../lib/importTemplates'
import { productExportRows } from '../../lib/productExport'
import { EMPTY, EMPTY_OC, EMPTY_VARIANT, MAX_IMAGES, ocKey } from './types'
import type { Form, OcRow } from './types'

// All data orchestration for the Products screen lives here as the screen's own
// hook: the per-outlet config matrix, the openEdit async hydrate, save/per-outlet
// save, the ocfgMap-rekeying updVariant, CSV import/export, and every refetch.
// The screen component stays presentational, wiring this state into child views.
export function useProductsData() {
  const { outletId, outlets: ctxOutlets } = useOutlet()
  // Refetch the list when the admin switches outlet so stock/price/availability
  // reflect that outlet (the API client sends X-Outlet-Id from the switcher).
  const pq = usePolledQuery<Product[]>(() => loadAllProducts((p, l) => api.listProducts(p, l)), [outletId])
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
      erpLinked: p.erpLinked === true, erpGroupKey: p.erpGroupKey ?? null,
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
          erpLinked: base.erpLinked === true, erpGroupKey: base.erpGroupKey ?? null,
        }))
      const oMap = new Map<string, string>()
      const m: Record<string, OcRow> = {}
      for (const r of cfg) {
        oMap.set(r.outletId, r.outletName)
        m[`${r.outletId}|${r.variantSize}`] = { price: r.price ?? null, available: r.available }
      }
      setOcfgOutlets([...oMap].map(([id, name]) => ({ id, name })))
      setOcfgMap(m)
    } catch {
      // non-fatal: the per-outlet section just stays empty
    } finally {
      setOcfgLoading(false)
    }
  }

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
      v[i] = { ...v[i], [k]: k === 'price' ? Number(val) : val }
      return { ...f, variants: v }
    })
  }

  const addVariant = () => setForm((f) => ({ ...f, variants: [...f.variants, { ...EMPTY_VARIANT }] }))
  const removeVariant = (i: number) => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))

  const save = async () => {
    const invalid = validateProductForm(form)
    if (invalid) return setErr(invalid)
    const single = form.variants.length === 1
    const variants = form.variants.map((v) => ({
      ...v,
      size: v.size.trim() || (single ? SINGLE_UNIT_SIZE : ''),
    }))
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
        variants: variants.map((v) => ({
          id: v.id, size: v.size, price: Number(v.price),
          stock: 0, // stock managed in Inventori; kept as 0 to satisfy ProductVariant type
          sku: v.sku.trim(),
          barcode: (v.barcode ?? '').trim() || v.sku.trim(),
        })),
      }
      if (editing) {
        await api.updateProduct(editing.id, body)
        if (ocfgOutlets.length > 0) {
          const items = ocfgOutlets.flatMap((o) =>
            variants.flatMap((v) => {
              if (!v.size) return []
              const c = ocfgMap[`${o.id}|${v.size}`] ?? EMPTY_OC
              // price + available only; stock/PAR are owned by Inventori.
              return [
                {
                  outletId: o.id,
                  variantSize: v.size,
                  price: c.price,
                  available: c.available,
                },
              ]
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
    // Blank (not the "—" display placeholder) for a product without category, and the BASE price.
    const rows = productExportRows(products, (id) => categories.find((c) => c.id === id)?.name ?? '')
    if (!rows.length) return
    // The product list is outlet-scoped (X-Outlet-Id); name the file by that scope.
    const scope = outletId ? (ctxOutlets.find((o) => o.id === outletId)?.name ?? null) : 'semua-outlet'
    const name = buildExportName('produk', [scope])
    if (fmt === 'xlsx') exportToXLSX(rows, name)
    else exportToCSV(rows, name)
  }

  const downloadProductTemplate = () => exportToCSV(PRODUCT_TEMPLATE_ROWS, 'template_produk_mandalika')
  const refetchAfterImport = () => void Promise.all([pq.refetch(), cq.refetch()])

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

  return {
    // queries / derived
    products, categories, bundles, filtered, catName,
    pqLoading: pq.loading,
    refetchCats: cq.refetch,
    // tab + filters
    tab, setTab, search, setSearch, fCat, setFCat,
    // product modal
    open, setOpen, editing, setEditing, form, setForm, busy, err, setErr,
    uploading, onImage, removeImage, makeMainImage,
    openEdit, save,
    // variants + recipe
    addVariant, removeVariant, updVariant,
    recipesEnabled, recipeFor, setRecipeFor, recipeVariantIds, setRecipeVariantIds,
    // per-outlet config
    ocfgOutlets, setOcfgOutlets, setOcfgMap, ocfgLoading, ocGet, ocSet,
    setOutletAllAvailable, basePriceOf, ocCollapsed, setOcCollapsed,
    // delete
    delId, setDelId, del,
    // categories
    catOpen, setCatOpen, editingCat, setEditingCat, catForm, setCatForm,
    delCatId, setDelCatId, saveCat,
    // import/export
    exportProducts, downloadProductTemplate, refetchAfterImport,
  }
}
