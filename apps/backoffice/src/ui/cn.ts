/** Tiny class-name joiner — drops falsy parts. Avoids a clsx dependency. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
