import { ApiError } from '@mandalika/api'
import type { Api, ListRequisitionsParams, ListResult, RequestOptions, StockRequisition, StockRequisitionInput } from '@mandalika/api'

// Permintaan Barang is online-only: every call goes straight through api.* and is never queued
// (the outbox / SyncEngine are not involved). Pure and deps-injected, it never throws: every outcome
// of the plan's section 3 is a value the screens render. Modelled on receive/receiveApprovalFlow.ts.

export const REQUEST_TIMEOUT_MS = 20_000
const REQ_OPTS: RequestOptions = { timeoutMs: REQUEST_TIMEOUT_MS }

export const OFFLINE_MESSAGE = 'Permintaan Barang butuh koneksi internet.'
export const RETRY_MESSAGE = 'Server belum menjawab. Tekan Coba Lagi — permintaan tidak akan tercatat dua kali.'
export const FORBIDDEN_MESSAGE = 'Akun ini belum punya izin Permintaan Barang. Minta admin menambahkan izin.'
export const NOT_FOUND_MESSAGE = 'Permintaan tidak ditemukan.'
export const FEATURE_OFF_MESSAGE = 'Fitur Permintaan Barang belum aktif di server.'
export const STALE_MESSAGE = 'Status permintaan sudah berubah. Menampilkan data terbaru.'
export const KEY_CONFLICT_MESSAGE = 'Permintaan ini berubah saat dikirim. Simpan lagi.'

export type FlowKind = 'offline' | 'retry' | 'stale' | 'gone' | 'forbidden' | 'invalid' | 'keyConflict'
export type FlowResult<T> = { kind: 'ok'; value: T } | { kind: FlowKind; message: string }

export type RequisitionApi = Pick<
  Api,
  'listRequisitions' | 'getRequisition' | 'createRequisition' | 'updateRequisition' | 'submitRequisition' | 'cancelRequisition'
>
export interface FlowDeps { isOnline: () => boolean; api: RequisitionApi }

type Op = 'list' | 'get' | 'write'

const KEY_CONFLICT_PREFIX = 'kunci idempotensi'

/** Map a thrown failure to an outcome. 409 splits on the server text: key reuse vs. a state refusal. */
export function mapFailure(e: unknown, op: Op): { kind: FlowKind; message: string } {
  if (!(e instanceof ApiError)) return { kind: 'retry', message: RETRY_MESSAGE }
  if (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'invalid_response' || e.status === 0) {
    return { kind: 'retry', message: RETRY_MESSAGE }
  }
  if (e.status >= 500 || e.status === 429) return { kind: 'retry', message: RETRY_MESSAGE }
  if (e.status === 409) {
    return e.message.toLowerCase().startsWith(KEY_CONFLICT_PREFIX)
      ? { kind: 'keyConflict', message: KEY_CONFLICT_MESSAGE }
      : { kind: 'stale', message: STALE_MESSAGE }
  }
  if (e.status === 404) return { kind: 'gone', message: op === 'list' ? FEATURE_OFF_MESSAGE : NOT_FOUND_MESSAGE }
  if (e.status === 403) return { kind: 'forbidden', message: FORBIDDEN_MESSAGE }
  return { kind: 'invalid', message: e.message }
}

async function run<T>(deps: FlowDeps, op: Op, call: () => Promise<T>): Promise<FlowResult<T>> {
  if (!deps.isOnline()) return { kind: 'offline', message: OFFLINE_MESSAGE }
  try {
    return { kind: 'ok', value: await call() }
  } catch (e) {
    return mapFailure(e, op)
  }
}

/** The list is always pinned to this outlet: a manage_inventory / admin user on the tablet would otherwise see every outlet's submitted PBs. */
export function loadRequisitions(
  deps: FlowDeps,
  outletId: string,
  filter: Omit<ListRequisitionsParams, 'outletId'> = {},
): Promise<FlowResult<ListResult<StockRequisition>>> {
  return run(deps, 'list', () => deps.api.listRequisitions({ ...filter, outletId }, REQ_OPTS))
}

export const loadRequisition = (deps: FlowDeps, id: string): Promise<FlowResult<StockRequisition>> =>
  run(deps, 'get', () => deps.api.getRequisition(id, REQ_OPTS))

export const createDraft = (deps: FlowDeps, input: StockRequisitionInput, key: string): Promise<FlowResult<StockRequisition>> =>
  run(deps, 'write', () => deps.api.createRequisition(input, key, REQ_OPTS))

export const updateDraft = (deps: FlowDeps, id: string, input: StockRequisitionInput, key: string): Promise<FlowResult<StockRequisition>> =>
  run(deps, 'write', () => deps.api.updateRequisition(id, input, key, REQ_OPTS))

export const submitDraft = (deps: FlowDeps, id: string, key: string): Promise<FlowResult<StockRequisition>> =>
  run(deps, 'write', () => deps.api.submitRequisition(id, key, REQ_OPTS))

export const cancelRequisition = (deps: FlowDeps, id: string, key: string): Promise<FlowResult<StockRequisition>> =>
  run(deps, 'write', () => deps.api.cancelRequisition(id, key, REQ_OPTS))

// ---- form -> input ------------------------------------------------------------------------

export interface FormLine { productId: string; productName: string; variantSize: string; sku?: string; qty: string }
export interface RequisitionFormState { lines: FormLine[]; neededBy: string; note: string; requestedBy: string }

export const EMPTY_FORM: RequisitionFormState = { lines: [], neededBy: '', note: '', requestedBy: '' }

export const lineKey = (l: { productId: string; variantSize: string }): string => `${l.productId}|${l.variantSize}`

export const MSG_NO_LINES = 'Tambahkan minimal satu barang.'
export const MSG_BAD_QTY = 'Qty harus bilangan bulat lebih dari 0.'
export const MSG_DUPLICATE = 'Barang ini sudah ada di daftar; ubah qty-nya saja.'

/** Optional "Diminta oleh" name goes at the start of the note (no schema change; the terminal account is the requester). */
export function composeNote(requestedBy: string, note: string): string | undefined {
  const by = requestedBy.trim()
  const body = note.trim()
  const text = by ? (body ? `Diminta oleh: ${by}\n${body}` : `Diminta oleh: ${by}`) : body
  return text || undefined
}

export type BuildResult = { ok: true; input: StockRequisitionInput } | { ok: false; message: string }

export function buildInput(form: RequisitionFormState): BuildResult {
  if (form.lines.length === 0) return { ok: false, message: MSG_NO_LINES }
  const seen = new Set<string>()
  for (const l of form.lines) {
    const k = lineKey(l)
    if (seen.has(k)) return { ok: false, message: MSG_DUPLICATE }
    seen.add(k)
  }
  const items = form.lines.map((l) => ({ productId: l.productId, variantSize: l.variantSize, requestedQty: Number(l.qty) }))
  if (items.some((i) => !Number.isInteger(i.requestedQty) || i.requestedQty <= 0)) return { ok: false, message: MSG_BAD_QTY }
  return { ok: true, input: { items, note: composeNote(form.requestedBy, form.note), neededBy: form.neededBy || undefined } }
}
