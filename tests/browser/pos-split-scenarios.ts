// C6b split payment: rendered POS flows against the synthetic API. Methods in the fixture are cash (Tunai) and qris (QRIS).
import type { ScenarioPage } from './fixture'

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
  await page.getByRole('button', { name: 'Bagi pembayaran', exact: true }).click()
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
  const refundNewest = async (pick: string | null) => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'Struk di Tablet Ini' }).last().click()
    await page.getByTestId('local-receipt-row').first().getByRole('button', { name: 'Refund Transaksi Ini', exact: true }).click()
    const group = page.getByRole('group', { name: 'Dikembalikan lewat' })
    await group.waitFor()
    const chips = await group.getByRole('button').allInnerTexts()
    const pressed = await group.locator('[aria-pressed="true"]').allInnerTexts()
    if (pick) await group.getByRole('button', { name: pick, exact: true }).click()
    await page.getByRole('checkbox', { name: /^Pilih Synthetic Scent/ }).click()
    await page.getByRole('button', { name: 'Lainnya', exact: true }).click()
    await page.getByLabel('Tulis alasan').fill('salah beli')
    await page.getByRole('button', { name: /Konfirmasi Refund/ }).click()
    return { chips, pressed }
  }
  await sellSplit()
  const first = await refundNewest(null)
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
    assert((await page.getByRole('button', { name: 'Bagi pembayaran', exact: true }).count()) === 0, `${label}: no Bagi pembayaran`)
    assert((await page.getByLabel('No. referensi (opsional)').count()) === 1, `${label}: the reference field stays`)
    out.push({ [label]: 'no split entry' })
    await page.getByRole('button', { name: '‹ Kembali' }).click()
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
  await page.getByRole('button', { name: 'Bagi pembayaran', exact: true }).click()
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
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  assert((await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)) === null, 'the draft is deleted once the sale is queued')
  out.push({ restored: 'prompt, restore, paid', draftUuid })

  // Kill/reload right after the enqueue: simulate the lost draft delete by writing the draft back, then reload.
  const sent = orders(page)
  assert(sent.length === 1 && sent[0].payload.orderUuid === draftUuid, 'the queued sale carries the draft order uuid')
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [DRAFT_KEY, draftRaw!])
  await page.reload()
  await page.getByRole('button', { name: /^Synthetic Scent/ }).first().waitFor()
  assert((await page.getByText(/Ada pembayaran terpisah belum selesai/).count()) === 0, 'no prompt for a draft whose sale is already queued')
  assert((await storedOutbox(page)).includes(draftUuid), 'the queued sale is still there with the same orderUuid')
  await page.waitForFunction((k) => localStorage.getItem(k) === null, DRAFT_KEY)
  out.push({ killAfterEnqueue: 'no prompt, one queued sale, same orderUuid, stale draft dropped' })
  return out
}
