import { defineConfig } from '@playwright/test'
import path from 'node:path'

const output = process.env.A34C_RUN_DIR
if (!output) throw new Error('Use the checked-in browser:ci runner')

export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', fullyParallel: false, workers: 1,
  forbidOnly: true, retries: 0, maxFailures: 1, timeout: 120_000, globalTimeout: 900_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(output, 'failures'),
  reporter: [['list'], ['./required-reporter.ts'], ['junit', { outputFile: path.join(output, 'junit.xml') }]],
  use: {
    headless: true, viewport: { width: 1440, height: 1000 },
    timezoneId: 'Asia/Jakarta', locale: 'en-US',
    serviceWorkers: 'block', storageState: { cookies: [], origins: [] },
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off',
    actionTimeout: 15_000, navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: ['pos', 'backoffice'].map((app, i) => ({
    command: `node tests/browser/serve-app.mjs ${app}`,
    cwd: path.resolve('.'), url: `http://127.0.0.1:${5183 + i}`,
    reuseExistingServer: false, timeout: 45_000,
    stdout: 'pipe' as const, stderr: 'pipe' as const,
  })),
})
