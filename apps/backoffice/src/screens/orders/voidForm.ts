import { ApiError } from '@mandalika/api'
import type { Api, Order, VoidOrderRequest } from '@mandalika/api'
import {
  VOID_NOTE_MAX, VOID_NOTE_MIN_LAINNYA, VOID_NOTE_REQUIRED, type VoidReasonCode,
} from '../../lib/labels/void'

/** What the Backoffice offers: void only, void and fix payment/customer in one go, or void and make the replacement in the POS. */
export type VoidChoice = 'saja' | 'perbaiki' | 'pengganti_pos'

export type TenderInput = NonNullable<NonNullable<VoidOrderRequest['replacement']>['tenders']>[number]
export type StockChoice = 'restock' | 'skip_counted'
type PreviewLine = Awaited<ReturnType<Api['getVoidPreview']>>['lines'][number]

export const VOID_CHOICES: readonly { value: VoidChoice; label: string }[] = [
  { value: 'perbaiki', label: 'Batalkan & perbaiki' },
  { value: 'saja', label: 'Batalkan saja' },
  { value: 'pengganti_pos', label: 'Batalkan, pengganti dibuat di POS' },
]

const MODE_OF: Record<VoidChoice, VoidOrderRequest['mode']> = { saja: 'none', perbaiki: 'replace', pengganti_pos: 'later' }

export interface VoidFormValues {
  reason: VoidReasonCode | null
  note: string
  choice: VoidChoice
  /** Payment lines of the replacement; only read for `perbaiki`. */
  tenders: TenderInput[]
  originalTotal: number
  /** A customer other than the original's; only for `perbaiki`. */
  customerId?: string
  stockChoices?: Record<string, StockChoice>
}

const runes = (s: string): number => [...s].length
const rupiah = (n: number): string => `Rp ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(n)}`

/** First thing wrong with the form, or null. The server re-checks every rule. */
export function voidFormProblem(f: VoidFormValues): string | null {
  if (!f.reason) return 'Pilih alasan pembatalan.'
  const note = f.note.trim()
  if (runes(note) > VOID_NOTE_MAX) return `Catatan paling banyak ${VOID_NOTE_MAX} karakter.`
  if (f.reason === 'lainnya' && runes(note) < VOID_NOTE_MIN_LAINNYA) return VOID_NOTE_REQUIRED
  if (f.choice !== 'perbaiki') return null
  if (f.tenders.length === 0 || f.tenders.some((t) => !t.method.trim() || !(t.amount > 0))) {
    return 'Isi metode dan jumlah pada tiap baris pembayaran.'
  }
  const sum = f.tenders.reduce((n, t) => n + t.amount, 0)
  if (Math.round(sum) !== Math.round(f.originalTotal)) {
    return `Jumlah pembayaran pengganti harus sama dengan yang diterima (${rupiah(Math.round(f.originalTotal))}).`
  }
  return null
}

/** The API body. Never carries items: a replacement keeps the original's lines. */
export function voidRequestBody(f: VoidFormValues, clientVoidUuid: string): VoidOrderRequest {
  const note = f.note.trim()
  const body: VoidOrderRequest = {
    reasonCode: f.reason as VoidReasonCode,
    clientVoidUuid,
    mode: MODE_OF[f.choice],
  }
  if (note) body.note = note
  if (f.stockChoices && Object.keys(f.stockChoices).length > 0) body.stockChoices = f.stockChoices
  if (f.choice === 'perbaiki') {
    body.replacement = { tenders: f.tenders, ...(f.customerId ? { customerId: f.customerId } : {}) }
  }
  return body
}

export async function submitVoid(
  api: Pick<Api, 'voidOrder'>, id: string, body: VoidOrderRequest,
): Promise<{ ok: true; order: Order } | { ok: false; message: string }> {
  try {
    return { ok: true, order: await api.voidOrder(id, body) }
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status > 0 && e.message) return { ok: false, message: e.message }
    return { ok: false, message: 'Pembatalan belum terkirim. Cek koneksi, lalu coba lagi; pembatalan yang sama tidak akan tercatat dua kali.' }
  }
}

/** Replay key: one uuid per distinct form, reused when the same form is submitted again. */
export interface VoidAttempt { key: string; uuid: string }

export function voidAttemptKey(f: VoidFormValues): string {
  return JSON.stringify([f.reason, f.note.trim(), f.choice, f.choice === 'perbaiki' ? f.tenders : null, f.choice === 'perbaiki' ? f.customerId ?? null : null, f.stockChoices ?? null])
}

export function nextVoidAttempt(prev: VoidAttempt | null, key: string, newUuid: () => string): VoidAttempt {
  return prev?.key === key ? prev : { key, uuid: newUuid() }
}

/** `perbaiki` rebuilds the sale through the server's normal path, which the Backoffice cannot do for bundle lines. */
export function bundleBlocksPerbaiki(order: Pick<Order, 'items'>): boolean {
  return order.items.some((i) => i.bundleGroup != null)
}

/** The original payment lines (lowest seq first), or one line for an order stored before split payment. */
export function tendersFromOrder(order: Pick<Order, 'tenders' | 'paymentMethod' | 'total'>): TenderInput[] {
  const lines = [...(order.tenders ?? [])].sort((a, b) => a.seq - b.seq)
  if (lines.length === 0) return [{ method: order.paymentMethod, amount: order.total }]
  return lines.map((t) => ({ method: t.method, amount: t.amount }))
}

/** A choice for every line a stock count already covered (restock unless the user said the count did it). */
export function countedChoices(lines: readonly Pick<PreviewLine, 'key' | 'countedAfter'>[], picks: Record<string, StockChoice>): Record<string, StockChoice> {
  const out: Record<string, StockChoice> = {}
  for (const l of lines) if (l.countedAfter) out[l.key] = picks[l.key] ?? 'restock'
  return out
}
