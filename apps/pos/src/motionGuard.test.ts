import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Motion guard (Kaca plan section 4): animate transform and opacity only. `transition-all` animates layout
 * properties, and so does any transition on width/height/top/left/margin/padding/border/font-size. The allow-list
 * (`motionGuard.allowlist.json`: one entry per file = repo-relative path -> count) starts with today's hits and is a
 * ratchet: a new hit fails, and removing hits fails until the entry is lowered/deleted, so each slice shrinks the list
 * and the cleanup slice (Z) asserts it is empty.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCAN_ROOTS = ['apps/pos/src', 'apps/backoffice/src', 'packages/ui-tokens']
const EXTENSIONS = /\.(tsx?|css)$/
const LAYOUT_PROPS =
  'width|height|top|left|right|bottom|margin|padding|border|font-size|inset|gap|grid-template-rows|grid-template-columns'

/** Each pattern is global; one match = one hit. */
const LAYOUT_TRANSITION_PATTERNS: readonly RegExp[] = [
  /\btransition-all\b/g,
  /\btransition-(?:width|height|spacing)\b/g,
  new RegExp(String.raw`\btransition-\[[^\]]*\b(?:all|${LAYOUT_PROPS})\b`, 'g'),
  new RegExp(String.raw`\btransitionProperty\s*:\s*['"][^'"]*\b(?:all|${LAYOUT_PROPS})\b`, 'g'),
  new RegExp(String.raw`\btransition(?:-property)?\s*:[^;{}]*\b(?:all|${LAYOUT_PROPS})\b`, 'g'),
]

function countLayoutTransitions(source: string): number {
  return LAYOUT_TRANSITION_PATTERNS.reduce((n, re) => n + (source.match(re)?.length ?? 0), 0)
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (EXTENSIONS.test(name) && !/\.test\.tsx?$/.test(name)) yield full
  }
}

function scan(): Record<string, number> {
  const found: Record<string, number> = {}
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const n = countLayoutTransitions(readFileSync(file, 'utf8'))
      if (n > 0) found[relative(REPO_ROOT, file).split(sep).join('/')] = n
    }
  }
  return found
}

const ALLOWED: Record<string, number> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'motionGuard.allowlist.json'), 'utf8'),
)

describe('countLayoutTransitions', () => {
  it('flags transition-all and layout-property transitions', () => {
    expect(countLayoutTransitions('class="transition-all duration-200"')).toBe(1)
    expect(countLayoutTransitions('class="transition-[width,opacity]"')).toBe(1)
    expect(countLayoutTransitions('class="transition-width"')).toBe(1)
    expect(countLayoutTransitions('class="transition-[all]"')).toBe(1)
    expect(countLayoutTransitions('class="transition-[grid-template-rows]"')).toBe(1)
    expect(countLayoutTransitions("style={{ transitionProperty: 'height' }}")).toBe(1)
    expect(countLayoutTransitions('.a { transition: height 0.2s ease; }')).toBe(1)
    expect(countLayoutTransitions('.a { transition-property: margin-left; }')).toBe(1)
    expect(countLayoutTransitions('.a { transition: all 0.2s; }')).toBe(1)
  })

  it('allows transform/opacity/color transitions', () => {
    expect(countLayoutTransitions('class="transition-transform transition-opacity transition-colors"')).toBe(0)
    expect(countLayoutTransitions('class="transition-[transform,opacity]"')).toBe(0)
    expect(countLayoutTransitions('.a { transition: transform var(--d-press) var(--ease-std); }')).toBe(0)
  })
})

describe('motion guard', () => {
  it('scans real files (the walker would otherwise pass vacuously)', () => {
    expect(Object.keys(scan()).length).toBeGreaterThan(0)
  })

  it('introduces no layout transition outside the allow-list, and the allow-list has no stale entries', () => {
    const found = scan()
    const problems: string[] = []
    for (const [file, n] of Object.entries(found)) {
      const allowed = ALLOWED[file] ?? 0
      if (n > allowed) problems.push(`${file}: ${n} layout transition(s), allow-list has ${allowed}. Animate transform/opacity instead.`)
    }
    for (const [file, allowed] of Object.entries(ALLOWED)) {
      const n = found[file] ?? 0
      if (n < allowed) problems.push(`${file}: allow-list says ${allowed}, file has ${n}. Lower or delete the entry in motionGuard.allowlist.json.`)
    }
    expect(problems).toEqual([])
  })
})
