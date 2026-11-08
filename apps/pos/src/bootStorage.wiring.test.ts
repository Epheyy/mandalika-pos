import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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
  it('main.tsx claims the single active tab before OTA startup and storage, and waits for the grant first (F22/W01)', () => {
    const main = src('./main.tsx')
    const claimAt = main.indexOf('await claimActiveTab()')
    const grantAt = main.indexOf('await claim.granted')
    expect(claimAt).toBeGreaterThan(-1)
    expect(grantAt).toBeGreaterThan(claimAt)
    expect(main.indexOf('await startupOta()')).toBeGreaterThan(grantAt)
    expect(main.indexOf('await bootStorage()')).toBeGreaterThan(grantAt)
    expect(main.match(/createRoot\(/g)).toHaveLength(1) // the ONE root, reused by every render (no second createRoot over the notice)
  })
  it('the OTA confirm is called from App.tsx only; native.ts merely defines it (A35)', () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    const files = (readdirSync(root, { recursive: true }) as string[])
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    expect(files.length).toBeGreaterThan(20) // the scan really walked the tree
    const callers = files.filter((f) => /otaNotifyReady\s*\(|notifyAppReady\s*\(/.test(src('./' + f)))
    expect(callers.sort()).toEqual(['App.tsx', 'native.ts'])
    // native.ts only defines it; App.tsx has exactly one call, inside the empty-deps mount effect
    expect(src('./native.ts').match(/otaNotifyReady\s*\(/g)).toHaveLength(1) // the definition
    expect(src('./native.ts').match(/notifyAppReady\s*\(/g)).toHaveLength(1)
    const app = src('./App.tsx')
    expect(app.match(/otaNotifyReady\s*\(/g)).toHaveLength(1)
    expect(app).toMatch(/useEffect\(\(\) => \{[^}]*otaNotifyReady\(\)[^}]*\}, \[\]\)/)
  })
})
