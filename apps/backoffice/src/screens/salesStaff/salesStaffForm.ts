import type { PullUser, SalesStaff, SalesStaffInput } from '@mandalika/api'

export const NAME_MAX = 60
export const NO_LINK = ''

export interface SalesStaffFormState {
  name: string
  /** Ticked outlet ids (only outlets the caller covers). */
  outletIds: string[]
  /** Linked account id; NO_LINK = not linked. */
  userId: string
  active: boolean
}

export type SalesStaffFormAction =
  | { type: 'SET_NAME'; value: string }
  | { type: 'TOGGLE_OUTLET'; id: string }
  | { type: 'SET_USER'; userId: string; displayName?: string }
  | { type: 'SET_ACTIVE'; value: boolean }

export interface SalesStaffFormErrors {
  name: string | null
  outlets: string | null
}

/** Form values for an entry being edited, or for a new one (a single covered outlet is ticked up front). */
export function initialSalesStaffForm(entry: SalesStaff | null, coveredOutletIds: readonly string[]): SalesStaffFormState {
  if (entry) {
    return { name: entry.name, outletIds: [...entry.outletIds], userId: entry.user?.id ?? NO_LINK, active: entry.active }
  }
  return { name: '', outletIds: coveredOutletIds.length === 1 ? [...coveredOutletIds] : [], userId: NO_LINK, active: true }
}

export function salesStaffFormReducer(state: SalesStaffFormState, action: SalesStaffFormAction): SalesStaffFormState {
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, name: action.value }
    case 'TOGGLE_OUTLET':
      return {
        ...state,
        outletIds: state.outletIds.includes(action.id) ? state.outletIds.filter((x) => x !== action.id) : [...state.outletIds, action.id],
      }
    case 'SET_USER': {
      // Choosing an account fills an empty Nama with the account's name; a typed name is never overwritten.
      const fill = action.userId !== NO_LINK && state.name.trim() === '' ? action.displayName : undefined
      return { ...state, userId: action.userId, name: fill ?? state.name }
    }
    case 'SET_ACTIVE':
      return { ...state, active: action.value }
  }
}

export function salesStaffFormErrors(state: SalesStaffFormState): SalesStaffFormErrors {
  const name = state.name.trim()
  return {
    name: name === '' ? 'Nama wajib diisi' : name.length > NAME_MAX ? `Nama maksimal ${NAME_MAX} karakter` : null,
    outlets: state.outletIds.length === 0 ? 'Pilih minimal satu outlet' : null,
  }
}

export const hasSalesStaffErrors = (e: SalesStaffFormErrors): boolean => e.name !== null || e.outlets !== null

export function toSalesStaffInput(state: SalesStaffFormState): SalesStaffInput {
  return { name: state.name.trim(), active: state.active, outletIds: state.outletIds, userId: state.userId === NO_LINK ? null : state.userId }
}

/** "Lepas dari outlet saya": the entry's own values with Aktif off and no outlets; the server keeps only the outlets the caller does not cover, active or not. */
export function releaseSalesStaffInput(entry: SalesStaff): SalesStaffInput {
  return { name: entry.name, active: false, outletIds: [], userId: entry.user?.id ?? null }
}

/** Linkable users plus the entry's current account (the server's list leaves linked users out, so an edit would otherwise unlink). */
export function linkOptions(linkable: readonly PullUser[], current: PullUser | undefined): PullUser[] {
  if (!current || linkable.some((u) => u.id === current.id)) return [...linkable]
  return [current, ...linkable]
}

export interface SaveAttempt {
  sig: string
  key: string
}

/** The Idempotency-Key for a save: the previous attempt's key while the payload is unchanged (a retry replays the write), a fresh one once it changes. */
export function nextSaveAttempt(prev: SaveAttempt | null, entryId: string | null, input: SalesStaffInput): SaveAttempt {
  const sig = JSON.stringify([entryId, input])
  return prev?.sig === sig ? prev : { sig, key: crypto.randomUUID() }
}
