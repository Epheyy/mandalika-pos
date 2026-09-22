// Local-only UI fixture: no fetch, token, real customer data or device storage.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { refundPermissionFixture } from '../../../../packages/sync/src/testFixtures/refundPermission'
import { SyncStatus } from '../../src/components/SyncStatus'

const fixture = refundPermissionFixture()
let engine = fixture.engine

function Harness() {
  const [, refresh] = useState(0)
  const [exports, setExports] = useState(0)
  const [reconstructions, setReconstructions] = useState(0)
  const [remount, setRemount] = useState(0)
  const update = () => refresh((n) => n + 1)
  const denyFive = async () => { for (let n = 0; n < 5; n++) await engine.flush(); update() }
  const reconstruct = () => { engine = fixture.reconstruct(); setRemount((n) => n + 1); setReconstructions((n) => n + 1) }
  const retry = async () => { engine.retryFailed(); await engine.flush(); update() }
  return <main>
    <h1>S0b synthetic refund retention</h1>
    <p>Successful memory storage and synthetic API only. No live database or native durability claim.</p>
    <button onClick={() => { void denyFive() }}>Deliver five permission denials</button>
    <button onClick={reconstruct}>Reconstruct from same storage</button>
    <button onClick={() => { fixture.delivery.permission = true; update() }}>Restore synthetic permission</button>
    <SyncStatus key={remount} isOnline={true} pendingCount={engine.pendingCount()} failed={engine.deadLettered()}
      wall={engine.getWall()} isResyncing={false} onResync={() => {}} onFlush={() => { void engine.flush().then(update) }}
      onRetryFailed={() => { void retry() }} onExportLog={() => { engine.buildFailedSyncDiagnostics(); setExports((n) => n + 1) }} />
    <pre aria-label="Retention evidence">{JSON.stringify({
      exports, reconstructions, permission: fixture.delivery.permission,
      pending: engine.pendingCount(), failed: engine.deadLettered().length,
      retained: engine.outbox.all(), deliveries: fixture.sent,
      simulatedMutationCalls: fixture.delivery.mutationCalls,
    }, null, 2)}</pre>
  </main>
}

createRoot(document.getElementById('root')!).render(<Harness />)
