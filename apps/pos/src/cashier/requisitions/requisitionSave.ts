import type { StockRequisition, StockRequisitionInput } from '@mandalika/api'
import {
  buildInput, cancelRequisition, createDraft, submitDraft, updateDraft,
  type FlowDeps, type FlowKind, type RequisitionFormState,
} from './requisitionFlow'
import type { RequisitionKeys } from './requisitionKeys'

// "Simpan Draf" / "Simpan & Ajukan": the form's save, kept out of the component so the key and ordering
// rules are tested. The central rule (a create whose answer was lost is UNCONFIRMED): the next save,
// whatever the form now says, first re-sends the OLD input with the OLD key. The server then replays the
// PB it created, or creates it exactly once; only after that is a changed form applied, as an update of
// that PB. So a lost response plus an edit can never make two PBs.

export type SaveOutcome =
  /** Saved (and submitted when asked). */
  | { kind: 'saved'; pb: StockRequisition }
  /** The draft exists but a later step (applying the edit, or "Ajukan") did not go through. */
  | { kind: 'draftOnly'; pb: StockRequisition; step: 'update' | 'submit'; failure: FlowKind; message: string }
  /** Nothing new was saved; the form keeps its content. */
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
const CANCEL_SIG = 'cancel'
const sameInput = (a: StockRequisitionInput, b: StockRequisitionInput): boolean => JSON.stringify(a) === JSON.stringify(b)

export async function saveRequisition(req: SaveRequest): Promise<SaveOutcome> {
  const built = buildInput(req.form)
  if (!built.ok) return { kind: 'failed', failure: 'invalid', message: built.message }
  if (req.editing) return saveEdit(req, req.editing.id, built.input)
  return saveNew(req, built.input)
}

async function saveEdit(req: SaveRequest, id: string, input: StockRequisitionInput): Promise<SaveOutcome> {
  const { deps, keys } = req
  const sig = JSON.stringify({ draftId: id, input })
  const r = await updateDraft(deps, id, input, keys.keyFor('update', id, sig))
  if (r.kind === 'keyConflict' || r.kind === 'ok') keys.forget('update', id)
  if (r.kind !== 'ok') return { kind: 'failed', failure: r.kind, message: r.message }
  return finish(req, r.value)
}

async function saveNew(req: SaveRequest, input: StockRequisitionInput): Promise<SaveOutcome> {
  const { deps, keys } = req
  const pending = keys.loadPendingCreate()
  if (pending?.sent) {
    // Resolve the unconfirmed create first: same key, same body.
    const r = await createDraft(deps, pending.input, pending.key)
    if (r.kind === 'ok') {
      await keys.clearPendingCreate()
      return applyChange(req, r.value, pending.input, input)
    }
    if (r.kind === 'invalid' || r.kind === 'keyConflict') await keys.clearPendingCreate() // nothing exists: start fresh below
    else return { kind: 'failed', failure: r.kind, message: r.message } // still unconfirmed: keep the record
  }
  const key = await keys.beginCreate(JSON.stringify(input), input, req.form)
  const r = await createDraft(deps, input, key)
  if (r.kind === 'ok') {
    await keys.clearPendingCreate()
    return finish(req, r.value)
  }
  if (r.kind === 'offline') await keys.markCreateUnsent() // the request never left
  else if (r.kind === 'invalid' || r.kind === 'keyConflict') await keys.clearPendingCreate() // definitively not created
  return { kind: 'failed', failure: r.kind, message: r.message }
}

/** The resolved PB was created from `old`; if the form now says something else, update it (its own key). */
async function applyChange(req: SaveRequest, pb: StockRequisition, old: StockRequisitionInput, now: StockRequisitionInput): Promise<SaveOutcome> {
  if (sameInput(old, now)) return finish(req, pb)
  const sig = JSON.stringify({ draftId: pb.id, input: now })
  const r = await updateDraft(req.deps, pb.id, now, req.keys.keyFor('update', pb.id, sig))
  if (r.kind === 'ok' || r.kind === 'keyConflict') req.keys.forget('update', pb.id)
  if (r.kind !== 'ok') {
    return { kind: 'draftOnly', pb, step: 'update', failure: r.kind, message: `Draf tersimpan, tetapi perubahan terakhir belum diterapkan. ${r.message}` }
  }
  return finish(req, r.value)
}

async function finish(req: SaveRequest, pb: StockRequisition): Promise<SaveOutcome> {
  if (!req.andSubmit) return { kind: 'saved', pb }
  const r = await submitRequisitionById(req.deps, req.keys, pb.id)
  if (r.kind === 'ok') return { kind: 'saved', pb: r.value }
  return { kind: 'draftOnly', pb, step: 'submit', failure: r.kind, message: r.message }
}

/** Submit a draft by id (also the "Ajukan" button on the detail). */
export async function submitRequisitionById(deps: FlowDeps, keys: RequisitionKeys, id: string) {
  const r = await submitDraft(deps, id, keys.keyFor('submit', id, SUBMIT_SIG))
  if (r.kind === 'ok' || r.kind === 'keyConflict') keys.forget('submit', id)
  return r
}

/** Cancel by id (the detail's "Batalkan Permintaan"). */
export async function cancelRequisitionById(deps: FlowDeps, keys: RequisitionKeys, id: string) {
  const r = await cancelRequisition(deps, id, keys.keyFor('cancel', id, CANCEL_SIG))
  if (r.kind === 'ok' || r.kind === 'keyConflict') keys.forget('cancel', id)
  return r
}

export type DiscardOutcome =
  | { kind: 'discarded' }
  /** The unconfirmed create turned out to exist and was cancelled. */
  | { kind: 'cancelled'; pb: StockRequisition }
  /** The create exists but could not be cancelled; the cashier must handle this draft. */
  | { kind: 'draftExists'; pb: StockRequisition; message: string }
  /** Could not find out whether a PB exists (offline / no answer): nothing is dropped. */
  | { kind: 'unresolved'; failure: FlowKind; message: string }

/** "Buang isian": never silently drops a PB the server may have created. */
export async function discardPending(deps: FlowDeps, keys: RequisitionKeys): Promise<DiscardOutcome> {
  const pending = keys.loadPendingCreate()
  if (!pending?.sent) {
    await keys.clearPendingCreate()
    return { kind: 'discarded' }
  }
  const r = await createDraft(deps, pending.input, pending.key) // replay: returns the PB if it exists, else creates it exactly once
  if (r.kind === 'invalid' || r.kind === 'keyConflict') {
    await keys.clearPendingCreate() // definitively nothing exists
    return { kind: 'discarded' }
  }
  if (r.kind !== 'ok') return { kind: 'unresolved', failure: r.kind, message: r.message }
  await keys.clearPendingCreate()
  const c = await cancelRequisitionById(deps, keys, r.value.id)
  if (c.kind === 'ok') return { kind: 'cancelled', pb: c.value }
  return { kind: 'draftExists', pb: r.value, message: `Draf ${r.value.number} sudah tersimpan di server dan belum dibatalkan. ${c.message}` }
}
