import { ApiError, type ReceiptTemplate, type ReceiptTemplateAssignInput } from '@mandalika/api'
import { layoutFromApi, validateTemplate, type ReceiptBlock } from '@mandalika/printer/render'
import { toBody, type CompatAdjustment, type DesignerState } from './designerReducer'

// Pure helpers around the template API: what the screen lists, what it warns about, and how a save ends.

export const STALE_SAVE_COPY = 'Template ini sudah diubah di tempat lain. Muat ulang lalu ulangi.'
export const STANDAR_DELETE_COPY = 'Template Standar tidak bisa dihapus.'
export const UNUSABLE_TEMPLATE_COPY = 'Tablet tidak bisa memakai template ini; tablet mencetak Standar.'
export const ADJUSTED_NOTICE = 'Disesuaikan agar bisa dicetak:'

export const inUseCopy = (n: number): string => `Template masih dipakai di ${n} outlet. Pindahkan outletnya dulu.`

/** The slice of the API client the designer uses (a fake in tests). */
export interface TemplateApi {
  createReceiptTemplate: (input: ReturnType<typeof toBody>) => Promise<ReceiptTemplate>
  updateReceiptTemplate: (id: string, input: ReturnType<typeof toBody>) => Promise<ReceiptTemplate>
  deleteReceiptTemplate: (id: string) => Promise<void>
  assignReceiptTemplate: (input: ReceiptTemplateAssignInput) => Promise<void>
}

/** Ids of stored templates the tablet would refuse (it then prints Standar). The Backoffice shows a warning. */
export function unusableTemplateIds(templates: readonly ReceiptTemplate[]): Set<string> {
  return new Set(templates.filter((t) => layoutFromApi(t) === null).map((t) => t.id))
}

/** True when the designer has no saved Standar yet, so Standar is shown as a virtual entry built from settings. */
export const needsVirtualStandar = (templates: readonly ReceiptTemplate[]): boolean => !templates.some((t) => t.isDefault)

/** Outlets that print the virtual Standar: those no listed template claims. */
export function standarOutletIds(templates: readonly ReceiptTemplate[], outletIds: readonly string[]): string[] {
  const claimed = new Set(templates.flatMap((t) => t.outletIds))
  return outletIds.filter((id) => !claimed.has(id))
}

export type SaveResult =
  | { kind: 'ok'; template: ReceiptTemplate }
  | { kind: 'invalid'; message: string }
  | { kind: 'stale' }
  | { kind: 'error'; message: string }

const errorMessage = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Gagal menyimpan template.')

/** Saves the design: create for an unsaved one, update with the loaded version otherwise. A 409 is "stale". */
export async function saveDesign(api: TemplateApi, state: DesignerState): Promise<SaveResult> {
  const body = toBody(state)
  // The server and the tablet are the guards; this only spares a round trip for what the shared validator knows.
  const [first] = validateTemplate({ name: body.name, paperWidth: body.paperWidth, blocks: body.blocks as unknown as ReceiptBlock[] })
  if (first) return { kind: 'invalid', message: first.message }
  try {
    const template = state.templateId === null
      ? await api.createReceiptTemplate(body)
      : await api.updateReceiptTemplate(state.templateId, body)
    return { kind: 'ok', template }
  } catch (e) {
    // The server sends 409 for a stale version, a taken name, a second Standar and the 50 template cap; only the first
    // is "stale". The others carry their own message.
    if (e instanceof ApiError && e.status === 409 && state.templateId !== null && e.message === STALE_SAVE_COPY) return { kind: 'stale' }
    return { kind: 'error', message: errorMessage(e) }
  }
}

/** One line per thing `fromCompat` changed, for the "Disesuaikan agar bisa dicetak:" notice. */
export function describeAdjustment(a: CompatAdjustment): string {
  switch (a.kind) {
    case 'replaced_chars': return `Karakter tak bisa dicetak diganti: "${a.before.slice(0, 40)}" jadi "${a.after.slice(0, 40)}"`
    case 'clipped_chars': return `Teks dipotong jadi ${[...a.after].length} karakter`
    case 'clipped_lines': return `Teks dipotong jadi ${a.after.split('\n').length} baris`
    case 'change_locked': return 'Kembalian selalu tercetak'
  }
}
