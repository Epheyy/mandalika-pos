// Local manual regression harness (C2): synthetic memory KV only, no real API or application storage.
// Two parked sales; "Coba lagi" on one row re-queues only that one. Open /tests/parked-per-item/.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SyncEngine, type KV } from '@mandalika/sync'
import { SyncStatus } from '../../src/components/SyncStatus'
import { acknowledge, readAcknowledged } from '../../src/lib/parkedSale'

const store = new Map<string, string>()
const kv: KV = {
  get: (key) => store.get(key) ?? null,
  set: (key, value) => { store.set(key, value) },
  remove: (key) => { store.delete(key) },
  setDurable: async (key, value) => { store.set(key, value) },
  removeDurable: async (key) => { store.delete(key) },
}
const engine = new SyncEngine({ request: async () => { throw new Error('No API in synthetic harness') } }, {}, kv, { actor: null })
const KEYS = ['synthetic-device:order-a', 'synthetic-device:order-b'] as const
for (const key of KEYS) {
  await engine.outbox.add('order', key, { items: [{ marker: key }] })
  for (let n = 0; n < 5; n++) await engine.outbox.fail(key, 'synthetic gateway failure')
}

function Harness() {
  const [, tick] = useState(0)
  const [acked, setAcked] = useState(readAcknowledged)
  const refresh = () => tick((n) => n + 1)
  return <main>
    <h1>C2 synthetic parked-sale check</h1>
    <SyncStatus isOnline={true} pendingCount={engine.pendingCount()} review={engine.reviewItems()} stuck={[]} acknowledged={acked}
      wall={engine.getWall()} isResyncing={false} onResync={() => {}} onFlush={() => {}}
      onRetryFailed={() => { void engine.retryFailed().then(refresh) }}
      onRetryOne={(key) => { void engine.retryDeadLettered(key).then(refresh) }}
      onAcknowledge={(key) => { setAcked((p) => acknowledge(key, p)) }}
      onExportLog={() => {}} />
    <button type="button" onClick={refresh}>Refresh evidence</button>
    <pre aria-label="Per-item evidence">{JSON.stringify({
      parked: engine.deadLettered().map((i) => i.idempotencyKey),
      queued: engine.outbox.pending().map((i) => i.idempotencyKey),
      stored: engine.outbox.all().length,
      acknowledged: [...acked],
    }, null, 2)}</pre>
  </main>
}
createRoot(document.getElementById('root')!).render(<Harness />)
