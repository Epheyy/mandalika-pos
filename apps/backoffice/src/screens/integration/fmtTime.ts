import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'

export function fmtTime(s?: string | null): string {
  if (!s) return '—'
  try {
    return format(parseISO(s), 'dd MMM yyyy HH:mm', { locale: id })
  } catch {
    return s
  }
}
