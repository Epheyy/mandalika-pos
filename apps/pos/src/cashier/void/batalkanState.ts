import type { components } from '@mandalika/api'
import { voidReasonProblem, type VoidReasonCode } from './voidRules'

type VoidPreview = components['schemas']['VoidPreview']

export type StockChoice = 'restock' | 'skip_counted'

/** What the Batalkan sheet collects. `stockChoices` holds one entry per counted line (keyed by the sale movement key). */
export interface BatalkanState {
  reason: VoidReasonCode | null
  note: string
  choice: 'perbaiki' | 'saja'
  stockChoices: Record<string, StockChoice>
}

export interface BatalkanInput {
  reason: VoidReasonCode
  note: string
  choice: 'perbaiki' | 'saja'
  stockChoices: Record<string, StockChoice>
}

/** The lines an approved stock count already covered after the sale (a choice is required for each). */
export const countedLines = (preview: VoidPreview | null): VoidPreview['lines'] => (preview?.lines ?? []).filter((l) => l.countedAfter)

/** Default: "Batalkan & perbaiki", no reason yet, every counted line "kembalikan stok". Offline (no preview) sends no choice. */
export function initialBatalkan(preview: VoidPreview | null): BatalkanState {
  return {
    reason: null,
    note: '',
    choice: 'perbaiki',
    stockChoices: Object.fromEntries(countedLines(preview).map((l) => [l.key, 'restock' as StockChoice])),
  }
}

export const setStockChoice = (s: BatalkanState, key: string, choice: StockChoice): BatalkanState => ({
  ...s,
  stockChoices: { ...s.stockChoices, [key]: choice },
})

/** The sheet's result, or null while it cannot be confirmed (no reason / short note / the server says not eligible).
 *  Stock choices are rebuilt from the preview so every counted line has one (default restock), never a stale key. */
export function batalkanInput(s: BatalkanState, preview: VoidPreview | null): BatalkanInput | null {
  if (preview && !preview.eligible) return null
  if (voidReasonProblem(s.reason, s.note) !== null || !s.reason) return null
  const stockChoices = Object.fromEntries(countedLines(preview).map((l) => [l.key, s.stockChoices[l.key] ?? ('restock' as StockChoice)]))
  return { reason: s.reason, note: s.note.trim(), choice: s.choice, stockChoices }
}
