// C6b split payment: rendered POS flows against the synthetic API. Methods in the fixture are cash (Tunai) and qris (QRIS).
import type { ScenarioPage } from './fixture'
import { BAYAR_SHOT_VIEWPORTS, POS_SHOT_VIEWPORTS, SHOT_VIEWPORTS, captureShot, type ShotViewport } from './shots'

const OUTLET = '00000000-0000-4000-8300-000000000090'
const DRAFT_KEY = `mandalika.pos.splitDraft.${OUTLET}`
const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }

const addScent = async (page: ScenarioPage) => {
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
}
const openPay = async (page: ScenarioPage) => { await page.getByRole('button', { name: 'Bayar', exact: true }).click() }
const batchItems = (page: ScenarioPage, type: string) => (page.__a24.writes as any[]).flatMap((w: any) => w.items ?? []).filter((i: any) => i.type === type)
const orders = (page: ScenarioPage) => batchItems(page, 'order')
const storedOutbox = (page: ScenarioPage) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => /outbox/i.test(k)).map((k) => localStorage.getItem(k) ?? '').join('\n'))

/** Split QRIS (with a reference) + cash on a Rp 100.000 cart: QRIS 60.000, cash 50.000 handed over, change 10.000. */
const paySplit = async (page: ScenarioPage) => {
  await openPay(page)
  await page.getByRole('button', { name: 'Split-Payment', exact: true }).click()
  await page.getByRole('button', { name: 'QRIS', exact: true }).click()
  await page.getByLabel('Jumlah pembayaran ini').fill('60000')
  await page.getByLabel('No. referensi (opsional)').fill('8812345')
  await page.getByRole('button', { name: '+ Tambah pembayaran', exact: true }).click()
  assert((await page.locator('body').innerText()).includes('Ref 8812345'), 'the QRIS line shows its reference')
  await page.getByRole('button', { name: 'Tunai', exact: true }).click()
  await page.getByLabel('Jumlah pembayaran ini').fill('50000')
  await page.getByRole('button', { name: '+ Tambah pembayaran', exact: true }).click()
  await page.getByText('Lunas', { exact: true }).waitFor()
  assert((await page.locator('body').innerText()).includes('Kembalian'), 'Kembalian shows once the cash line covers the bill')
  await captureShot(page, 'p6b-bayar-split', BAYAR_SHOT_VIEWPORTS)
}

// POS-SPLIT-TENDER
export const posSplitTender = async (page: ScenarioPage) => {
  const out: any[] = []
  await addScent(page)
  await paySplit(page)
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  const rows = await page.getByTestId('receipt-tender').allInnerTexts()
  assert(rows.length === 2 && /QRIS/.test(rows[0]!) && /8812345/.test(rows[0]!) && /Tunai/.test(rows[1]!), 'the receipt lists one row per line: ' + rows.join(' | '))
  const sent = orders(page)
  assert(sent.length === 1, 'one order queued')
  const p = sent[0].payload
  assert(p.paymentMethod === 'split' && p.amountPaid === 110000, 'summary scalars: split, sum of tendered')
  assert(
    JSON.stringify(p.tenders) === JSON.stringify([{ method: 'qris', amount: 60000, reference: '8812345' }, { method: 'cash', amount: 50000 }]),
    'tenders on the wire: ' + JSON.stringify(p.tenders),
  )
  assert(p.receiptSnapshot.change === 10000 && p.receiptSnapshot.tenders.length === 2, 'the snapshot carries the lines and the change')
  out.push({ receipt: rows.map((r) => r.replace(/\s+/g, ' ')), payload: 'split + 2 tenders, change 10.000' })
  await page.getByRole('button', { name: 'Transaksi Baru', exact: true }).click()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'Struk di Tablet Ini' }).last().click()
  const row = page.getByTestId('local-receipt-row').first()
  await row.waitFor()
  assert((await row.innerText()).includes('Split-Payment'), 'the local receipt reads Split-Payment')
  assert((await page.getByTestId('local-receipt-tender').count()) === 2, 'the local receipt lists both lines')
  out.push({ history: 'Split-Payment with 2 lines' })
  return out
}

