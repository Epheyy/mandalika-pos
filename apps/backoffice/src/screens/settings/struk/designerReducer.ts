import type { components, ReceiptTemplate, ReceiptTemplateInput } from '@mandalika/api'
import {
  NEW_TEMPLATE_BLOCKS, RECEIPT_LIMITS, isLockedType, layoutFromApi, standarLayout, toPrinterText,
  type PaperWidth, type ReceiptBlock, type ReceiptLayout,
} from '@mandalika/printer/render'

type ReceiptSettings = components['schemas']['ReceiptSettings']

// Designer state, all pure. The server and the tablet both enforce the locked rules; this only keeps the
// editor from offering a move the server would refuse.

export type CompatAdjustment = {
  blockId: string
  kind: 'replaced_chars' | 'clipped_chars' | 'clipped_lines' | 'change_locked'
  before: string
  after: string
}

export interface DesignerState {
  templateId: string | null
  name: string
  isDefault: boolean
  version: number | null
  layout: ReceiptLayout
  dirty: boolean
  /** The block whose editor is open. */
  editingId: string | null
  /** What `fromCompat` changed when Standar was first edited or saved. */
  adjustments: CompatAdjustment[]
}

export type AddableBlock = 'text' | 'divider' | 'points' | 'transaction' | 'header'

export type DesignerAction =
  | { type: 'load'; template: ReceiptTemplate }
  | { type: 'loadVirtualStandar'; settings: ReceiptSettings }
  | { type: 'newTemplate'; name: string; paperWidth: PaperWidth }
  | { type: 'duplicate'; name: string }
  | { type: 'toggle'; id: string }
  | { type: 'move'; from: number; to: number }
  | { type: 'edit'; id: string; patch: Partial<ReceiptBlock> }
  | { type: 'add'; block: AddableBlock }
  | { type: 'remove'; id: string }
  | { type: 'setWidth'; paperWidth: PaperWidth }
  | { type: 'rename'; name: string }
  | { type: 'select'; id: string | null }

const LOCKED_ORDER = ['items', 'totals', 'payment'] as const

/** True when items, totals and payment still keep their relative order. */
function lockedOrderHolds(blocks: readonly ReceiptBlock[]): boolean {
  const at = LOCKED_ORDER.map((t) => blocks.findIndex((b) => b.type === t))
  return at[0]! < at[1]! && at[1]! < at[2]!
}

const chars = (s: string): string[] => [...s]

/** Normalises and clips one stored text field, reporting what changed. */
function fitText(blockId: string, text: string, maxChars: number, maxLines: number, out: CompatAdjustment[]): string {
  let t = toPrinterText(text)
  if (t !== text) out.push({ blockId, kind: 'replaced_chars', before: text, after: t })
  const lines = t.split('\n')
  if (lines.length > maxLines) {
    const before = t
    t = lines.slice(0, maxLines).join('\n')
    out.push({ blockId, kind: 'clipped_lines', before, after: t })
  }
  if (chars(t).length > maxChars) {
    const before = t
    t = chars(t).slice(0, maxChars).join('')
    out.push({ blockId, kind: 'clipped_chars', before, after: t })
  }
  return t
}

/** The stored-template form of a layout: no `compat`, `spaceAfter`, `spaceBefore` or `payment.showChange`; the header
 *  title and every text block made printable and clipped to the limits (today's header and footer have none). */
export function fromCompat(layout: ReceiptLayout): { layout: ReceiptLayout; adjustments: CompatAdjustment[] } {
  const adjustments: CompatAdjustment[] = []
  const blocks = layout.blocks.map((b): ReceiptBlock => {
    if (b.type === 'header') {
      const { spaceAfter: _drop, ...rest } = b
      void _drop
      // The title is one line; a newline would fail validation.
      const text = fitText(b.id, b.text.replace(/\n/g, ' '), RECEIPT_LIMITS.titleMax, 1, adjustments)
      return { ...rest, text }
    }
    if (b.type === 'text') {
      const { spaceBefore: _drop, ...rest } = b
      void _drop
      return { ...rest, text: fitText(b.id, b.text, RECEIPT_LIMITS.textMax, RECEIPT_LIMITS.textLinesMax, adjustments) }
    }
    if (b.type === 'payment') {
      if (b.showChange === false) {
        adjustments.push({ blockId: b.id, kind: 'change_locked', before: 'Kembalian disembunyikan', after: 'Kembalian selalu tercetak' })
      }
      return { id: b.id, type: 'payment', enabled: true }
    }
    return b
  })
  return { layout: { paperWidth: layout.paperWidth, blocks }, adjustments }
}

/** Applies `fromCompat` once, before the first change to a layout that still carries `compat`. */
function leaveCompat(state: DesignerState): DesignerState {
  if (!state.layout.compat) return state
  const { layout, adjustments } = fromCompat(state.layout)
  return { ...state, layout, adjustments }
}

const withBlocks = (state: DesignerState, blocks: ReceiptBlock[]): DesignerState => ({
  ...state, layout: { ...state.layout, blocks }, dirty: true,
})

function freshBlock(kind: AddableBlock, id: string): ReceiptBlock {
  switch (kind) {
    case 'text': return { id, type: 'text', enabled: true, text: '', align: 'center', bold: false, size: 'normal' }
    case 'divider': return { id, type: 'divider', enabled: true }
    case 'points': return { id, type: 'points', enabled: true }
    case 'transaction': return { id, type: 'transaction', enabled: true, fields: ['orderNumber', 'date'], style: 'columns' }
    case 'header':
      return { id, type: 'header', enabled: true, text: '', size: 'large', showOutletName: true, showOutletAddress: false, showOutletPhone: false }
  }
}

