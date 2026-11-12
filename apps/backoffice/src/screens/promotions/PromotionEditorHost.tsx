import { useCallback, useEffect, useState } from 'react'
import type { BundleSettings, Outlet, Product, Promotion, PromotionInput } from '@mandalika/api'
import { api } from '../../api'
import { activeProducts, productCatalogue } from '../../lib/productCatalogue'
import { useConfirm } from '../../ui/ConfirmDialog'
import { settingsToForm } from '../products/bundleSettings'
import { PromoFormSlideOver } from './PromoFormSlideOver'
import { EMPTY_PROMO, promotionProblems, promotionToInput } from './promotionForm'
import { useEditorGuard, useLeave } from './useEditorLeave'
import { useRecordEditor } from './useRecordEditor'
import { confirmActivation, needsActivationConfirm, wasActiveNow } from './useStatusToggle'

interface PromotionEditorHostProps {
  /** The promotion to edit, or null for a new one. */
  promoId: string | null
  /** Removes the overlay from the URL (replaces the entry, so Back does not reopen it). */
  closeEditor: () => void
  refetchList: () => Promise<unknown>
}

// Stable functions: the editor hook reads them once, at mount.
const fetchPromotions = () => api.listPromotions()
const emptyPromo = (): PromotionInput => ({ ...EMPTY_PROMO })
const createPromo = (input: PromotionInput) => api.createPromotion(input)
const updatePromo = (id: string, input: PromotionInput) => api.updatePromotion(id, input)

/** The pickers' data, read once when the editor opens (not polled: the list screen no longer walks the catalogue). */
function usePickerData() {
  const [products, setProducts] = useState<Product[]>([])
  const [productsState, setProductsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [outletsState, setOutletsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  // Diskon Bundle's pickers only; a failed load leaves them empty (the jenis then reads Semua lini / Semua ukuran).
  const [bundle, setBundle] = useState<BundleSettings | null>(null)
  useEffect(() => {
    let alive = true
    api
      .getBundleSettings()
      .then((r) => alive && setBundle(r.data))
      .catch(() => undefined)
    // The shared catalogue: opening the editor again within its TTL costs no request, and a product saved in this tab refetches.
    productCatalogue
      .get()
      .then((all) => {
        if (!alive) return
        setProducts(activeProducts(all) ?? [])
        setProductsState('ready')
      })
      .catch(() => alive && setProductsState('failed'))
    api
      .listOutlets()
      .then((o) => {
        if (!alive) return
        setOutlets(o)
        setOutletsState('ready')
      })
      .catch(() => alive && setOutletsState('failed'))
    return () => {
      alive = false
    }
  }, [])
  const bundleLines = bundle?.lines ?? []
  const bundleSizes = bundle ? Object.keys(settingsToForm(bundle).standard) : []
  return { products, productsState, outlets, outletsState, bundleLines, bundleSizes }
}

/** The promotion editor overlay, mounted while `?ubah=<id>` / `?baru=1` is in the URL. */
export function PromotionEditorHost({ promoId, closeEditor, refetchList }: PromotionEditorHostProps) {
  const picker = usePickerData()
  const { answeredRef, leave } = useLeave(closeEditor)
  const confirm = useConfirm()
  // Saving it live asks the same question as the list Switch; an already-active promo saved again does not.
  const confirmSave = useCallback(
    async (input: PromotionInput, row: Promotion | null) =>
      !needsActivationConfirm(input.isActive ? await wasActiveNow(row, fetchPromotions) : null, input.isActive) ||
      confirmActivation(confirm, 'promo', input.name),
    [confirm],
  )
  const editor = useRecordEditor<Promotion, PromotionInput>({
    recordId: promoId,
    fetchAll: fetchPromotions,
    toInput: promotionToInput,
    empty: emptyPromo,
    create: createPromo,
    update: updatePromo,
    problemsOf: promotionProblems,
    confirmSave,
    onSaved: async () => {
      await refetchList()
      leave()
    },
    saveFailure: 'Promosi gagal disimpan.',
    loadFailure: 'Promosi gagal dimuat.',
  })
  const requestClose = useEditorGuard({ answeredRef, leave, dirty: editor.dirty, busy: editor.busy, load: editor.load, closeEditor, subject: 'promosi' })

  return (
    <PromoFormSlideOver
      editing={promoId !== null}
      load={editor.load}
      loadError={editor.loadError}
      form={editor.form}
      setForm={editor.setForm}
      products={picker.products}
      bundleLines={picker.bundleLines}
      bundleSizes={picker.bundleSizes}
      productsState={picker.productsState}
      outlets={picker.outlets}
      outletsState={picker.outletsState}
      dirty={editor.dirty}
      busy={editor.busy}
      err={editor.err}
      problems={editor.shownProblems}
      saveBlocked={editor.problems.length > 0}
      onSave={() => void editor.save()}
      onClose={() => void requestClose()}
    />
  )
}
