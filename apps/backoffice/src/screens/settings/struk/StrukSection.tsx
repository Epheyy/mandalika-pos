import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { components, ReceiptTemplate } from '@mandalika/api'
import { api } from '../../../api'
import { routeById } from '../../../lib/router/routes'
import { useUnsavedChanges } from '../../../lib/useUnsavedChanges'
import { ConfirmDialog } from '../../../ui/ConfirmDialog'
import { designerReducer, type DesignerState } from './designerReducer'
import { AssignOutletsDialog, NameDialog } from './Dialogs'
import {
  STALE_SAVE_COPY, inUseCopy, needsVirtualStandar, saveDesign, standarOutletIds, unusableTemplateIds,
} from './receiptTemplates'
import { StrukView, type Notice } from './StrukView'
import { VIRTUAL_KEY } from './TemplateBar'
import { useReceiptTemplates } from './useReceiptTemplates'

type ReceiptSettings = components['schemas']['ReceiptSettings']

// A move inside Pengaturan › Struk is not a leave; moving to another tab or screen is (the draft would be lost).
const STRUK_SCOPE = [routeById('settings')?.path ?? 'pengaturan', 'struk'] as const

type Dialog = null | 'new' | 'duplicate' | 'rename' | 'delete' | 'assign'
type Pending = null | { run: () => void }

const initState = (settings: ReceiptSettings): DesignerState =>
  designerReducer({} as DesignerState, { type: 'loadVirtualStandar', settings })

/** Pengaturan › Struk: the receipt designer. Standar is the saved default template, or one built from the
 *  receipt settings until someone saves it. */
