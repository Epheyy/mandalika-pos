import { useEffect, useState } from 'react'
import type { Outlet, Product, Promotion, PromotionInput } from '@mandalika/api'
import { api } from '../../api'
import { loadAllProducts } from '../../lib/loadAll'
import { PromoFormSlideOver } from './PromoFormSlideOver'
import { EMPTY_PROMO, promotionProblems, promotionToInput } from './promotionForm'
import { useEditorGuard, useLeave } from './useEditorLeave'
import { useRecordEditor } from './useRecordEditor'

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
  useEffect(() => {
    let alive = true
    loadAllProducts((p, l) => api.listProducts(p, l))
      .then((all) => {
        if (!alive) return
        setProducts(all.filter((p) => p.isActive))
        setProductsState('ready')
      })
      .catch(() => alive && setProductsState('failed'))
    api.listOutlets().then((o) => alive && setOutlets(o)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return { products, productsState, outlets }
}

/** The promotion editor overlay, mounted while `?ubah=<id>` / `?baru=1` is in the URL. */
export function PromotionEditorHost({ promoId, closeEditor, refetchList }: PromotionEditorHostProps) {
  const picker = usePickerData()
  const { answeredRef, leave } = useLeave(closeEditor)
  const editor = useRecordEditor<Promotion, PromotionInput>({
    recordId: promoId,
    fetchAll: fetchPromotions,
    toInput: promotionToInput,
    empty: emptyPromo,
    create: createPromo,
    update: updatePromo,
    problemsOf: promotionProblems,
    onSaved: async () => {
      await refetchList()
      leave()
    },
    saveFailure: 'Promosi gagal disimpan.',
    loadFailure: 'Promosi gagal dimuat.',
  })
  const requestClose = useEditorGuard({ answeredRef, leave, dirty: editor.dirty, load: editor.load, closeEditor, subject: 'promosi' })

  return (
    <PromoFormSlideOver
      editing={promoId !== null}
      load={editor.load}
      loadError={editor.loadError}
      form={editor.form}
      setForm={editor.setForm}
      products={picker.products}
      productsState={picker.productsState}
      outlets={picker.outlets}
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
