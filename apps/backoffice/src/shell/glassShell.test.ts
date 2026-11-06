import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// K2b glass shell contract, read from source: the top bar is the one blurred layer, the sidebar is tint only, the
// reduced-transparency preference turns the blur into the solid bar, and the text on the bar stays readable.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const materials = read('../../../../packages/ui-tokens/materials.css')
const tokens = read('../../../../packages/ui-tokens/tokens.css')

/** Body of an `@utility name { ... }` block (brace-balanced). */
function utility(name: string): string {
  const start = materials.indexOf(`@utility ${name} {`)
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  for (let i = materials.indexOf('{', start); i < materials.length; i++) {
    if (materials[i] === '{') depth++
    else if (materials[i] === '}' && --depth === 0) return materials.slice(start, i + 1)
  }
  throw new Error(`unbalanced @utility ${name}`)
}

const hex = (name: string) => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)
  if (!m) throw new Error(`token ${name} not found`)
  return m[1]!
}
const rgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
const lum = ([r, g, b]: number[]) => {
  const [R, G, B] = [r, g, b].map((v) => { const c = v! / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!
}
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }
const over = (fg: number[], alpha: number, back: number[]) => fg.map((v, i) => v * alpha + back[i]! * (1 - alpha))

describe('Kaca K2b glass shell', () => {
  it('surface-glass blurs only under data-material=glass, with the -webkit- prefix', () => {
    const glass = utility('surface-glass')
    expect(glass).toContain("[data-material='glass']")
    expect(glass).toContain('-webkit-backdrop-filter: blur(20px) saturate(180%)')
    expect(glass).toContain('backdrop-filter: blur(20px) saturate(180%)')
  })

  it('reduced transparency swaps the blurred bar for the solid one, scoped to the glass material', () => {
    const glass = utility('surface-glass')
    const media = glass.slice(glass.indexOf('@media (prefers-reduced-transparency: reduce)'))
    expect(media).toContain("[data-material='glass']")
    expect(media).toContain('background: var(--surface-solid-bg)')
    expect(media).toContain('backdrop-filter: none')
  })

  it('surface-glass-static (the docked sidebar) never blurs', () => {
    expect(utility('surface-glass-static')).not.toContain('backdrop-filter')
    expect(read('./Sidebar.tsx')).toContain('lg:surface-glass-static')
    expect(read('./Sidebar.tsx')).not.toMatch(/lg:surface-glass(?!-static)/)
  })

  it('the header is the one surface-glass user and floats over <main>, which pads and scroll-pads by the bar height', () => {
    expect(read('./Header.tsx')).toMatch(/surface-glass absolute left-0 right-\(--bo-sb\) top-0/)
    const app = read('../App.tsx')
    expect(app).toContain('pt-(--bo-topbar-h)')
    expect(app).toContain('scroll-pt-(--bo-topbar-h)')
    // Sticky offsets are measured inside main's padding box, so top-0 already lands just below the bar.
    expect(read('../ui/DataTable.tsx')).toContain('sticky top-0 z-[2]')
    expect(read('../index.css')).toContain('--bo-topbar-h: 4rem')
  })

  it('every popover inside <main> sits below the bar, and the bar below the scrim', () => {
    expect(read('./Header.tsx')).toMatch(/top-0 z-\[25\] flex/)
    expect(read('./Sidebar.tsx')).toContain('z-[26]')
  })

  it('the entry turns glass and the ambient on', () => {
    const main = read('../main.tsx')
    expect(main).toContain("const MATERIAL: 'glass' | 'static' | 'solid' = 'glass'")
    expect(main).toContain("const AMBIENT: 'on' | 'off' = 'on'")
  })

  it('bar text stays >= 4.5:1 over the glass, even with dark content directly under it', () => {
    const bg = /--surface-glass-bg:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(materials)
    expect(bg).not.toBeNull()
    const glass = [Number(bg![1]), Number(bg![2]), Number(bg![3])]
    const alpha = Number(bg![4])
    const unders = {
      paper1: rgb(hex('paper-1')),
      goldAmbient: rgb('#d6a23a'),
      // Worst case a blur could leave: a dark row heading right under the bar.
      dark: rgb(hex('ink-700')),
    }
    for (const [label, under] of Object.entries(unders)) {
      const bar = over(glass, alpha, under)
      for (const ink of ['ink-700', 'ink-900']) {  // ink-500 is not allowed on the bar: UserMenu uses ink-700
        expect(contrast(rgb(hex(ink)), bar), `${ink} over glass over ${label}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
