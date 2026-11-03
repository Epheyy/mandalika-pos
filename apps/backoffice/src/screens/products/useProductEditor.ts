import { useEffect, useMemo, useState } from 'react'
import { ApiError, type Product, type ProductInput, type ProductVariant } from '@mandalika/api'
import { SINGLE_UNIT_SIZE } from '@mandalika/types'
import { api } from '../../api'
import { uploadImage } from '../../lib/uploadImage'
import { EMPTY, EMPTY_OC, EMPTY_VARIANT, MAX_IMAGES, ocKey } from './types'
import type { Form, OcRow, OcfgOutlet } from './types'
import { productFormErrors } from './validateForm'

export type EditorLoad = 'loading' | 'ready' | 'missing' | 'failed'

interface EditorArgs {
  /** The product to edit (a validated id), or null to create a new one. */
  productId: string | null
  recipesEnabled: boolean
  /** Called after a successful save (refetch the list, close the editor). */
  onSaved: () => void | Promise<void>
}

const newForm = (): Form => ({ ...EMPTY, variants: [{ ...EMPTY_VARIANT }] })
const signatureOf = (form: Form, ocfgMap: Record<string, OcRow>): string => JSON.stringify({ form, ocfgMap })

function formFromProduct(p: Product): Form {
  return {
    name: p.name, brand: p.brand, categoryId: p.categoryId,
    description: p.description || '', images: p.images ?? (p.imageUrl ? [p.imageUrl] : []),
    sellable: p.sellable ?? true,
    isActive: p.isActive, isFeatured: p.isFeatured,
    variants: p.variants.map((v) => ({ ...v })),
    erpLinked: p.erpLinked === true, erpGroupKey: p.erpGroupKey ?? null,
  }
}

/**
 * One product editor session: mounted when the overlay opens (`?ubah=` / `?baru=1`) and gone when it closes, so
 * nothing needs resetting. An edit loads the BASE product by id (the list row may be on another page, and carries
 * outlet-scoped values) plus the per-outlet price/availability matrix, then takes its unsaved-changes baseline.
 */
