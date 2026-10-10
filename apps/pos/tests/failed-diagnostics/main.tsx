// Local manual regression harness: synthetic memory KV only, no real API or
// application storage. Open /tests/failed-diagnostics/ on the POS Vite dev server.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Outbox, SyncEngine, type KV } from '@mandalika/sync'
import { SyncStatus } from '../../src/components/SyncStatus'
import { diagnosticExportMessages, shareFailedSyncDiagnostics } from '../../src/lib/failedSyncDiagnostics'

const store = new Map<string, string>()
const kv: KV = {
  get: (key) => store.get(key) ?? null,
  set: (key, value) => { store.set(key, value) },
  remove: (key) => { store.delete(key) },
  setDurable: async (key, value) => { store.set(key, value) },
  removeDurable: async (key) => { store.delete(key) },
}
const engine = new SyncEngine({ request: async () => { throw new Error('No API in synthetic harness') } }, {}, kv)
for (const type of ['order', 'refund'] as const) {
  const key = `synthetic-device:${type}`
  await engine.outbox.add(type, key, { items: [{ marker: `original-${type}` }], pin: 'SYNTHETIC-PIN' })
  for (let n = 0; n < 5; n++) await engine.outbox.fail(key, 'synthetic gateway failure')
}
const original = JSON.stringify(engine.outbox.all())

function Harness() {
  const [scenario, setScenario] = useState('share success')
  const [message, setMessage] = useState('No export yet')
  const [exports, setExports] = useState(0)
  const send = async () => {
    const share = async () => {
      if (scenario === 'cancel') throw new DOMException('cancelled', 'AbortError')
      if (scenario === 'share failure') throw new Error('synthetic share failure')
    }
    const platform = scenario === 'clipboard failure'
      ? { clipboard: { writeText: async () => { throw new Error('synthetic clipboard failure') } } }
      : { share }
    const outcome = await shareFailedSyncDiagnostics(() => engine.buildFailedSyncDiagnostics(), platform)
    setMessage(diagnosticExportMessages[outcome])
    setExports((count) => count + 1)
  }
  return <main>
    <h1>S0a synthetic diagnostic check</h1>
    <p>Memory storage only. Background synchronization disabled.</p>
    <label>Diagnostic outcome <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
      <option>share success</option><option>cancel</option>
      <option>share failure</option><option>clipboard failure</option>
    </select></label>
    <SyncStatus isOnline={true} pendingCount={engine.pendingCount()} failed={engine.deadLettered()}
      wall={engine.getWall()} isResyncing={false} onResync={() => {}} onFlush={() => {}}
      onRetryFailed={() => engine.retryFailed()} onExportLog={() => { void send() }} />
    <p role="status">{message}</p>
    <pre>{JSON.stringify({
      exports, retained: engine.outbox.all().length,
      unchanged: JSON.stringify(engine.outbox.all()) === original,
      reconstructed: JSON.stringify(new Outbox(kv).all()) === original,
      failed: engine.deadLettered().length,
    }, null, 2)}</pre>
  </main>
}

createRoot(document.getElementById('root')!).render(<Harness />)
