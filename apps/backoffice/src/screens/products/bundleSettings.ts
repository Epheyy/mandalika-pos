import type { BundleCatalog, BundleSettings, BundleSettingsInput } from '@mandalika/api'
import { BRAND } from '../../lib/brand'
import { parseMoneyInput } from '../../lib/moneyInput'

/** Raw input strings: "" means "no price" (standard) / "use the standard price" (line). */
export type BundleSettingsForm = {
  standard: Record<string, string>
  lines: Record<string, Record<string, string>>
}

export const DEFAULT_LARGE_SIZES = ['100ml', '110ml', '120ml']

const sizeNum = (size: string): number => Number.parseInt(size, 10) || 0
const bySize = (a: string, b: string): number => sizeNum(a) - sizeNum(b)

const priceText = (price: number): string => String(Math.round(price))

/** The three default sizes always show a field; any other stored size follows, smallest first. */
export function settingsToForm(s: BundleSettings): BundleSettingsForm {
  const stored: Record<string, string> = {}
  for (const e of s.standard) stored[e.size] = priceText(e.price)
  const sizes = [...new Set([...DEFAULT_LARGE_SIZES, ...Object.keys(stored)])].sort(bySize)
  const standard: Record<string, string> = {}
  for (const size of sizes) standard[size] = stored[size] ?? ''
  const lineNames = [...new Set([...s.lines.map((l) => l.line), ...s.linePrices.map((p) => p.line)])]
  const lines: Record<string, Record<string, string>> = {}
  for (const line of lineNames) {
    lines[line] = Object.fromEntries(sizes.map((size) => [size, '']))
  }
  for (const p of s.linePrices) {
    lines[p.line] = { ...lines[p.line], [p.size]: priceText(p.price) }
  }
  return { standard, lines }
}

/** "Rp 850.000" or "850000" to a number; 0 when there is nothing to read. */
const readPrice = (text: string): number => {
  const digits = parseMoneyInput(text)
  return digits ? Number(digits) : 0
}

/** Empty standard and line prices are dropped; the server replaces the whole table. */
export function formToInput(f: BundleSettingsForm): BundleSettingsInput {
  const standard = Object.keys(f.standard)
    .sort(bySize)
    .filter((size) => f.standard[size].trim() !== '')
    .map((size) => ({ size, price: readPrice(f.standard[size]) }))
  const linePrices = Object.keys(f.lines)
    .sort()
    .flatMap((line) =>
      Object.keys(f.lines[line])
        .sort(bySize)
        .filter((size) => f.lines[line][size].trim() !== '')
        .map((size) => ({ line, size, price: readPrice(f.lines[line][size]) })),
    )
  return { standard, linePrices }
}

/** Same copy as the server validation, so a problem reads the same before and after saving. */
export function formProblems(f: BundleSettingsForm): string[] {
  const out: string[] = []
  const zero = (text: string) => text.trim() !== '' && readPrice(text) <= 0
  if (Object.values(f.standard).some(zero) || Object.values(f.lines).some((l) => Object.values(l).some(zero))) {
    out.push('Harga bundle harus bilangan bulat > 0')
  }
  for (const line of Object.keys(f.lines).sort()) {
    for (const size of Object.keys(f.lines[line]).sort(bySize)) {
      const hasLine = f.lines[line][size].trim() !== ''
      const hasStandard = (f.standard[size] ?? '').trim() !== ''
      if (hasLine && !hasStandard) out.push(`Harga lini ${size} butuh harga standar ${size}`)
    }
  }
  return [...new Set(out)]
}

export type AromaRow = {
  productId: string
  name: string
  offers: { key: string; text: string }[]
  notes: { key: string; text: string }[]
}

const money = (price: number): string => BRAND.currency.format(price).replace(/ /g, ' ')

/** One row per product: a chip per offer and a note per reason it lacks a bundle. */
export function aromaRows(c: BundleCatalog, filter: 'all' | 'missing'): AromaRow[] {
  const rows = c.products.map((p): AromaRow => {
    const offers = p.offers.map((o) => ({
      key: `${o.line}|${o.size}`,
      text: `${o.lineShort ? `${o.lineShort} ` : ''}${o.size} · ${money(o.price)}`,
    }))
    const seen = new Set<string>()
    const notes: AromaRow['notes'] = []
    for (const m of p.missing) {
      const text = m.reason === 'no_atomizer' ? m.text : `${m.line ? shortOfLine(c, m.line) : m.size}: ${m.text}`
      if (seen.has(text)) continue
      seen.add(text)
      notes.push({ key: `${m.line}|${m.size}|${m.reason}`, text })
    }
    return { productId: p.productId, name: p.productName, offers, notes }
  })
  return filter === 'missing' ? rows.filter((r) => r.notes.length > 0) : rows
}

const shortOfLine = (c: BundleCatalog, line: string): string => c.lines.find((l) => l.line === line)?.short ?? line

type SaveApi = { updateBundleSettings: (body: BundleSettingsInput) => Promise<void> }

/** Saves the form. The server's own text is the message; it is already in plain Indonesian. */
export async function saveBundleSettings(
  api: SaveApi,
  form: BundleSettingsForm,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const problems = formProblems(form)
  if (problems.length > 0) return { ok: false, error: problems[0] }
  try {
    await api.updateBundleSettings(formToInput(form))
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menyimpan harga bundle. Coba lagi.' }
  }
}
