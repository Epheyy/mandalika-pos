import { useEffect, useRef, useState } from 'react'
import type { Category } from '@mandalika/api'
import { api } from '../../api'
import { useUnsavedChanges } from '../../lib/useUnsavedChanges'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toast'
import { RecipeSlideOver } from '../recipes/RecipeSlideOver'
import { ProductFormSlideOver } from './ProductFormSlideOver'
import { useProductEditor } from './useProductEditor'

interface ProductEditorHostProps {
  /** The product to edit, or null for a new one. */
  productId: string | null
  categories: Category[]
  /** Removes the overlay from the URL (replaces the entry, so Back does not reopen it). */
  closeEditor: () => void
  refetchList: () => Promise<unknown>
}

/**
 * The product editor overlay and the recipe layer above it. Mounted while `?ubah=` / `?baru=1` is in the URL.
 * Unsaved changes in either layer are guarded by ONE question that covers every way out: ×, Escape, the backdrop,
 * browser Back, the sidebar and a typed URL. A save, or an answered "Buang perubahan", closes without asking again.
 */
export function ProductEditorHost({ productId, categories, closeEditor, refetchList }: ProductEditorHostProps) {
  const confirm = useConfirm()
  const toast = useToast()
  const answered = useRef(false)
  const [recipesEnabled, setRecipesEnabled] = useState(false)
  const [recipeFor, setRecipeFor] = useState<{ variantId: string; label: string } | null>(null)
  const [recipeDirty, setRecipeDirty] = useState(false)

  useEffect(() => {
    let alive = true
    // Recipes are a module flag, like Gudang's "Bahan" tab: the per-variant "Resep" button only shows when it is on.
    api.getAppSettings().then((s) => alive && setRecipesEnabled(s.recipesEnabled === true)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const leave = () => {
    answered.current = true
    closeEditor()
  }
  const editor = useProductEditor({
    productId,
    recipesEnabled,
    onSaved: async () => {
      await refetchList()
      leave()
    },
  })

  const askLeave = async (): Promise<boolean> => {
    // Nothing unsaved (or already answered): leaving needs no question, so a plain x on an untouched form just closes.
    if (answered.current || !(editor.dirty || recipeDirty)) return true
    const answer = await confirm({
      title: 'Buang perubahan?',
      consequence: 'Perubahan pada produk ini belum disimpan dan akan hilang.',
      confirmLabel: 'Buang perubahan',
      cancelLabel: 'Lanjut edit',
      tone: 'danger',
    })
    return answer.confirmed
  }
  useUnsavedChanges(editor.dirty || recipeDirty, askLeave)

  const requestClose = async () => {
    if (await askLeave()) leave()
  }

  const { load } = editor
  useEffect(() => {
    if (load !== 'missing') return
    toast({ message: 'Produk tidak ditemukan. Mungkin sudah dihapus.', tone: 'warn' })
    answered.current = true
    closeEditor()
  }, [load, toast, closeEditor])

  return (
    <>
      <ProductFormSlideOver
        onClose={() => void requestClose()}
        editing={productId !== null}
        load={editor.load}
        loadError={editor.loadError}
        dirty={editor.dirty}
        busy={editor.busy}
        err={editor.err}
        errors={editor.shownErrors}
        onSave={() => void editor.save()}
        form={editor.form}
        setForm={editor.setForm}
        categories={categories}
        uploading={editor.uploading}
        onImage={(e) => void editor.onImage(e)}
        removeImage={editor.removeImage}
        makeMainImage={editor.makeMainImage}
        recipesEnabled={recipesEnabled}
        recipeVariantIds={editor.recipeVariantIds}
        onUpdVariant={editor.updVariant}
        onAddVariant={editor.addVariant}
        onRemoveVariant={editor.removeVariant}
        setRecipeFor={setRecipeFor}
        ocfgLoading={editor.ocfgLoading}
        ocfgOutlets={editor.ocfgOutlets}
        ocGet={editor.ocGet}
        ocSet={editor.ocSet}
        setOutletAllAvailable={editor.setOutletAllAvailable}
        basePriceOf={editor.basePriceOf}
        ocCollapsed={editor.ocCollapsed}
        setOcCollapsed={editor.setOcCollapsed}
      />
      {recipeFor && productId && (
        <RecipeSlideOver
          productId={productId}
          variantId={recipeFor.variantId}
          variantLabel={recipeFor.label}
          onDirtyChange={setRecipeDirty}
          onClose={() => {
            setRecipeFor(null)
            editor.refreshRecipeIds()
          }}
        />
      )}
    </>
  )
}
