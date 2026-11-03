/*
 * Pure hash <-> location helpers for the hand-rolled router (D-67/D-68/D-69).
 * "#/laporan/refund?dari=2026-11-01&status=open" <-> { path: ['laporan','refund'], query: { dari, status } }
 * Nothing here touches window, so it runs (and is tested) in node.
 */
export interface Location {
  readonly path: readonly string[]
  readonly query: Readonly<Record<string, string>>
}

export type QueryValue = string | number | boolean | null | undefined

export const EMPTY_LOCATION: Location = Object.freeze({ path: [], query: {} })

const safeDecode = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const decodeQueryPart = (raw: string): string => safeDecode(raw.replace(/\+/g, ' '))

/** Reads "#/a/b?x=1". The leading "#" and "/" are optional; malformed escapes are kept as typed. */
export function parseHash(hash: string): Location {
  const rest = hash.startsWith('#') ? hash.slice(1) : hash
  const cut = rest.indexOf('?')
  const pathPart = cut === -1 ? rest : rest.slice(0, cut)
  const queryPart = cut === -1 ? '' : rest.slice(cut + 1)

  const path = pathPart.split('/').filter((s) => s !== '').map(safeDecode)
  const query: Record<string, string> = {}
  for (const pair of queryPart.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = decodeQueryPart(eq === -1 ? pair : pair.slice(0, eq))
    if (key === '' || key === '__proto__') continue
    query[key] = eq === -1 ? '' : decodeQueryPart(pair.slice(eq + 1))
  }
  return { path, query }
}

/** Builds the canonical "#/a/b?x=1". Keys whose value is undefined, null or "" are left out. */
export function buildHash(path: readonly string[], query: Readonly<Record<string, QueryValue>> = {}): string {
  const pathPart = path.filter((s) => s !== '').map(encodeURIComponent).join('/')
  const queryPart = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `#/${pathPart}${queryPart === '' ? '' : `?${queryPart}`}`
}

/** One canonical spelling for any accepted form ("/laporan", "#laporan?x=1", ...), so two spellings compare equal. */
export function normalizeHash(raw: string): string {
  const { path, query } = parseHash(raw)
  return buildHash(path, query)
}