function nextId(kind: string, blocks: readonly ReceiptBlock[]): string {
  const taken = new Set(blocks.map((b) => b.id))
  for (let n = 1; ; n++) {
    const id = `${kind}-${n}`
    if (!taken.has(id)) return id
  }
}

/** The patch without keys that would change a block's identity. */
function safePatch(patch: Partial<ReceiptBlock>): Record<string, unknown> {
  const { id: _id, type: _type, ...rest } = patch as Record<string, unknown>
  void _id; void _type
  const out: Record<string, unknown> = { ...rest }
  if (typeof out.text === 'string') out.text = toPrinterText(out.text)
  return out
}

export const NEW_STANDAR_NAME = 'Standar'

export function designerReducer(state: DesignerState, action: DesignerAction): DesignerState {
  switch (action.type) {
    case 'load': {
      // A template the tablet would refuse still opens, so it can be repaired; the screen warns about it.
      const layout = layoutFromApi(action.template)
        ?? { paperWidth: action.template.paperWidth, blocks: action.template.blocks as unknown as ReceiptBlock[] }
      return {
        templateId: action.template.id, name: action.template.name, isDefault: action.template.isDefault,
        version: action.template.version, layout, dirty: false, editingId: null, adjustments: [],
      }
    }
    case 'loadVirtualStandar':
      return {
        templateId: null, name: NEW_STANDAR_NAME, isDefault: true, version: null,
        layout: standarLayout(action.settings), dirty: false, editingId: null, adjustments: [],
      }
    case 'newTemplate':
      return {
        templateId: null, name: action.name, isDefault: false, version: null,
        layout: { paperWidth: action.paperWidth, blocks: structuredClone(NEW_TEMPLATE_BLOCKS) as ReceiptBlock[] },
        dirty: true, editingId: null, adjustments: [],
      }
    case 'duplicate': {
      const left = leaveCompat(state)
      return { ...left, templateId: null, isDefault: false, version: null, name: action.name, dirty: true, editingId: null }
    }
    case 'select':
      return { ...state, editingId: action.id }
    case 'rename':
      return { ...state, name: action.name, dirty: true }
    case 'toggle': {
      const block = state.layout.blocks.find((b) => b.id === action.id)
      if (!block || isLockedType(block.type)) return state
      const s = leaveCompat(state)
      return withBlocks(s, s.layout.blocks.map((b) => (b.id === action.id ? { ...b, enabled: !b.enabled } as ReceiptBlock : b)))
    }
    case 'move': {
      const { from, to } = action
      const n = state.layout.blocks.length
      if (from === to || from < 0 || to < 0 || from >= n || to >= n) return state
      const s = leaveCompat(state)
      const blocks = s.layout.blocks.slice()
      const [moved] = blocks.splice(from, 1)
      blocks.splice(to, 0, moved!)
      if (!lockedOrderHolds(blocks)) return state
      return withBlocks(s, blocks)
    }
    case 'edit': {
      const block = state.layout.blocks.find((b) => b.id === action.id)
      if (!block) return state
      const patch = safePatch(action.patch)
      // A locked block can be restyled but never switched off.
      if (isLockedType(block.type)) delete patch.enabled
      const s = leaveCompat(state)
      return withBlocks(s, s.layout.blocks.map((b) => (b.id === action.id ? { ...b, ...patch } as ReceiptBlock : b)))
    }
    case 'add': {
      if (state.layout.blocks.length >= RECEIPT_LIMITS.blocksMax) return state
      const s = leaveCompat(state)
      const id = nextId(action.block, s.layout.blocks)
      return { ...withBlocks(s, [...s.layout.blocks, freshBlock(action.block, id)]), editingId: id }
    }
    case 'remove': {
      const block = state.layout.blocks.find((b) => b.id === action.id)
      if (!block || isLockedType(block.type)) return state
      const s = leaveCompat(state)
      const next = withBlocks(s, s.layout.blocks.filter((b) => b.id !== action.id))
      return state.editingId === action.id ? { ...next, editingId: null } : next
    }
    case 'setWidth': {
      if (state.layout.paperWidth === action.paperWidth) return state
      const s = leaveCompat(state)
      return { ...s, layout: { ...s.layout, paperWidth: action.paperWidth }, dirty: true }
    }
  }
}

/** The API body. Never carries compat fields; `isDefault` only for the first save of Standar. */
export function toBody(state: DesignerState): ReceiptTemplateInput {
  const { layout } = fromCompat(state.layout)
  return {
    name: state.name.trim(),
    paperWidth: layout.paperWidth,
    blocks: layout.blocks as unknown as ReceiptTemplateInput['blocks'],
    ...(state.templateId === null && state.isDefault ? { isDefault: true } : {}),
    ...(state.templateId !== null && state.version !== null ? { version: state.version } : {}),
  }
}

/** The adjustments to tell the admin about: those recorded on edit, or those a save of unedited Standar would make. */
export function pendingAdjustments(state: DesignerState): CompatAdjustment[] {
  return state.layout.compat ? fromCompat(state.layout).adjustments : state.adjustments
}
