import { describe, expect, it } from 'vitest'
import vectors from './__fixtures__/redact-vectors.json'
import { MAX_STRING_LOGS, redactForLogs, redactSecrets, redactString } from './redact'

interface Vector { name: string; tier: 'secrets' | 'logs'; input: unknown; expected: unknown }

describe('shared redaction vectors (also run by backend/internal/redact)', () => {
  for (const v of (vectors as unknown as { vectors: Vector[] }).vectors) {
    it(v.name, () => {
      const before = JSON.stringify(v.input)
      const out = v.tier === 'logs' ? redactForLogs(v.input) : redactSecrets(v.input)
      expect(out).toEqual(v.expected)
      expect(JSON.stringify(v.input)).toBe(before) // input never mutated
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
})
