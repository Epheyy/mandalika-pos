import type { StockRequisition } from '@mandalika/api'
import {
  buildInput, createDraft, submitDraft, updateDraft,
  type FlowDeps, type FlowKind, type RequisitionFormState,
} from './requisitionFlow'
import type { RequisitionKeys } from './requisitionKeys'

// "Simpan Draf" / "Simpan & Ajukan": the form's save, kept out of the component so the key and
// ordering rules (create persisted key, create then submit, a failed submit leaves a draft) are tested.

export type SaveOutcome =
  /** Saved (and submitted when asked). */
  | { kind: 'saved'; pb: StockRequisition }
  /** The draft exists but "Ajukan" did not go through; the cashier can press Ajukan on the draft. */
  | { kind: 'draftOnly'; pb: StockRequisition; failure: FlowKind; message: string }
  /** Nothing was saved; the form keeps its content. */
  | { kind: 'failed'; failure: FlowKind; message: string }

export interface SaveRequest {
  deps: FlowDeps
  keys: RequisitionKeys
  /** The draft being edited; null/undefined creates a new one. */
  editing?: Pick<StockRequisition, 'id'> | null
  form: RequisitionFormState
  andSubmit: boolean
}

const SUBMIT_SIG = 'submit'

export async function saveRequisition(req: SaveRequest): Promise<SaveOutcome> {
  const built = buildInput(req.form)
  if (!built.ok) return { kind: 'failed', failure: 'invalid', message: built.message }
  const { deps, keys, editing } = req
  const sig = JSON.stringify({ draftId: editing?.id ?? null, input: built.input })

  let saved
  if (editing) {
    saved = await updateDraft(deps, editing.id, built.input, keys.keyFor('update', editing.id, sig))
    if (saved.kind === 'keyConflict') keys.forget('update', editing.id)
    else if (saved.kind === 'ok') keys.forget('update', editing.id)
  } else {
    saved = await createDraft(deps, built.input, await keys.createKey(sig, req.form))
    if (saved.kind === 'keyConflict') await keys.renewCreateKey(sig, req.form)
    else if (saved.kind === 'ok') await keys.clearPendingCreate()
  }
  if (saved.kind !== 'ok') return { kind: 'failed', failure: saved.kind, message: saved.message }
  if (!req.andSubmit) return { kind: 'saved', pb: saved.value }
  return submitSaved(req, saved.value)
}

/** Submit a draft by id (also the "Ajukan" button on the detail). */
export async function submitRequisitionById(deps: FlowDeps, keys: RequisitionKeys, id: string) {
  const r = await submitDraft(deps, id, keys.keyFor('submit', id, SUBMIT_SIG))
  if (r.kind === 'ok' || r.kind === 'keyConflict') keys.forget('submit', id)
  return r
}

async function submitSaved(req: SaveRequest, pb: StockRequisition): Promise<SaveOutcome> {
  const r = await submitRequisitionById(req.deps, req.keys, pb.id)
  if (r.kind === 'ok') return { kind: 'saved', pb: r.value }
  return { kind: 'draftOnly', pb, failure: r.kind, message: r.message }
}