// POS-SPLIT-OFFLINE
export const posSplitOffline = async (page: ScenarioPage) => {
  const out: any[] = []
  page.__a24.netDown = true
  await addScent(page)
  await paySplit(page)
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  assert(orders(page).length === 0, 'nothing reached the server while offline')
  assert((await storedOutbox(page)).includes('8812345'), 'the split sale is queued on the tablet with its reference')
  out.push({ offline: 'queued, nothing sent' })
  await page.reload()
  await page.getByRole('button', { name: /^Synthetic Scent/ }).first().waitFor()
  page.__a24.netDown = false
  page.__a24.ackBatch = true
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  const deadline = Date.now() + 30000
  while (orders(page).length === 0 && Date.now() < deadline) await page.waitForTimeout(500)
  const sent = orders(page)
  assert(sent.length >= 1, 'the queued split sale reached the server after reconnecting')
  assert(Array.isArray(sent[0].payload.tenders) && sent[0].payload.tenders.length === 2, 'the server batch carries the tenders')
  out.push({ reconnect: 'acked with tenders', lines: sent[0].payload.tenders.length })
  return out
}

// POS-SPLIT-REFUND
export const posSplitRefund = async (page: ScenarioPage) => {
  const out: any[] = []
  const sellSplit = async () => {
    await addScent(page)
    await paySplit(page)
    await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
    await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
    await page.getByRole('button', { name: 'Transaksi Baru', exact: true }).click()
  }
  const refundNewest = async (pick: string | null, shots = false) => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'Struk di Tablet Ini' }).last().click()
    if (shots) await captureShot(page, 'p4-struk-di-tablet', POS_SHOT_VIEWPORTS)
    await page.getByTestId('local-receipt-row').first().getByRole('button', { name: 'Refund Transaksi Ini', exact: true }).click()
    const group = page.getByRole('group', { name: 'Dikembalikan lewat' })
    await group.waitFor()
    const chips = await group.getByRole('button').allInnerTexts()
    const pressed = await group.locator('[aria-pressed="true"]').allInnerTexts()
    if (pick) await group.getByRole('button', { name: pick, exact: true }).click()
    await page.getByRole('checkbox', { name: /^Pilih Synthetic Scent/ }).click()
    await page.getByRole('button', { name: 'Lainnya', exact: true }).click()
    await page.getByLabel('Tulis alasan').fill('salah beli')
    if (shots) await captureShot(page, 'p4-refund-dialog', POS_SHOT_VIEWPORTS)
    await page.getByRole('button', { name: /Konfirmasi Refund/ }).click()
    // P4: the success toast names the sale; CashierScreen raises it (inside the ToastProvider) only after the refund is stored.
    await page.getByText(/^Refund \S+ diproses/).waitFor()
    return { chips, pressed }
  }
  await sellSplit()
  const first = await refundNewest(null, !!process.env.A34C_RUN_DIR)
  assert(first.chips.length === 2 && first.pressed.join() === 'Tunai', 'two chips, cash preselected: ' + JSON.stringify(first))
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => /outbox/i.test(k) && (localStorage.getItem(k) ?? '').includes('"payoutMethod":"cash"')))
  out.push({ queuedWith: 'payoutMethod cash' })
  out.push({ default: first })

  await sellSplit()
  const second = await refundNewest('QRIS')
  assert(second.chips.length === 2, 'the second sale offers the same chips')
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => /outbox/i.test(k) && (localStorage.getItem(k) ?? '').includes('"payoutMethod":"qris"')))
  out.push({ chosen: 'qris' })
  return out
}

