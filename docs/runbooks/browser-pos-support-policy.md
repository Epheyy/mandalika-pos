# Browser POS support policy (F22/W01)

Production POS is the Android APK: one WebView, so one POS instance per tablet. The browser POS is for development and QA.

## What the browser guard does

- On start, the POS takes the Web Lock `mandalika-pos-active-tab` (`apps/pos/src/tabGuard.ts`) before anything reads or writes storage.
- A second tab in the same browser profile shows "POS sudah terbuka di tab lain", writes nothing and calls no API. It starts by itself, with the first tab's open-cart draft, when the first tab closes. No reload is needed (browser scenario `POS-TWO-TABS-TAKEOVER`).
- If the first tab **navigates to another site** instead of closing, the second tab stays on the notice until that first tab is closed. The browser can keep the old page (and its lock) alive for back/forward. To hand over, close the first tab. This is accepted by the owner (2026-11-09, Codex R11 F22), and there is no plan to fix it. Releasing the lock on departure would touch the single-writer boundary below, and the APK is unaffected.
- If the owner **reloads** while a second tab is waiting, the waiting tab owns the POS afterwards and the reloaded page waits behind it (the queue is first come, first served).
- The APK skips the guard (no-op).

## Support levels

| Environment | Level |
|---|---|
| APK (Capacitor) | Production. No guard, no notice. |
| Chromium-based browsers with Web Locks (Chrome, Edge) | Supported for dev/QA. One-tab protection is tested in the browser gate with headless Chromium (Edge is the same engine, not run separately). |
| Firefox, Safari | Have Web Locks, so the guard runs, but it is not tested here. Not supported. |
| Web Locks missing or the request failing (old browser, or an insecure context such as Chrome on `http://<LAN-IP>:5183`, where `navigator.locks` does not exist) | Runs with the guard off and a persistent notice: "Perlindungan satu tab tidak aktif di browser ini. Buka POS di satu tab saja." Open one tab only. |

The guard fails open (the POS still starts) when Web Locks are missing or the first request fails. One path fails closed: if a second tab's queued request is rejected, that tab stays on the other-tab notice and does not start (console warning only), even after the owner is gone; reload it.  Switching to fail-closed (refuse to start without the lock) is an owner decision and has not been made.

## Remaining boundary

The outbox store (`packages/sync/src/outboxStore.ts`) still replaces the whole KV array from one writer. The tab guard is what keeps a second writer away from it; where the guard is off, two tabs can still drop a queued sale.
