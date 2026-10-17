// Evaluate an expression in the POS WebView via CDP (port 9222 forwarded by adb).
// Usage: node cdp.mjs "<js expression>"   (awaits promises, prints JSON)
const expr = process.argv[2]
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((p) => p.type === 'page') ?? list[0]
if (!page) throw new Error('no debuggable page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
const msg = await new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m) } })
ws.close()
const res = msg.result?.result
console.log(JSON.stringify(res?.value ?? res?.description ?? msg, null, 2))