// POS-SPLIT-OFF
export const posSplitOff = async (page: ScenarioPage) => {
  const out: any[] = []
  const check = async (label: string) => {
    await addScent(page)
    await openPay(page)
    await page.getByRole('button', { name: 'QRIS', exact: true }).click()
    assert((await page.getByRole('button', { name: 'Split-Payment', exact: true }).count()) === 0, `${label}: no Split-Payment`)
    assert((await page.getByLabel('No. referensi (opsional)').count()) === 1, `${label}: the reference field stays`)
    out.push({ [label]: 'no split entry' })
    await page.getByRole('heading', { name: 'Bayar', exact: true }).locator('..').getByRole('button', { name: 'Kembali', exact: true }).click()
  }
  await check('key absent')
  page.__a24.snapshot.appSettings.splitTenderEnabled = false
  page.__a24.version += 1
  await page.reload()
  await page.getByRole('button', { name: /^Synthetic Scent/ }).first().waitFor()
  await check('setting false')
  return out
}

// POS-SPLIT-DRAFT
export const posSplitDraft = async (page: ScenarioPage) => {
  const out: any[] = []
  await addScent(page)
  await openPay(page)
  await page.getByRole('button', { name: 'Split-Payment', exact: true }).click()
  await page.getByRole('button', { name: 'QRIS', exact: true }).click()
  await page.getByLabel('Jumlah pembayaran ini').fill('60000')
  await page.getByRole('button', { name: '+ Tambah pembayaran', exact: true }).click()
  await page.waitForFunction((k) => !!localStorage.getItem(k), DRAFT_KEY)
  const draftRaw = await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)
  const draftUuid = JSON.parse(draftRaw!).orderUuid as string
  out.push({ saved: 'draft written when the QRIS line was added' })

  // App kill / reload mid-payment: the prompt comes back and restore reopens W2 with the line.
  await page.reload()
  await page.getByText(/Ada pembayaran terpisah belum selesai: QRIS/).waitFor()
  await page.getByRole('button', { name: 'Lanjutkan', exact: true }).click()
  await page.getByText('Sisa tagihan', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Tunai', exact: true }).click()
  await page.getByLabel('Jumlah pembayaran ini').fill('40000')
  await page.getByRole('button', { name: '+ Tambah pembayaran', exact: true }).click()
  await page.getByText('Lunas', { exact: true }).waitFor()
  // The network stays down so the sale is still IN THE OUTBOX (unsent) when the app is "killed" below.
  page.__a24.netDown = true
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  assert((await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)) === null, 'the draft is deleted once the sale is queued')
  out.push({ restored: 'prompt, restore, paid', draftUuid })

  // Kill/reload right after the enqueue: simulate the lost draft delete by writing the draft back, then reload.
  const queuedCount = async (uuid: string) => {
    const text = await storedOutbox(page)
    return { sales: text.split('"type":"order"').length - 1, withUuid: text.split(`"orderUuid":"${uuid}"`).length - 1 }
  }
  const before = await queuedCount(draftUuid)
  assert(before.sales === 1 && before.withUuid === 1, 'exactly one queued sale, carrying the draft order uuid: ' + JSON.stringify(before))
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [DRAFT_KEY, draftRaw!])
  await page.reload()
  await page.getByRole('button', { name: /^Synthetic Scent/ }).first().waitFor()
  assert((await page.getByText(/Ada pembayaran terpisah belum selesai/).count()) === 0, 'no prompt for a draft whose sale is already queued')
  const after = await queuedCount(draftUuid)
  assert(after.sales === 1 && after.withUuid === 1, 'still exactly one queued sale with the same orderUuid after the reload: ' + JSON.stringify(after))
  await page.waitForFunction((k) => localStorage.getItem(k) === null, DRAFT_KEY)
  out.push({ killAfterEnqueue: 'no prompt, one queued sale, same orderUuid, stale draft dropped' })
  return out
}