export function StrukSection({ receiptSettings }: { receiptSettings: ReceiptSettings }) {
  const data = useReceiptTemplates()
  const { templates, outlets, loaded, loadError, reload } = data
  const [state, dispatch] = useReducer(designerReducer, receiptSettings, initState)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [leaveAsk, setLeaveAsk] = useState<((leave: boolean) => void) | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [assignSaving, setAssignSaving] = useState(false)
  const [assignError, setAssignError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const opened = useRef(false)

  const showVirtualStandar = needsVirtualStandar(templates)
  const unusable = unusableTemplateIds(templates)

  const openDefault = useCallback((list: readonly ReceiptTemplate[]) => {
    const def = list.find((t) => t.isDefault)
    if (def) dispatch({ type: 'load', template: def })
    else dispatch({ type: 'loadVirtualStandar', settings: receiptSettings })
  }, [receiptSettings])

  // Once the list arrives, open the saved Standar (or keep the virtual one).
  useEffect(() => {
    if (!loaded || opened.current) return
    opened.current = true
    openDefault(templates)
  }, [loaded, templates, openDefault])

  const askLeave = useCallback(() => new Promise<boolean>((resolve) => setLeaveAsk(() => resolve)), [])
  useUnsavedChanges(state.dirty, askLeave, STRUK_SCOPE)
  const answerLeave = (leave: boolean) => {
    leaveAsk?.(leave)
    setLeaveAsk(null)
  }

  /** Runs `go` now, or after the admin agrees to drop the unsaved edits. */
  const guarded = (go: () => void) => (state.dirty ? setPending({ run: go }) : go())

  const selectedKey = state.templateId ?? (state.isDefault ? VIRTUAL_KEY : '__new__')
  const stored = templates.find((t) => t.id === state.templateId)
  const usedBy = state.templateId === null
    ? (state.isDefault ? standarOutletIds(templates, outlets.map((o) => o.id)).length : null)
    : (stored?.outletIds.length ?? 0)

  const onSelect = (key: string) => guarded(() => {
    setNotice(null)
    if (key === VIRTUAL_KEY) dispatch({ type: 'loadVirtualStandar', settings: receiptSettings })
    else {
      const t = templates.find((x) => x.id === key)
      if (t) dispatch({ type: 'load', template: t })
    }
  })

  const onSave = async () => {
    setSaving(true)
    setNotice(null)
    const result = await saveDesign(api, state)
    setSaving(false)
    if (result.kind === 'ok') {
      await reload()
      dispatch({ type: 'load', template: result.template })
      setNotice({ tone: 'ok', text: 'Template tersimpan. Tablet mengambilnya saat sinkron berikutnya.' })
    } else if (result.kind === 'stale') {
      // Keep the draft; the list is refreshed so "Muat ulang" shows the server copy.
      await reload()
      setNotice({ tone: 'error', text: STALE_SAVE_COPY, reload: true })
    } else {
      setNotice({ tone: 'error', text: result.message })
    }
  }

  const onReloadServerCopy = async () => {
    const list = await reload()
    if (list === null) {
      setNotice({ tone: 'error', text: 'Gagal memuat ulang template. Coba lagi.', reload: true })
      return
    }
    setNotice(null)
    const mine = list.find((t) => t.id === state.templateId)
    if (mine) dispatch({ type: 'load', template: mine })
    else openDefault(list)
  }

  const onDelete = async () => {
    const t = stored
    if (!t) return
    setDeleteError(null)
    try {
      await api.deleteReceiptTemplate(t.id)
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : 'Gagal menghapus template.')
      return
    }
    const list = await reload()
    setDialog(null)
    openDefault(list ?? templates.filter((x) => x.id !== t.id))
  }

  const onAssign = async (outletIds: string[]) => {
    setAssignSaving(true)
    setAssignError(null)
    try {
      await api.assignReceiptTemplate(state.isDefault || state.templateId === null ? { outletIds } : { templateId: state.templateId, outletIds })
      await reload()
      setDialog(null)
    } catch (e: unknown) {
      setAssignError(e instanceof Error ? e.message : 'Gagal menyimpan outlet.')
    } finally {
      setAssignSaving(false)
    }
  }

  if (!loaded) {
    return loadError
      ? <p role="alert" className="text-sm font-bold text-danger">Gagal memuat template struk: {loadError}</p>
      : <p className="text-sm text-ink-700">Memuat template struk…</p>
  }

  const assignedNow = state.templateId === null ? standarOutletIds(templates, outlets.map((o) => o.id)) : (stored?.outletIds ?? [])
  const deleteBlockedBy = stored && stored.outletIds.length > 0 ? stored.outletIds.length : 0

  return (
    <>
      <StrukView
        state={state}
        dispatch={dispatch}
        templates={templates}
        showVirtualStandar={showVirtualStandar}
        unusable={unusable}
        selectedKey={selectedKey}
        usedBy={usedBy}
        notice={notice}
        saving={saving}
        addOpen={addOpen}
        onToggleAdd={() => setAddOpen((v) => !v)}
        onSelect={onSelect}
        onNew={() => setDialog('new')}
        onDuplicate={() => setDialog('duplicate')}
        onRename={() => setDialog('rename')}
        onDelete={() => { setDeleteError(null); setDialog('delete') }}
        onAssign={() => { setAssignError(null); setDialog('assign') }}
        onSave={() => void onSave()}
        onReload={() => void onReloadServerCopy()}
      />

      <NameDialog
        open={dialog === 'new'} title="Template baru" confirmLabel="Buat" initial=""
        onClose={() => setDialog(null)}
        onConfirm={(name) => { setDialog(null); guarded(() => { dispatch({ type: 'newTemplate', name, paperWidth: state.layout.paperWidth }); setNotice(null) }) }}
      />
      <NameDialog
        open={dialog === 'duplicate'} title="Duplikat template" confirmLabel="Duplikat" initial={`${state.name} (salinan)`.slice(0, 60)}
        onClose={() => setDialog(null)}
        onConfirm={(name) => { dispatch({ type: 'duplicate', name }); setNotice(null); setDialog(null) }}
      />
      <NameDialog
        open={dialog === 'rename'} title="Ganti nama template" confirmLabel="Simpan nama" initial={state.name}
        onClose={() => setDialog(null)}
        onConfirm={(name) => { dispatch({ type: 'rename', name }); setDialog(null) }}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        title={`Hapus template "${state.name}"?`}
        consequence={deleteBlockedBy > 0 ? inUseCopy(deleteBlockedBy) : 'Template ini dihapus permanen.'}
        confirmLabel="Hapus template"
        tone="danger"
        error={deleteError}
        onConfirm={() => (deleteBlockedBy > 0 ? setDialog(null) : onDelete())}
        onCancel={() => setDialog(null)}
      />
      <AssignOutletsDialog
        open={dialog === 'assign'}
        outlets={outlets}
        assigned={assignedNow}
        isStandar={state.templateId === null || state.isDefault}
        saving={assignSaving}
        error={assignError}
        onSave={(ids) => void onAssign(ids)}
        onClose={() => setDialog(null)}
      />

      <ConfirmDialog
        open={pending !== null}
        title="Buang perubahan desain struk?"
        consequence="Ada perubahan yang belum disimpan. Kalau dilanjutkan, perubahan ini hilang."
        confirmLabel="Buang perubahan"
        cancelLabel="Tetap di sini"
        tone="danger"
        onConfirm={() => { const p = pending; setPending(null); p?.run() }}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={leaveAsk !== null}
        title="Buang perubahan desain struk?"
        consequence="Desain struk belum disimpan. Kalau ditinggalkan, perubahan ini hilang."
        confirmLabel="Buang & lanjut"
        cancelLabel="Tetap di sini"
        tone="danger"
        onConfirm={() => answerLeave(true)}
        onCancel={() => answerLeave(false)}
      />
    </>
  )
}
