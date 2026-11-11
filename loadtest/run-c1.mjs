// Scenario C1: the busy moment. Usage: node loadtest/run-c1.mjs [out.json]
//  - 60 cashier clients (2 per outlet), each signed in as its own cashier.
//  - One shift is opened per outlet through the real sync path (shift_open); the DB allows one open shift per
//    outlet (migration 0053), so the 2 cashiers of an outlet share it, which is also how the sale envelope works.
//  - Each client sends 50 sales through POST /api/v1/sync/batch in chunks of 25 (BATCH_MAX_ITEMS of packages/sync),
//    all clients starting together; 5 Backoffice clients loop R2 + R4 for the whole run.
//  - Then every one of the 3,000 sales is resent (idempotency replay), same payloads and keys.
//  - SQL verification: +3000 orders, no duplicate keys/numbers, replay adds 0, stock moved by exactly the sold qty.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { call, login, summarize, row, TABLE_HEAD, jakartaDay, psql, sleep } from './lib.mjs'

const CLIENTS = Number(process.env.LT_CLIENTS ?? 60)
const SALES = 50
const CHUNK = 25 // BATCH_MAX_ITEMS in packages/sync/src/engine.ts
const BO_CLIENTS = Number(process.env.LT_BO_CLIENTS ?? 5)

const rnd = (n) => Math.floor(Math.random() * n)
const today = jakartaDay(0)

// ── sign in ──────────────────────────────────────────────
const admin = await login('admin@mandalika.local')
const outlets = (await call('GET', '/api/v1/outlets', { token: admin.token })).json
const outletRows = outlets?.data ?? outlets
const outletByCode = Object.fromEntries(outletRows.map((o) => [o.code, o]))

const clients = []
for (let o = 1; o <= 30; o++) {
  for (let c = 1; c <= 2; c++) {
    const code = 'L' + String(o).padStart(2, '0')
    const email = `cashier-${code.toLowerCase()}-${c}@load.local`
    const s = await login(email)
    clients.push({ code, email, outletId: outletByCode[code].id, outletName: outletByCode[code].name, userId: s.user.id,
      token: s.token, deviceId: randomUUID(), shiftId: null })
  }
}
console.log(`signed in ${clients.length} cashiers`)

// ── open one shift per outlet via sync/batch ─────────────────
await Promise.all(clients.filter((c) => c.email.endsWith('-1@load.local')).map(async (c) => {
  const key = `${c.deviceId}:${randomUUID()}`
  const r = await call('POST', '/api/v1/sync/batch', { token: c.token, outlet: c.outletId, body: { items: [{
    type: 'shift_open', idempotencyKey: key, payload: { startingCash: 500000, outletName: c.outletName },
    envelope: { v: 1, outletId: c.outletId, userId: c.userId, deviceId: c.deviceId, capturedAt: new Date().toISOString(), shiftId: '', appVersion: 'loadtest' },
  }] } })
  const res = r.json?.data?.results?.[0]
  if (res?.status === 'error' && /already open/.test(res.error ?? '')) { // rerun: the outlet still has last run's shift
    c.shiftId = psql(`SELECT id FROM shifts WHERE outlet_id='${c.outletId}' AND status='open'`)
    return
  }
  if (r.status !== 200 || res?.status !== 'ok') throw new Error(`shift_open ${c.code}: ${r.status} ${r.text?.slice(0, 200)}`)
  c.shiftId = res.orderId
}))
for (const c of clients) c.shiftId ??= clients.find((x) => x.code === c.code && x.shiftId).shiftId
clients.length = Math.min(clients.length, CLIENTS) // LT_CLIENTS < 60 for scaling runs
console.log('shifts open')

// ── catalogue + stock snapshot ───────────────────────────────
const variants = psql(`SELECT v.product_id, p.name, v.size, v.price FROM product_variants v JOIN products p ON p.id=v.product_id ORDER BY v.sku`)
  .split('\n').map((l) => { const [productId, name, size, price] = l.split('|'); return { productId, name, size, price: +price } })
const customerSample = psql(`SELECT id FROM customers TABLESAMPLE SYSTEM (0.2) LIMIT 400`).split('\n')
const stockSnap = () => Object.fromEntries(psql(`SELECT outlet_id||'/'||product_id||'/'||variant_size, stock FROM outlet_variant_stock`).split('\n').map((l) => l.split('|')))
const count = (sql) => +psql(sql)
const before = {
  orders: count(`SELECT count(*) FROM orders`), keys: count(`SELECT count(*) FROM processed_keys`), stock: stockSnap(),
  variantStockSum: count(`SELECT coalesce(sum(stock),0) FROM product_variants`),
  tenders: count(`SELECT count(*) FROM order_tenders`), items: count(`SELECT count(*) FROM order_items`),
}
const t0Wall = new Date()