// POS-BAYAR-OVERFLOW (QA wave B: F16, F31, U5): five methods, a 246-char unbroken note and split mode never push the Bayar dialog
// sideways, at the fleet tablet in both orientations; the chosen method and Konfirmasi stay on screen.
export const posBayarOverflow = async (page: ScenarioPage) => {
  const out: any[] = []
  await addScent(page)
  await page.getByRole('button', { name: 'Catatan', exact: true }).first().click()
  await page.getByRole('textbox', { name: 'Catatan order' }).fill('N'.repeat(246))
  await page.getByRole('button', { name: 'Simpan', exact: true }).click()
  await openPay(page)
  await page.getByRole('button', { name: 'NEOBANK', exact: true }).waitFor()
  assert((await page.getByRole('dialog').getByText('N'.repeat(246)).count()) === 1, 'the long note is shown in Bayar')
  const original = page.viewportSize()
  const measure = async (label: string) => {
    for (const vp of ['pos-a9', 'pos-a9-portrait'] as ShotViewport[]) {
      await page.setViewportSize(SHOT_VIEWPORTS[vp])
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      })
      const m = await page.evaluate(() => {
        const dialog = document.querySelector('[role=dialog]') as HTMLElement
        const w = window.innerWidth
        const h = window.innerHeight
        const inside = (el: Element | null) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= w + 0.5 && r.top >= 0 && r.bottom <= h + 0.5 }
        const sw = document.querySelector('[role=dialog] [aria-label="Metode pembayaran"]')
        const buttons = [...(sw?.querySelectorAll('button') ?? [])]
        const confirm = [...dialog.querySelectorAll('button')].find((b) => /^Konfirmasi\s*Rp/.test(b.textContent ?? '')) ?? null
        const bodyEl = dialog.querySelector('.overflow-y-auto') as HTMLElement | null
        return {
          noHScroll: dialog.scrollWidth <= dialog.clientWidth + 1 && (!bodyEl || bodyEl.scrollWidth <= bodyEl.clientWidth + 1),
          switchInside: buttons.length === 5 && buttons.every((b) => b.getBoundingClientRect().right <= (sw as HTMLElement).getBoundingClientRect().right + 0.5) && buttons.every((b) => b.getBoundingClientRect().height >= 43.5) && buttons.every((b) => b.scrollWidth <= b.clientWidth + 1),
          dialogInside: dialog.getBoundingClientRect().right <= w + 0.5,
          confirmInside: inside(confirm),
          // Split entry row: the amount field and the Sisa chip next to it stay inside the sheet's right edge (a vertical scroll is fine).
          entryInside: (() => { const f = dialog.querySelector('#split-amount'); if (!f) return true; const edge = dialog.getBoundingClientRect().right; const chip = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Sisa'); return f.getBoundingClientRect().right <= edge + 0.5 && (!chip || chip.getBoundingClientRect().right <= edge + 0.5) })(),
        }
      })
      assert(m.noHScroll && m.switchInside && m.dialogInside && m.confirmInside && m.entryInside, `${label} @${vp}: ${JSON.stringify(m)}`)
      out.push({ step: label, vp })
    }
  }
  try {
    await measure('single, 5 methods + long note')
    await captureShot(page, 'qa-b-bayar-single', ['pos-a9', 'pos-a9-portrait'])
    await page.getByRole('button', { name: 'NEOBANK', exact: true }).click()
    await measure('single, NEOBANK selected')
    await page.getByRole('button', { name: 'Split-Payment', exact: true }).click()
    await page.getByRole('button', { name: 'NEOBANK', exact: true }).click()
    await measure('split, NEOBANK selected')
    for (const vp of ['pos-a9', 'pos-a9-portrait'] as ShotViewport[]) {
      // Scroll the entry row (field + Sisa chip + Sisa tagihan) into view so the shot shows it, not the note.
      await page.setViewportSize(SHOT_VIEWPORTS[vp])
      await page.locator('#split-amount').evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await captureShot(page, 'qa-b-bayar-split-entry', [vp])
    }
    await page.getByRole('button', { name: 'Tunai', exact: true }).click()
    await measure('split, Tunai selected')
  } finally {
    if (original) await page.setViewportSize(original)
  }
  return out
}
