import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import type { ReceiptBlock } from './layout'
import { validateTemplate } from './validate'

interface SharedCase {
  name: string
  template: { name: string; paperWidth: number; blocks: ReceiptBlock[] }
  valid: boolean
  code?: string
  tsOnly?: boolean
}

// The Go twin (backend/internal/receipttpl) reads the same file.
const CASES_URL = new URL('../../../../backend/internal/receipttpl/testdata/cases.json', import.meta.url)
const cases = JSON.parse(readFileSync(CASES_URL, 'utf8')) as SharedCase[]

describe('validateTemplate', () => {
  it('agrees with backend/internal/receipttpl/testdata/cases.json', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
    for (const c of cases) {
      const issues = validateTemplate(c.template)
      expect({ name: c.name, valid: issues.length === 0 }).toEqual({ name: c.name, valid: c.valid })
      if (!c.valid) expect({ name: c.name, code: issues[0]?.code }).toEqual({ name: c.name, code: c.code })
    }
  })

  it('reports every issue, with the first one matching the server', () => {
    const issues = validateTemplate({ name: ' ', paperWidth: 58, blocks: [] })
    expect(issues.map((i) => i.code)).toEqual(['name_invalid', 'too_few_blocks', 'locked_missing', 'locked_missing', 'locked_missing'])
  })
})
