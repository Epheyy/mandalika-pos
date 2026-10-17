import { describe, expect, it } from 'vitest'
import vectors from './__fixtures__/redact-vectors.json'
import { MAX_STRING_LOGS, redactForLogs, redactSecrets, redactString } from './redact'

interface Vector { name: string; tier: 'secrets' | 'logs'; input: unknown; expected: unknown }

/** Expands {{N*unit}} templates in every string (input and expected), like the Go harness. */
function expand(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\{\{(\d+)\*([^}]*)\}\}/g, (_m, n: string, unit: string) => unit.repeat(Number(n)))
  if (Array.isArray(v)) return v.map(expand)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, e]) => [k, expand(e)]))
  }
  return v
}

describe('shared redaction vectors (also run by backend/internal/redact)', () => {
  for (const v of (vectors as unknown as { vectors: Vector[] }).vectors) {
    it(v.name, () => {
      const input = expand(v.input)
      const expected = expand(v.expected) as { _truncated?: boolean }
      const before = JSON.stringify(input)
      const out = v.tier === 'logs' ? redactForLogs(input) : redactSecrets(input)
      if (expected && expected._truncated) {
        expect(out).toMatchObject({ _truncated: true })
        expect((out as { bytes: number }).bytes).toBeGreaterThan(32 * 1024)
      } else {
        expect(out).toEqual(expected)
      }
      expect(JSON.stringify(input)).toBe(before) // input never mutated
    })
  }
})

describe('redact (TS-only behaviour)', () => {
  it('does not mutate the input object (outbox items are the retry source)', () => {
    const input = { pin: '1234', nested: { token: 't', phone: '0812345678901' }, list: [{ password: 'p' }] }
    const snapshot = JSON.parse(JSON.stringify(input))
    redactForLogs(input)
    redactSecrets(input)
    expect(input).toEqual(snapshot)
  })

  it('handles cycles', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(redactForLogs(a)).toEqual({ name: 'a', self: '[Circular]' })
  })

  it('caps depth in the logs tier', () => {
    let deep: Record<string, unknown> = { leaf: 'x' }
    for (let i = 0; i < 12; i++) deep = { n: deep }
    expect(JSON.stringify(redactForLogs(deep))).toContain('[MaxDepth]')
  })

  it('does not cap string length or total size in the secrets tier', () => {
    const big = 'x'.repeat(MAX_STRING_LOGS * 20)
    expect(redactSecrets({ s: big })).toEqual({ s: big })
  })

  it('truncates long strings in the logs tier', () => {
    const out = redactForLogs({ s: 'x'.repeat(MAX_STRING_LOGS + 500) }) as { s: string }
    expect(out.s.length).toBeLessThan(MAX_STRING_LOGS + 50)
    expect(out.s.endsWith('...[truncated]')).toBe(true)
  })

  it('replaces an oversize result with a truncation marker', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ i, text: 'y'.repeat(1000) }))
    const out = redactForLogs({ items }) as { _truncated: boolean; bytes: number }
    expect(out._truncated).toBe(true)
    expect(out.bytes).toBeGreaterThan(32 * 1024)
  })

  it('serializes an Error with name, message, stack and the cause chain, redacted', () => {
    const inner = new Error('inner Bearer abc.def')
    const outer = new Error('outer 0812345678901', { cause: inner })
    const out = redactForLogs(outer) as { name: string; message: string; stack: string; cause: { message: string } }
    expect(out.name).toBe('Error')
    expect(out.message).toBe('outer [REDACTED]')
    expect(typeof out.stack).toBe('string')
    expect(out.cause.message).toBe('inner Bearer [REDACTED]')
  })

  it('redacts a bare string', () => {
    expect(redactString('mail a@b.co')).toBe('mail [REDACTED]')
    expect(redactString('mail a@b.co', 'secrets')).toBe('mail a@b.co')
  })

  it('drops undefined object members and keeps JSON-like shape', () => {
    expect(redactForLogs({ a: undefined, b: 1 })).toEqual({ b: 1 })
  })

  it('keeps primitive custom props of an Error and still redacts them by key and pattern', () => {
    const err = Object.assign(new Error('x'), { status: 503, code: 'E_UPSTREAM', token: 'CANARY', note: 'call 081234567890' })
    const out = redactForLogs(err) as Record<string, unknown>
    expect(out.status).toBe(503)
    expect(out.code).toBe('E_UPSTREAM')
    expect(out.token).toBe('[REDACTED]')
    expect(out.note).toBe('call [REDACTED]')
  })

  it('stays fast on adversarial 32 KB strings (bounded quantifiers + pre-cut)', () => {
    const cases = [
      'a'.repeat(32 * 1024),
      'eyJ' + 'a'.repeat(32 * 1024),
      '0 8 '.repeat(8192),
      'a@'.repeat(16 * 1024),
      '"pin"'.repeat(6000),
    ]
    for (const c of cases) {
      const t0 = performance.now()
      redactString(c)
      expect(performance.now() - t0).toBeLessThan(100)
    }
  })

  it('collapses a payload past the node budget to a marker without walking all of it', () => {
    const wide: Record<string, string> = {}
    for (let i = 0; i < 12000; i++) wide['k' + i] = 'v'
    const t0 = performance.now()
    expect(redactForLogs(wide)).toMatchObject({ _truncated: true })
    expect(performance.now() - t0).toBeLessThan(250)
  })

  it('never produces a lone surrogate when cutting astral text', () => {
    const out = redactForLogs({ s: '😀'.repeat(MAX_STRING_LOGS + 10) }) as { s: string }
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out.s)).toBe(false)
  })
})
