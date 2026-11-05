import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Capture-to-artifacts helper for the Kaca restyle slices (plan section 6). It is a helper, not a project and not
 * a baseline: no `toHaveScreenshot`, no new Playwright project (projects inherit testMatch, so every scenario
 * would run twice and required-reporter fails on duplicate ids). A scenario calls `captureShot` at the points a
 * reviewer wants to see; the PNGs land in `<A34C_RUN_DIR>/shots/` next to the gate's other evidence.
 */
export const SHOT_VIEWPORTS = {
  /** POS landscape tablet (Galaxy Tab A9 class). */
  pos: { width: 1280, height: 800 },
  /** POS short height: the Bayar sheet (P-5 was found here). */
  'pos-short': { width: 1280, height: 667 },
  'bo-desktop': { width: 1440, height: 900 },
  'bo-tablet': { width: 768, height: 1024 },
  'bo-phone': { width: 375, height: 812 },
} as const
export type ShotViewport = keyof typeof SHOT_VIEWPORTS

export const POS_SHOT_VIEWPORTS: readonly ShotViewport[] = ['pos']
export const BAYAR_SHOT_VIEWPORTS: readonly ShotViewport[] = ['pos', 'pos-short']
export const BO_SHOT_VIEWPORTS: readonly ShotViewport[] = ['bo-desktop', 'bo-tablet', 'bo-phone']

/** File-system-safe name: letters, digits, dot, dash, underscore only. */
export function shotFileName(name: string, viewport: ShotViewport): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) throw new Error('captureShot: empty name')
  const { width, height } = SHOT_VIEWPORTS[viewport]
  return `${safe}@${width}x${height}.png`
}

/**
 * Resize the page to each viewport, wait for fonts, write `<runDir>/shots/<name>@WxH.png`, then restore the
 * original viewport. Returns the written paths. Throws if the gate's output dir is not set (use browser:ci).
 */
export async function captureShot(
  page: Page,
  name: string,
  viewports: readonly ShotViewport[],
  runDir: string | undefined = process.env.A34C_RUN_DIR,
): Promise<string[]> {
  if (!runDir) throw new Error('captureShot: A34C_RUN_DIR is not set (use the checked-in browser:ci runner)')
  const dir = path.join(runDir, 'shots')
  fs.mkdirSync(dir, { recursive: true })
  const original = page.viewportSize()
  const written: string[] = []
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(SHOT_VIEWPORTS[viewport])
      await page.evaluate(() => document.fonts.ready)
      const file = path.join(dir, shotFileName(name, viewport))
      await page.screenshot({ path: file, fullPage: false })
      written.push(file)
    }
  } finally {
    if (original) await page.setViewportSize(original)
  }
  return written
}
