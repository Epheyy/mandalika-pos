import { useEffect, useState } from 'react'
import type { DiscountCode, DiscountCodeInput, Promotion } from '@mandalika/api'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { CodeFormSlideOver } from './CodeFormSlideOver'
import { isPhoneOnlyCustomerLookup } from './customerLookupMode'
import { EMPTY_CODE, codeProblems, codeToInput } from './discountCodeForm'
import { useEditorGuard, useLeave } from './useEditorLeave'
import { useRecordEditor } from './useRecordEditor'

interface CodeEditorHostProps {
  /** The code to edit, or null for a new one. */
  codeId: string | null
  closeEditor: () => void
  refetchList: () => Promise<unknown>
}

// Stable functions: the editor hook reads them once, at mount.
const fetchCodes = () => api.listDiscountCodes()
const emptyCode = (): DiscountCodeInput => ({ ...EMPTY_CODE })
const createCode = (input: DiscountCodeInput) => api.createDiscountCode(input)
const updateCode = (id: string, input: DiscountCodeInput) => api.updateDiscountCode(id, input)

/** The discount-code editor overlay, mounted while `?ubah=<id>` / `?baru=1` is in the URL. */
export function CodeEditorHost({ codeId, closeEditor, refetchList }: CodeEditorHostProps) {
  const { user } = useAuth()
  const [promotions, setPromotions] = useState<Promotion[]>([])
  // Display-only name for a holder picked in this session (DiscountCodeInput has no customerName field; it only
  // exists on the read type, so a loaded holder's name comes from the row).
  const [pickedName, setPickedName] = useState<string | null>(null)
  const { answeredRef, leave } = useLeave(closeEditor)
  const editor = useRecordEditor<DiscountCode, DiscountCodeInput>({
    recordId: codeId,
    fetchAll: fetchCodes,
    toInput: codeToInput,
    empty: emptyCode,
    create: createCode,
    update: updateCode,
    problemsOf: codeProblems,
    onSaved: async () => {
      await refetchList()
      leave()
    },
    saveFailure: 'Kode diskon gagal disimpan.',
    loadFailure: 'Kode diskon gagal dimuat.',
  })
  const requestClose = useEditorGuard({ answeredRef, leave, dirty: editor.dirty, load: editor.load, closeEditor, subject: 'kode diskon' })

  useEffect(() => {
    let alive = true
    api.listPromotions().then((rows) => alive && setPromotions(rows)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const { setForm } = editor
  const customerName = pickedName ?? editor.row?.customerName ?? ''
  return (
    <CodeFormSlideOver
      editing={codeId !== null}
      load={editor.load}
      loadError={editor.loadError}
      form={editor.form}
      setForm={setForm}
      promotions={promotions}
      customerName={customerName}
      phoneOnly={isPhoneOnlyCustomerLookup(user)}
      onCustomerChange={(id, name) => {
        setForm((f) => ({ ...f, customerId: id }))
        setPickedName(name)
      }}
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
