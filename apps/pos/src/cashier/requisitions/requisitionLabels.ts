import type { StockRequisition } from '@mandalika/api'

// POS copy of apps/backoffice/src/screens/requisitions/requisitionStatus.ts, extended with the
// linked-transfer steps (Dikirim / Diterima). Copied, not shared: that file imports @mandalika/api.

export type RequisitionStatus = StockRequisition['status']
type Tone = 'neutral' | 'warning' | 'success' | 'danger' | 'gold'

export const REQUISITION_STATUS: Record<RequisitionStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draf', tone: 'neutral' },
  submitted: { label: 'Diajukan', tone: 'warning' },
  approved: { label: 'Disetujui', tone: 'gold' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  fulfilled: { label: 'Transfer Dibuat', tone: 'success' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
}

export const STATUS_FILTERS: { value: RequisitionStatus | ''; label: string }[] = [
  { value: '', label: 'Semua' },
  { value: 'draft', label: 'Draf' },
  { value: 'submitted', label: 'Diajukan' },
  { value: 'approved', label: 'Disetujui' },
  { value: 'fulfilled', label: 'Transfer Dibuat' },
  { value: 'rejected', label: 'Ditolak' },
  { value: 'cancelled', label: 'Dibatalkan' },
]

export const EVENT_LABEL: Record<string, string> = {
  created: 'Dibuat',
  updated: 'Diubah',
  submitted: 'Diajukan',
  approved: 'Disetujui',
  rejected: 'Ditolak',
  cancelled: 'Dibatalkan',
  fulfilled: 'Transfer dibuat',
  refulfilled: 'Transfer dibuat ulang',
}

/** Sub-label of the "Transfer Dibuat" step, from the live status of the linked transfer. */
export const TRANSFER_STEP_NOTE: Record<string, string> = {
  draft: 'Disiapkan gudang',
  cancelled: 'Transfer dibatalkan, menunggu gudang',
}

export type StepState = 'done' | 'current' | 'todo'
export interface ChainStep { key: string; label: string; state: StepState; note?: string }
export interface Chain {
  steps: ChainStep[]
  /** Set for rejected / cancelled: the happy path stops and this is shown as a dead-end badge. */
  deadEnd?: { label: string; note?: string }
}

const STEP_LABELS: { key: string; label: string }[] = [
  { key: 'draft', label: 'Draf' },
  { key: 'submitted', label: 'Diajukan' },
  { key: 'approved', label: 'Disetujui' },
  { key: 'fulfilled', label: 'Transfer Dibuat' },
  { key: 'in_transit', label: 'Dikirim' },
  { key: 'completed', label: 'Diterima' },
]

/** Index of the current step on the six-step chain; -1 for a dead end. */
function currentStep(pb: Pick<StockRequisition, 'status' | 'transfer'>): number {
  if (pb.status === 'rejected' || pb.status === 'cancelled') return -1
  if (pb.status !== 'fulfilled') return STEP_LABELS.findIndex((s) => s.key === pb.status)
  if (pb.transfer?.status === 'completed') return 5
  if (pb.transfer?.status === 'in_transit') return 4
  return 3
}

/** Draf -> Diajukan -> Disetujui -> Transfer Dibuat -> Dikirim -> Diterima. The last two come from the transfer. */
export function buildChain(pb: Pick<StockRequisition, 'status' | 'transfer' | 'decisionNote'>): Chain {
  const cur = currentStep(pb)
  if (cur < 0) {
    const meta = REQUISITION_STATUS[pb.status]
    return { steps: [], deadEnd: { label: meta.label, note: pb.decisionNote || undefined } }
  }
  const steps = STEP_LABELS.map((s, i): ChainStep => {
    // The last step of a finished chain is "done", not "current".
    const state: StepState = i < cur || (i === cur && cur === 5) ? 'done' : i === cur ? 'current' : 'todo'
    const note = s.key === 'fulfilled' && cur === 3 && pb.transfer ? TRANSFER_STEP_NOTE[pb.transfer.status] : undefined
    return { key: s.key, label: s.label, state, note }
  })
  return { steps }
}

export interface RequisitionActions { edit: boolean; submit: boolean; cancel: boolean; openReceive: boolean }

/** What the cashier may do. Approve / reject / fulfil never appear on the tablet. */
export function allowedActions(pb: Pick<StockRequisition, 'status' | 'transfer'>): RequisitionActions {
  return {
    edit: pb.status === 'draft',
    submit: pb.status === 'draft',
    cancel: pb.status === 'draft' || pb.status === 'submitted',
    openReceive: pb.status === 'fulfilled' && pb.transfer?.status === 'in_transit',
  }
}

export const fmtDateTime = (s?: string | null): string =>
  s ? new Date(s).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export const fmtDate = (s?: string | null): string =>
  s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
