import type { StockRequisition, StockRequisitionInput } from '@mandalika/api'
import {
  buildInput, cancelRequisition, createDraft, loadRequisition, submitDraft, updateDraft,
  type FlowDeps, type FlowKind, type RequisitionFormState,
} from './requisitionFlow'
import type { RequisitionKeys } from './requisitionKeys'

// "Simpan Draf" / "Simpan & Ajukan": the form's save, kept out of the component so the key and ordering
// rules are tested.
//
// A create whose answer was lost is UNCONFIRMED. The next save (or the panel opening online) first re-sends
// the OLD input with the OLD key; the server replays the PB it created, or creates it exactly once. Rules:
//  - A resolve never falls through to a fresh create in the same call. A key conflict PROVES a committed
//    receipt exists (a failed effect rolls its claim back), so it means "the PB may already be saved".
//  - The record is cleared only on success, on that key conflict, or on a JSON 400/422 domain refusal (the
//    claim rolled back: nothing was created). 401, other 4xx, timeouts and 5xx keep it.
//  - Before a changed form is applied (update) or a discard cancels, the replayed PB is refetched and must
//    still be an unchanged draft; otherwise it is opened and nothing is overwritten or cancelled.

export const MAYBE_SAVED_MESSAGE = 'Permintaan mungkin sudah tersimpan — cek daftar permintaan.'

export type SaveOutcome =
  /** Saved (and submitted when asked). */
  | { kind: 'saved'; pb: StockRequisition }
  /** The draft exists but a later step (applying the edit, or "Ajukan") did not go through. */
  | { kind: 'draftOnly'; pb: StockRequisition; step: 'update' | 'submit'; failure: FlowKind; message: string }
  /** The PB from an earlier attempt exists but was submitted, changed, or could not be re-checked: nothing was overwritten. */
  | { kind: 'foundChanged'; pb: StockRequisition; message: string }
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

export type ResolveOutcome =
  | { kind: 'none' }
  /** The unconfirmed create exists as `pb`; the record is cleared. */
  | { kind: 'resolved'; pb: StockRequisition }
  /** Key conflict: a receipt exists, so a PB may already be saved; the record is cleared. */
  | { kind: 'maybeSaved'; message: string }
  /** A JSON 400/422 refusal: nothing was created; the record is cleared. */
  | { kind: 'refused'; message: string }
  /** No usable answer (offline, timeout, 401, other 4xx ...): the record is kept. */
  | { kind: 'blocked'; failure: FlowKind; message: string }

/** Re-send the pending create (same key, same body) when there is an unconfirmed one. */
export async function resolvePendingCreate(deps: FlowDeps, keys: RequisitionKeys): Promise<ResolveOutcome> {
  const pending = keys.loadPendingCreate()
  if (!pending?.sent) return { kind: 'none' }
  const r = await createDraft(deps, pending.input, pending.key)
  if (r.kind === 'ok') {
    await keys.clearPendingCreate()
    return { kind: 'resolved', pb: r.value }
  }
  if (r.kind === 'keyConflict') {
    await keys.clearPendingCreate()
    return { kind: 'maybeSaved', message: MAYBE_SAVED_MESSAGE }
  }
  if (r.kind === 'invalid') {
    await keys.clearPendingCreate()
    return { kind: 'refused', message: r.message }
  }
  return { kind: 'blocked', failure: r.kind, message: r.message }
}

async function saveNew(req: SaveRequest, input: StockRequisitionInput): Promise<SaveOutcome> {
  const { deps, keys } = req
  const pending = keys.loadPendingCreate()
  if (pending?.sent) {
    const res = await resolvePendingCreate(deps, keys)
    // Never a fresh create in the same call: the cashier saves again, and that is a new document.
    if (res.kind === 'resolved') return applyChange(req, res.pb, pending.input, input)
    if (res.kind === 'maybeSaved') return { kind: 'failed', failure: 'keyConflict', message: res.message }
    if (res.kind === 'refused') return { kind: 'failed', failure: 'invalid', message: res.message }
    if (res.kind === 'blocked') return { kind: 'failed', failure: res.failure, message: res.message }
  }
  const key = await keys.beginCreate(JSON.stringify(input), input, req.form)
  const r = await createDraft(deps, input, key)
  if (r.kind === 'ok') {
    await keys.clearPendingCreate()
    return finish(req, r.value)
  }
  if (r.kind === 'offline') await keys.markCreateUnsent() // the request never left
  else if (r.kind === 'invalid') await keys.clearPendingCreate() // JSON domain refusal: nothing was created
  else if (r.kind === 'keyConflict') {
    await keys.clearPendingCreate()
    return { kind: 'failed', failure: 'keyConflict', message: MAYBE_SAVED_MESSAGE }
  }
  return { kind: 'failed', failure: r.kind, message: r.message }
}