// ── build 50 sales per client ────────────────────────────────
const expected = {} // outlet/product/size -> sold qty
let seq = 0
for (const c of clients) {
  c.items = []
  for (let i = 0; i < SALES; i++) {
    const orderUuid = randomUUID()
    const lines = []
    const nLines = 1 + rnd(4)
    for (let l = 0; l < nLines; l++) {
      const v = variants[rnd(variants.length)]
      const qty = Math.random() < 0.8 ? 1 : 2
      lines.push({ productId: v.productId, productName: v.name, variantSize: v.size, price: v.price, quantity: qty, subtotal: v.price * qty, isBundle: false })
      const k = `${c.outletId}/${v.productId}/${v.size}`
      expected[k] = (expected[k] ?? 0) + qty
    }
    const total = lines.reduce((s, x) => s + x.subtotal, 0)
    const now = new Date().toISOString()
    const withCust = Math.random() < 0.3
    const payload = {
      orderUuid, orderNumber: `${c.code}-${c.deviceId.slice(0, 8).toUpperCase()}${String(++seq).padStart(6, '0')}`, deviceId: c.deviceId,
      items: lines, paymentMethod: 'cash', amountPaid: total, quotedTotal: total, shiftId: c.shiftId, clientCreatedAt: now,
      ...(withCust ? { customerId: customerSample[rnd(customerSample.length)], customerName: 'Pelanggan Uji' } : {}),
    }
    c.items.push({ type: 'order', idempotencyKey: `${c.deviceId}:${orderUuid}`, payload,
      envelope: { v: 1, outletId: c.outletId, userId: c.userId, deviceId: c.deviceId, capturedAt: now, shiftId: c.shiftId, appVersion: 'loadtest' } })
  }
}

// ── Backoffice background load ──────────────────────────────
const bo = { r2: [], r4s: [], r4d: [] }
let boStop = false
async function boLoop(i) {
  const from = jakartaDay(-29 - i), to = jakartaDay(-i) // distinct windows so the 15 s cache is not shared
  while (!boStop) {
    const a = await call('GET', `/api/v1/orders?outletId=all&dateFrom=${from}&dateTo=${to}&page=1&limit=50`, { token: admin.token })
    bo.r2.push({ ms: a.ms, status: a.status })
    const b = await call('GET', `/api/v1/reports/summary?outletId=all&dateFrom=${from}&dateTo=${to}`, { token: admin.token })
    bo.r4s.push({ ms: b.ms, status: b.status })
    const c = await call('GET', `/api/v1/reports/dashboard?outletId=all&dateFrom=${from}&dateTo=${to}&trend=day&tzOffset=420`, { token: admin.token })
    bo.r4d.push({ ms: c.ms, status: c.status })
    await sleep(500)
  }
}

// ── send helper: a client's items in chunks of 25, sequentially (as the engine does) ──
async function runClient(c, label, sink, tally) {
  for (let at = 0; at < c.items.length; at += CHUNK) {
    const chunk = c.items.slice(at, at + CHUNK)
    const r = await call('POST', '/api/v1/sync/batch', { token: c.token, outlet: c.outletId, body: { items: chunk } })
    sink.push({ ms: r.ms, status: r.status })
    for (const x of r.json?.data?.results ?? []) {
      tally[x.status] = (tally[x.status] ?? 0) + 1
      if (x.status === 'error') (tally._errs ??= []).length < 10 && tally._errs.push(`${x.code}: ${x.error}`)
    }
    if (r.status !== 200) tally[`http${r.status}`] = (tally[`http${r.status}`] ?? 0) + chunk.length
  }
}

async function phase(label) {
  const sink = [], tally = {}
  const t0 = performance.now()
  await Promise.all(clients.map((c) => runClient(c, label, sink, tally)))
  return { sink, tally, wallMs: performance.now() - t0 }
}