export function useProductEditor({ productId, recipesEnabled, onSaved }: EditorArgs) {
  const [form, setForm] = useState<Form>(newForm)
  const [load, setLoad] = useState<EditorLoad>(productId ? 'loading' : 'ready')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<string | null>(() => (productId ? null : signatureOf(newForm(), {})))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Per-outlet price/availability for the product being edited, keyed `${outletId}|${variantSize}`.
  const [ocfgOutlets, setOcfgOutlets] = useState<OcfgOutlet[]>([])
  const [ocfgMap, setOcfgMap] = useState<Record<string, OcRow>>({})
  const [ocCollapsed, setOcCollapsed] = useState<Record<string, boolean>>({})
  const [recipeVariantIds, setRecipeVariantIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!productId) return
    let alive = true
    const hydrate = async () => {
      try {
        // The per-outlet matrix is optional: without it that section stays empty and a save leaves it alone.
        const [base, cfg] = await Promise.all([api.getProduct(productId), api.getProductOutletConfig(productId).catch(() => [])])
        if (!alive) return
        const outlets = new Map<string, string>()
        const matrix: Record<string, OcRow> = {}
        for (const r of cfg) {
          outlets.set(r.outletId, r.outletName)
          matrix[ocKey(r.outletId, r.variantSize)] = { price: r.price ?? null, available: r.available }
        }
        const loaded = formFromProduct(base)
        setForm(loaded)
        setOcfgOutlets([...outlets].map(([id, name]) => ({ id, name })))
        setOcfgMap(matrix)
        setBaseline(signatureOf(loaded, matrix))
        setLoad('ready')
      } catch (e: unknown) {
        if (!alive) return
        const missing = e instanceof ApiError && e.status === 404
        setLoadError(missing ? 'Produk tidak ditemukan. Mungkin sudah dihapus.' : e instanceof Error ? e.message : 'Produk gagal dimuat.')
        setLoad(missing ? 'missing' : 'failed')
      }
    }
    void hydrate()
    return () => {
      alive = false
    }
  }, [productId])

  useEffect(() => {
    if (!productId || !recipesEnabled) return
    let alive = true
    api.getRecipeVariantIds(productId)
      .then((ids) => alive && setRecipeVariantIds(new Set(ids)))
      .catch(() => alive && setRecipeVariantIds(new Set()))
    return () => {
      alive = false
    }
  }, [productId, recipesEnabled])

  const refreshRecipeIds = () => {
    if (!productId || !recipesEnabled) return
    api.getRecipeVariantIds(productId).then((ids) => setRecipeVariantIds(new Set(ids))).catch(() => {})
  }

  const dirty = load === 'ready' && baseline !== null && signatureOf(form, ocfgMap) !== baseline
  const errors = useMemo(() => productFormErrors(form), [form])
  // Field errors appear after the first save attempt and then follow the form, so they vanish as they are fixed.
  const shownErrors = submitted ? errors : []

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
    const input = e.target
    const files = Array.from(input.files ?? [])
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
      input.value = ''
    }
  }
  const removeImage = (i: number) => setForm((f) => ({ ...f, images: f.images.filter((_, x) => x !== i) }))
  const makeMainImage = (i: number) => setForm((f) => ({ ...f, images: [f.images[i], ...f.images.filter((_, x) => x !== i)] }))

  const updVariant = (i: number, k: keyof ProductVariant, val: string) => {
    let next = val
    if (k === 'size') {
      // A single-unit product's blank Ukuran stands for the stored "Satuan" (kept in state so the per-outlet keys hold).
      if (productId && !val.trim() && form.variants.length === 1) next = SINGLE_UNIT_SIZE
      // Renaming a size carries its per-outlet price/availability over to the new key (rows are keyed by size).
      const old = form.variants[i].size
      if (old && old !== next) {
        setOcfgMap((m) => {
          const moved: typeof m = {}
          for (const [key, cfg] of Object.entries(m)) {
            const sep = key.indexOf('|')
            const oid = key.slice(0, sep)
            const sz = key.slice(sep + 1)
            moved[sz === old ? `${oid}|${next}` : key] = cfg
          }
          return moved
        })
      }
    }
    setForm((f) => {
      const v = [...f.variants]
      v[i] = { ...v[i], [k]: k === 'price' ? Number(next) : next }
      return { ...f, variants: v }
    })
  }
  const addVariant = () => setForm((f) => ({ ...f, variants: [...f.variants, { ...EMPTY_VARIANT }] }))
  const removeVariant = (i: number) => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))

  const save = async () => {
    setSubmitted(true)
    setErr(null)
    if (errors.length > 0) {
      document.getElementById(errors[0].fieldId)?.focus()
      return
    }
    const single = form.variants.length === 1
    const variants = form.variants.map((v) => ({ ...v, size: v.size.trim() || (single ? SINGLE_UNIT_SIZE : '') }))
    setBusy(true)
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
      if (productId) {
        await api.updateProduct(productId, body)
        if (ocfgOutlets.length > 0) {
          // price + available only; stock/PAR are owned by Inventori.
          const items = ocfgOutlets.flatMap((o) =>
            variants.filter((v) => v.size).map((v) => {
              const c = ocfgMap[ocKey(o.id, v.size)] ?? EMPTY_OC
              return { outletId: o.id, variantSize: v.size, price: c.price, available: c.available }
            }),
          )
          await api.updateProductOutletConfig(productId, items)
        }
      } else {
        await api.createProduct(body)
      }
      await onSaved()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan.')
    } finally {
      setBusy(false)
    }
  }

  return {
    form, setForm, load, loadError, dirty, busy, err, shownErrors, uploading,
    onImage, removeImage, makeMainImage, save,
    addVariant, removeVariant, updVariant,
    recipeVariantIds, refreshRecipeIds,
    ocfgOutlets, ocfgLoading: load === 'loading', ocGet, ocSet, setOutletAllAvailable, basePriceOf, ocCollapsed, setOcCollapsed,
  }
}
