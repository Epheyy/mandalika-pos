import { describe, it, expect } from 'vitest'
import { center, encodeLegacy, labelRow, money, pad, toPrinterText, wrap } from './text'

// Verbatim copies of the helpers as they were in escpos.ts (COLS = 32), the reference for 32 columns.
const COLS = 32
function legacyPad(left: string, right: string): string {
  const space = COLS - left.length - right.length
  if (space >= 1) return left + ' '.repeat(space) + right
  const keep = Math.max(0, COLS - right.length - 1)
  return left.slice(0, keep) + ' ' + right
}
function legacyWrap(text: string, maxLines: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > 0 && out.length < maxLines) {
    if (rest.length <= COLS) { out.push(rest); rest = ''; break }
    let cut = rest.lastIndexOf(' ', COLS)
    if (cut <= 0) cut = COLS
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trim()
  }
  return out
}
function legacyCenter(text: string): string {
  if (text.length >= COLS) return text.slice(0, COLS)
  const left = Math.floor((COLS - text.length) / 2)
  return ' '.repeat(left) + text
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function randomText(r: () => number): string {
  const words = ['a', 'parfum', 'bunga', 'melati', 'x', 'Rp10.000', 'supercalifragilisticexpialidocious-and-then-some', '2ml', 'PI']
  const n = Math.floor(r() * 14)
  return Array.from({ length: n }, () => words[Math.floor(r() * words.length)]).join(r() < 0.1 ? '  ' : ' ')
}

describe('text helpers', () => {
  it('pad/wrap/center at 32 match the legacy helpers on 200 generated strings', () => {
    const r = rng(20261113)
    for (let i = 0; i < 200; i++) {
      const a = randomText(r)
      const b = randomText(r).slice(0, 12)
      const seed = `seed 20261113 case ${i}`
      expect(pad(a, b, 32), seed).toBe(legacyPad(a, b))
      expect(wrap(a, 2, 32), seed).toEqual(legacyWrap(a, 2))
      expect(wrap(a, 99, 32), seed).toEqual(legacyWrap(a, 99))
      expect(center(a, 32), seed).toBe(legacyCenter(a))
    }
  })

  it('pad at 48 never exceeds 48 and never clips the amount', () => {
    const r = rng(48)
    for (let i = 0; i < 200; i++) {
      const left = randomText(r)
      const amount = money(Math.floor(r() * 99_999_999) * (r() < 0.2 ? -1 : 1))
      const line = pad(left, amount, 48)
      expect(line.length).toBeLessThanOrEqual(48)
      expect(line.endsWith(amount)).toBe(true)
    }
  })

  it('labelRow keeps a long label and its amount, wrapping within the width', () => {
    const rows: string[] = []
    labelRow((l) => rows.push(l), '- Diskon manual untuk pelanggan setia yang sangat lama sekali', '-Rp15.000', 32)
    expect(rows.length).toBe(3)
    expect(rows.every((l) => l.length <= 32)).toBe(true)
    expect(rows[2]!.endsWith('-Rp15.000')).toBe(true)
  })

  it('encodeLegacy maps the middle dot to a hyphen and wide chars to ?', () => {
    expect(encodeLegacy('a·b☺')).toEqual([0x61, 0x2d, 0x62, 0x3f])
    expect(encodeLegacy('é')).toEqual([0xe9]) // Latin-1 passes through unchanged (Standar keeps today's bytes)
  })

  it("toPrinterText maps 'Café “Bunga” – 10ml…' to 'Cafe \"Bunga\" - 10ml...'", () => {
    expect(toPrinterText('Café “Bunga” – 10ml…')).toBe('Cafe "Bunga" - 10ml...')
  })

  it('toPrinterText folds ligatures, NBSP and the middle dot, keeps newlines, and turns the rest into ?', () => {
    expect(toPrinterText('ﬁn a·b')).toBe('fin a-b')
    expect(toPrinterText('a\nb')).toBe('a\nb')
    expect(toPrinterText('☺😀\t')).toBe('???')
  })

  it('toPrinterText output only holds printable ASCII and newline', () => {
    const out = toPrinterText('Café 你好 · … ­ \u0000 \u007f')
    expect(/^[\x20-\x7e\n]*$/.test(out)).toBe(true)
  })
})