type Verified =
  | { ok: true; pb: StockRequisition }
  | { ok: false; why: 'changed'; pb: StockRequisition }
  | { ok: false; why: 'unchecked'; failure: FlowKind; message: string }

/** Refetch a replayed PB: it must still be a draft, unchanged since the replay. */
async function verifyDraft(deps: FlowDeps, replayed: StockRequisition): Promise<Verified> {
  const r = await loadRequisition(deps, replayed.id)
  if (r.kind !== 'ok') return { ok: false, why: 'unchecked', failure: r.kind, message: r.message }
  const now = r.value
  const moved = replayed.updatedAt && now.updatedAt && now.updatedAt !== replayed.updatedAt
  if (now.status !== 'draft' || moved) return { ok: false, why: 'changed', pb: now }
  return { ok: true, pb: now }
}

const changedMessage = (pb: StockRequisition, action: string): string =>
  `Permintaan ${pb.number} sudah tersimpan dari percobaan sebelumnya dan sudah diajukan atau berubah. ${action}`

/** The resolved PB was created from `old`; if the form now says something else, update it (its own key). */
async function applyChange(req: SaveRequest, pb: StockRequisition, old: StockRequisitionInput, now: StockRequisitionInput): Promise<SaveOutcome> {
  const v = await verifyDraft(req.deps, pb)
  if (!v.ok && v.why === 'changed') return { kind: 'foundChanged', pb: v.pb, message: changedMessage(v.pb, 'Perubahan Anda belum diterapkan.') }
  if (!v.ok) {
    // Unverified: do NOT hand the cashier an edit form on this PB (a later save would overwrite without a check).
    // Open it as it is; they can press Ubah once it loads.
    return { kind: 'foundChanged', pb, message: `Draf ${pb.number} tersimpan dari percobaan sebelumnya, tetapi belum bisa diperiksa; perubahan Anda belum diterapkan. ${v.message}` }
  }
  if (sameInput(old, now)) return finish(req, v.pb)
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
  /** The unconfirmed create turned out to exist, was still an untouched draft, and was cancelled. */
  | { kind: 'cancelled'; pb: StockRequisition }
  /** The create exists but was not cancelled (it changed, or the cancel failed): the cashier handles this PB. */
  | { kind: 'draftExists'; pb: StockRequisition; message: string }
  /** Key conflict: a PB may already be saved. Nothing was cancelled; the record is cleared. */
  | { kind: 'maybeSaved'; message: string }
  /** Could not find out whether a PB exists (offline / no answer): nothing is dropped. */
  | { kind: 'unresolved'; failure: FlowKind; message: string }

/** "Buang isian": never silently drops a PB the server may have created, and never cancels one that moved on. */
export async function discardPending(deps: FlowDeps, keys: RequisitionKeys): Promise<DiscardOutcome> {
  const res = await resolvePendingCreate(deps, keys)
  if (res.kind === 'none') {
    await keys.clearPendingCreate()
    return { kind: 'discarded' }
  }
  if (res.kind === 'refused') return { kind: 'discarded' } // JSON refusal: nothing exists
  if (res.kind === 'maybeSaved') return { kind: 'maybeSaved', message: res.message }
  if (res.kind === 'blocked') return { kind: 'unresolved', failure: res.failure, message: res.message }
  const v = await verifyDraft(deps, res.pb)
  if (!v.ok && v.why === 'changed') return { kind: 'draftExists', pb: v.pb, message: changedMessage(v.pb, 'Tidak dibatalkan.') }
  if (!v.ok) return { kind: 'draftExists', pb: res.pb, message: `Draf ${res.pb.number} sudah tersimpan di server dan belum dibatalkan. ${v.message}` }
  // Known, accepted window (a few ms): another device could submit this PB between the check above and this
  // cancel, and the server allows cancelling a submitted PB. The server has no compare-and-set on status here.
  const c = await cancelRequisitionById(deps, keys, res.pb.id)
  if (c.kind === 'ok') return { kind: 'cancelled', pb: c.value }
  return { kind: 'draftExists', pb: res.pb, message: `Draf ${res.pb.number} sudah tersimpan di server dan belum dibatalkan. ${c.message}` }
}

/**
 * "Buang tanpa cek": the way out of a pending create stuck on a permanent cause (403, 404 feature off, 413, a
 * non-JSON 4xx, a non-key 409). It only forgets the record; it does NOT cancel anything the server may hold, so
 * the panel warns the cashier to check the list first.
 */
export async function forceDiscardPending(keys: RequisitionKeys): Promise<void> {
  await keys.clearPendingCreate()
}
