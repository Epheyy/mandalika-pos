import { test as base, expect, chromium, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

export const POS = 'http://127.0.0.1:5183'
export const BO = 'http://127.0.0.1:5184'
export const API = 'http://127.0.0.1:59999'
const origins = new Set([POS, BO, API])
const record = (row: object) => fs.appendFileSync(path.join(process.env.A34C_RUN_DIR!, 'processes.jsonl'), JSON.stringify(row) + '\n')

// Scenario state is deliberately synthetic and test-owned; never a real profile.
export type ScenarioPage = Page & { __a24: any; __a26: any; __a26pos: any; __a31Result: any }
export const test = base.extend<{ isolatedNetwork: void }>({
  browser: [async ({}, use) => {
    const server = await chromium.launchServer({ headless: true, host: '127.0.0.1' })
    const pid = server.process().pid
    record({ kind: 'chromium', pid, event: 'starting', executable: server.process().spawnfile })
    let browser
    try { browser = await chromium.connect(server.wsEndpoint()); await use(browser) }
    finally {
      try { await browser?.close() } finally { await server.close() }
      record({ kind: 'chromium', pid, event: 'closed' })
    }
  }, { scope: 'worker' }],
  isolatedNetwork: [async ({ context }, use, info) => {
    const blocked: string[] = [], requests: string[] = []
    const label = (raw: string) => { const u = new URL(raw); return u.origin + u.pathname }
    context.on('request', request => {
      const raw = request.url()
      if (!/^https?:/.test(raw)) return
      requests.push(label(raw))
      if (!origins.has(new URL(raw).origin)) blocked.push(label(raw))
    })
    await context.route('**/*', async route => {
      const raw = route.request().url(), origin = new URL(raw).origin
      if (!origins.has(origin) || origin === API) {
        blocked.push(label(raw)) // Unhandled synthetic API calls also fail closed.
        await route.abort('blockedbyclient')
      } else await route.continue()
    })
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url())
      if (['ws://127.0.0.1:5183', 'ws://127.0.0.1:5184'].includes(url.origin) && url.pathname === '/') {
        socket.connectToServer()
      } else {
        blocked.push(label(socket.url()))
        socket.close({ code: 1008, reason: 'Unexpected browser socket' })
      }
    })
    await context.addInitScript(() => {
      const name = location.port === '5183' ? 'pos' : location.port === '5184' ? 'backoffice' : null
      if (!name) return
      localStorage.setItem(`mandalika.${name}.refresh`, 'SYNTHETIC-NON-TOKEN')
      if (name === 'backoffice') localStorage.setItem('mandalika.backoffice.loginDate', new Date().toLocaleDateString('sv-SE'))
    })
    try { await use() }
    finally {
      const evidence = { id: info.title.split(' ')[0], requests: [...new Set(requests)], blocked: [...new Set(blocked)] }
      fs.appendFileSync(path.join(process.env.A34C_RUN_DIR!, 'network.jsonl'), JSON.stringify(evidence) + '\n')
      expect(blocked, 'Unexpected external or unhandled API network request').toEqual([])
    }
  }, { auto: true }],
})
export { expect }

// Backoffice scenario helpers (Fase D1b). Sidebar items carry data-nav-id and Tabs buttons carry
// data-tab-key, so label renames never touch the scenarios again. The scenario still installs its own
// API route before calling openBackoffice.
export type BackofficeNavId =
  | 'dashboard' | 'products' | 'customers' | 'promotions' | 'reports' | 'warehouses' | 'approvals'
  | 'requisitions' | 'users' | 'syncReview' | 'settings' | 'erpOutbox' | 'errors'

/** Load the backoffice signed in with the synthetic refresh token. `viewport: false` keeps the context default. */
export async function openBackoffice(page: Page, opts: { viewport?: boolean } = {}) {
  await page.goto(BO)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('mandalika.backoffice.refresh', 'SYNTHETIC-NON-TOKEN')
    localStorage.setItem('mandalika.backoffice.loginDate', new Date().toLocaleDateString('sv-SE'))
  })
  await page.reload()
  if (opts.viewport !== false) await page.setViewportSize({ width: 1440, height: 1000 })
}

/**
 * Land on a deep link the way a pasted URL does: set the hash, then load the page fresh. A fresh load starts
 * on a bare URL and the app's landing redirect writes the first route a moment later, so wait for that route
 * before overwriting it (otherwise the redirect can land after our hash and send the reload to Ringkasan).
 */
export async function deepLink(page: Page, hash: string) {
  await page.waitForFunction(() => location.hash.length > 1)
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.reload()
}

/** The sidebar item for a screen (exactly one per nav id). */
export const navItem = (page: Page, navId: BackofficeNavId) => page.locator(`[data-nav-id="${navId}"]`)

export async function navTo(page: Page, navId: BackofficeNavId) {
  await navItem(page, navId).click()
}

/** A Tabs button by its stable key, on the screen that is currently open. */
export const tabItem = (page: Page, tabKey: string) => page.locator(`[data-tab-key="${tabKey}"]`)

export async function clickTab(page: Page, tabKey: string) {
  await tabItem(page, tabKey).click()
}

/** Open a screen from the sidebar, then one of its tabs. */
export async function openTab(page: Page, navId: BackofficeNavId, tabKey: string) {
  await navTo(page, navId)
  await clickTab(page, tabKey)
}

export async function evidence(info, value: unknown) {
  // Only in-memory synthetic fixture/captured data; never save storageState.
  await info.attach('synthetic-scenario-evidence', { body: JSON.stringify(value, null, 2), contentType: 'application/json' })
}

declare global {
  interface Window {
    __a26csv: Promise<string>[]
    __a26blobs: Blob[]
    runPollingTests: (selected?: string) => Promise<{ results: {name: string; passed: boolean; error?: string}[]; passed: number; total: number }>
  }
}