console.log('BO clients + sale upload start')
const boRuns = Array.from({ length: BO_CLIENTS }, (_, i) => boLoop(i))
const up = await phase('upload')
const tUpload = performance.now()
const afterUpload = {
  orders: count(`SELECT count(*) FROM orders`), keys: count(`SELECT count(*) FROM processed_keys`), stock: stockSnap(),
  variantStockSum: count(`SELECT coalesce(sum(stock),0) FROM product_variants`),
  tenders: count(`SELECT count(*) FROM order_tenders`), items: count(`SELECT count(*) FROM order_items`),
}
console.log('replay start')
const rp = await phase('replay')
boStop = true
await Promise.all(boRuns)
const afterReplay = { orders: count(`SELECT count(*) FROM orders`), keys: count(`SELECT count(*) FROM processed_keys`), stock: stockSnap() }

// ── verification ─────────────────────────────────────────────
const keys = clients.flatMap((c) => c.items.map((i) => i.idempotencyKey))
const mine = `created_at >= '${t0Wall.toISOString()}'::timestamptz AND order_number NOT LIKE 'MND-%'`
const dupKeys = count(`SELECT count(*) FROM (SELECT idempotency_key FROM orders GROUP BY 1 HAVING count(*)>1) x`)
const dupNos = count(`SELECT count(*) FROM (SELECT order_number FROM orders WHERE ${mine} GROUP BY 1 HAVING count(*)>1) x`)
const dupUuid = count(`SELECT count(*) FROM (SELECT order_uuid FROM orders GROUP BY 1 HAVING count(*)>1) x`)
const mineOrders = count(`SELECT count(*) FROM orders WHERE ${mine}`)
const wrongStock = []
for (const k of new Set([...Object.keys(expected), ...Object.keys(before.stock)])) {
  const sold = expected[k] ?? 0
  const moved = +before.stock[k] - +afterReplay.stock[k]
  if (moved !== sold) wrongStock.push({ k, sold, moved })
}
const stockWrongAfterUpload = Object.keys(expected).filter((k) => +before.stock[k] - +afterUpload.stock[k] !== expected[k]).length
const replayStockDrift = Object.keys(afterUpload.stock).filter((k) => afterUpload.stock[k] !== afterReplay.stock[k]).length
const soldTotal = Object.values(expected).reduce((a, b) => a + b, 0)
const verify = {
  newOrdersAfterUpload: afterUpload.orders - before.orders, expectedNewOrders: clients.length * SALES,
  newProcessedKeys: afterUpload.keys - before.keys, newTenders: afterUpload.tenders - before.tenders,
  newItems: afterUpload.items - before.items, ordersCreatedSinceStart: mineOrders,
  replayNewOrders: afterReplay.orders - afterUpload.orders, replayNewKeys: afterReplay.keys - afterUpload.keys,
  duplicateIdempotencyKeys: dupKeys, duplicateOrderNumbers: dupNos, duplicateOrderUuids: dupUuid,
  soldUnits: soldTotal, stockKeysWithWrongDelta: wrongStock.length, wrongStockSample: wrongStock.slice(0, 5),
  stockKeysWrongAfterUploadPhase: stockWrongAfterUpload, // nonzero only when items were deferred (busy) and landed in the resend
  stockKeysChangedDuringReplay: replayStockDrift,
  legacyProductVariantsStockSumChanged: afterUpload.variantStockSum !== before.variantStockSum,
  keysSent: keys.length, keysUnique: new Set(keys).size,
}
const uploadRow = summarize('C1 sale upload, POST /sync/batch (25 items/request)', up.sink)
const replayRow = summarize('C1 replay, POST /sync/batch (25 items/request)', rp.sink)
const bo2 = summarize('BO during C1: R2 orders 30d all outlets p1', bo.r2)
const bo4s = summarize('BO during C1: R4 reports/summary 30d', bo.r4s)
const bo4d = summarize('BO during C1: R4 reports/dashboard', bo.r4d)
const out = { at: new Date().toISOString(), config: { CLIENTS, SALES, CHUNK, BO_CLIENTS }, uploadWallSeconds: +(up.wallMs / 1000).toFixed(2),
  replayWallSeconds: +(rp.wallMs / 1000).toFixed(2), uploadTally: up.tally, replayTally: rp.tally, verify, rows: [uploadRow, replayRow, bo2, bo4s, bo4d] }
console.log('\n' + TABLE_HEAD + '\n' + out.rows.map(row).join('\n'))
console.log(JSON.stringify({ uploadWallSeconds: out.uploadWallSeconds, replayWallSeconds: out.replayWallSeconds, uploadTally: up.tally, replayTally: rp.tally, verify }, null, 2))
writeFileSync(process.argv[2] ?? 'loadtest-c1.json', JSON.stringify(out, null, 2))
