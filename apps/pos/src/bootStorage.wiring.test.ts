import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const h = vi.hoisted(() => ({ calls: [] as string[], journal: null as null | (() => Promise<unknown>) }))
vi.mock('@mandalika/sync', () => ({
  initSecureKV: async () => void h.calls.push('kv'),
  initJournal: async () => {
    h.calls.push('journal')
    return h.journal ? h.journal() : { kind: 'kv' }
  },
}))

beforeEach(() => {
  h.calls.length = 0
  h.journal = null
})

describe('storage boot (A01b)', () => {
  it('adopts the journal right after secure storage', async () => {
    const { bootStorage } = await import('./bootStorage')
    await bootStorage()
    expect(h.calls).toEqual(['kv', 'journal'])
  })
  it('a journal boot failure rejects (so main shows the boot error, never an empty queue)', async () => {
    h.journal = async () => {
      throw new Error('Journal antrean hilang')
    }
    const { bootStorage } = await import('./bootStorage')
    await expect(bootStorage()).rejects.toThrow(/journal/i)
  })
  it('main.tsx runs bootStorage inside the same try that renders BootError', () => {
    const main = readFileSync(fileURLToPath(new URL('./main.tsx', import.meta.url)), 'utf8')
    expect(main).toMatch(/try \{\s*await bootStorage\(\)\s*\} catch \(err\) \{[\s\S]*?<BootError/)
    expect(main).not.toMatch(/initSecureKV/)
  })
})
