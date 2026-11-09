// F18 (QA retest R10): the Bayar cash field must give the same amount for the same text whether it is typed key by
// key or pasted through the clipboard. A separator + exactly three digits is a thousands group ("50.000" = Rp 50.000);
// one or two digits are a fraction and are dropped ("50000.5" = Rp 50.000). Cart: one Synthetic Scent M, Rp 100.000.
import type { ScenarioPage } from './fixture'
import { SHOT_VIEWPORTS, type ShotViewport } from './shots'

const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
const norm = (s: string) => s.replace(/\s+/g, ' ')

const CASES: Array<{ text: string; shown: string; change: string | null }> = [
  { text: '150.000', shown: 'Rp 150.000', change: 'Rp 50.000' },
  { text: '150,000', shown: 'Rp 150.000', change: 'Rp 50.000' },
  { text: '1.000.000', shown: 'Rp 1.000.000', change: 'Rp 900.000' },
  { text: '120000.5', shown: 'Rp 120.000', change: 'Rp 20.000' },
  { text: '123.456', shown: 'Rp 123.456', change: 'Rp 23.456' },
  { text: '12.3457', shown: 'Rp 123.457', change: 'Rp 23.457' },
  { text: '150.000,00', shown: 'Rp 150.000', change: 'Rp 50.000' },
]

export const posCashInputTypedPasted = async (page: ScenarioPage) => {
  const out: Record<string, unknown>[] = []
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Bayar', exact: true }).click()
  const field = page.getByRole('textbox', { name: 'Jumlah dibayar' })
  await field.waitFor()
  const read = async () => ({
    shown: norm(await field.inputValue()),
    body: norm(await page.getByRole('dialog').innerText()),
  })
  for (const vp of ['pos-a9', 'pos-a9-portrait'] as ShotViewport[]) {
    await page.setViewportSize(SHOT_VIEWPORTS[vp])
    for (const c of CASES) {
      const results: Array<{ shown: string; body: string }> = []
      for (const how of ['typed', 'pasted'] as const) {
        await field.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        if (how === 'typed') await page.keyboard.type(c.text)
        else {
          await page.evaluate((t) => navigator.clipboard.writeText(t), c.text)
          await page.keyboard.press('Control+V')
        }
        const r = await read()
        assert(r.shown === c.shown, `${vp} ${how} "${c.text}": field shows "${r.shown}", wanted "${c.shown}"`)
        if (c.change) assert(r.body.includes(`Kembalian ${c.change}`), `${vp} ${how} "${c.text}": change ${c.change} missing`)
        results.push(r)
      }
      assert(results[0]!.shown === results[1]!.shown, `${vp} "${c.text}": typed and pasted amounts differ`)
      out.push({ vp, text: c.text, shown: results[0]!.shown })
    }
    // Backspace right after an accepted group removes the last digit (the caret is at the end), not one before it.
    await field.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('12.500')
    await page.keyboard.press('Backspace')
    assert(norm(await field.inputValue()) === 'Rp 1.250', `${vp}: Backspace after a group removes the last digit (${norm(await field.inputValue())})`)
    // Digits typed after a separator stay out of the field until they form a group of three; leaving the field with
    // one or two pending drops them and the shown amount never changes on blur.
    await field.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('150.0')
    assert(norm(await field.inputValue()) === 'Rp 150', `${vp}: pending digits are not shown`)
    await field.blur()
    assert(norm(await field.inputValue()) === 'Rp 150', `${vp}: blur does not change the shown amount`)
    await field.click()
    await page.keyboard.type('5')
    assert(/^Rp 1505$|^Rp 1\.505$/.test(norm(await field.inputValue())), `${vp}: after blur a typed digit is a plain digit (${norm(await field.inputValue())})`)
  }
  return out
}
