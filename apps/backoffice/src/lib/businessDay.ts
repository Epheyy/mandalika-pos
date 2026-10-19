// Business-day helpers (A28). The server decides the business day of every sale in SQL from the
// OUTLET's timezone (a shift's sales take the shift's opening date); the backoffice only has to
// send plain YYYY-MM-DD days and format instants for the few screens that still need them.
// Zones are fixed offsets: Indonesia has no DST and the browser need not ship zone data.

export type OutletTimezone = 'Asia/Jakarta' | 'Asia/Makassar' | 'Asia/Jayapura'

export const DEFAULT_TIMEZONE: OutletTimezone = 'Asia/Jakarta'

export const OUTLET_TIMEZONES: ReadonlyArray<{ value: OutletTimezone; label: string; offsetHours: number }> = [
  { value: 'Asia/Jakarta', label: 'WIB', offsetHours: 7 },
  { value: 'Asia/Makassar', label: 'WITA', offsetHours: 8 },
  { value: 'Asia/Jayapura', label: 'WIT', offsetHours: 9 },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** The browser-local calendar day as YYYY-MM-DD (never the UTC date). */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function offsetHours(tz: string): number {
  return (OUTLET_TIMEZONES.find((z) => z.value === tz) ?? OUTLET_TIMEZONES[0]).offsetHours
}

function utcIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function dayStartMs(day: string, tz: string): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetHours(tz) * 3_600_000
}

/** The instant (UTC, second precision) at which `day` begins in `tz`. */
export function dayStartIso(day: string, tz: string = DEFAULT_TIMEZONE): string {
  return utcIso(dayStartMs(day, tz))
}

/** The exclusive instant at which `day` ends in `tz` (the next local midnight). */
export function dayEndIso(day: string, tz: string = DEFAULT_TIMEZONE): string {
  return utcIso(dayStartMs(day, tz) + 86_400_000)
}
