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

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

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
  it('App mounts only after bootStorage succeeded, never inside the BootError catch (A35)', () => {
    const main = src('./main.tsx')
    const tryAt = main.indexOf('await bootStorage()')
    const catchAt = main.indexOf('} catch (err) {')
    const returnAt = main.indexOf('return', catchAt)
    const appAt = main.indexOf('<App />')
    expect(tryAt).toBeGreaterThan(-1)
    expect(appAt).toBeGreaterThan(returnAt) // the catch returns before App can render
    expect(main.slice(catchAt, returnAt)).not.toMatch(/<App/)
  })
  it('the OTA confirm lives only in App.tsx, never in boot-error, main, sync or auth paths (A35)', () => {
    expect(src('./BootError.tsx')).not.toMatch(/otaNotifyReady|notifyAppReady/)
    expect(src('./main.tsx')).not.toMatch(/otaNotifyReady|notifyAppReady/)
    expect(src('./cashier/SyncProvider.tsx')).not.toMatch(/otaNotifyReady|notifyAppReady/)
    expect(src('./auth.tsx')).not.toMatch(/otaNotifyReady|notifyAppReady/)
    const app = src('./App.tsx')
    expect(app.match(/otaNotifyReady\(\)/g)).toHaveLength(1)
    // inside the mount effect (empty deps), not behind a network/auth promise
    expect(app).toMatch(/useEffect\(\(\) => \{[^}]*otaNotifyReady\(\)[^}]*\}, \[\]\)/)
  })
})
