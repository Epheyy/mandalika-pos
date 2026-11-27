// Pure helpers for renaming a user in the edit dialog (kept DOM-free for node tests).

/** Longest name the form accepts; the backend enforces the same cap on update. */
export const MAX_DISPLAY_NAME_LENGTH = 100

/** Counts characters like the backend (runes), not UTF-16 units. */
const length = (s: string) => Array.from(s).length

/** An Indonesian message, or null when the name is acceptable (trimmed, non-empty, within the cap). */
export function displayNameError(name: string): string | null {
  const n = name.trim()
  if (n === '') return 'Nama wajib diisi.'
  if (length(n) > MAX_DISPLAY_NAME_LENGTH) return `Nama maksimal ${MAX_DISPLAY_NAME_LENGTH} karakter.`
  return null
}

/** `{ displayName }` only when the trimmed name differs from the stored one, so an untouched name is never re-sent. */
export function renamePayload(original: string, edited: string): { displayName?: string } {
  const next = edited.trim()
  return next !== original.trim() ? { displayName: next } : {}
}

/** Validates only a changed name, so an untouched (even odd legacy) name never blocks a role, coverage or PIN edit. */
export function renameError(original: string, edited: string): string | null {
  return edited.trim() === original.trim() ? null : displayNameError(edited)
}
