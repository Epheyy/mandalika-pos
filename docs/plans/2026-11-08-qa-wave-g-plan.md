# QA wave G plan (2026-11-08): F19 stock-pending honesty, F22/W01 single-tab guard

## F19 — "Online · Tersinkron" hides a stale stock snapshot
Keep every throttle (STOCK_FLOOR_MS 300 s, caps, gate). Make the UI say what is true.

1. `packages/sync/src/engine.ts` (NOT journal-guarded): add read-only `stockRefreshPending(): boolean`
   = `!wall.raised && nonWallPullWanted() !== null` (data wall has its own chip text; a stock pull is a full pull).
   No state, no writes, no behaviour change. Unit test in `engine` tests for: seq drift -> true; after pull -> false;
   wall raised -> false; no seq signal and no follow-up -> false.
2. New hook `apps/pos/src/hooks/useStockFreshness.ts`: reads the engine from `SyncContext` (same pattern as
   `useKoneksiData`), polls every 2 s (same cadence as `useOfflineData`), returns `{ stockPending, pulledAt }`.
   `stockPending` becomes visible only after it has been continuously true for `STOCK_PENDING_SHOW_MS` (60 s) so a
   busy multi-tablet outlet does not flicker the chip on every foreign sale. (Open question for planner: 60 s ok?)
   This keeps `CashierScreen.tsx` (wave C) untouched: `SyncStatus` consumes the hook itself.
3. `connectionChip.ts`: new optional input `stockPending`; online branch, after `wallRaised`:
   `{ text: 'Stok menunggu diperbarui', tone: 'info' }`; "Online · Tersinkron" stays only when nothing is pending.
   Offline branches unchanged. Extend `connectionChip.test.ts`.
4. `SyncStatus.tsx`: explanation sentence for the stock-pending state ("Stok produk akan diperbarui otomatis
   setelah keranjang kosong. Perbarui sekarang?"), a "Stok produk: diperbarui HH:MM" line (engine `lastPulledAt`,
   already read by `useKoneksiData`; the existing freshness line is reworded to "Data produk, stok & promo"),
   and the footer "Perbarui data" button also shows for stock-pending (calls the existing `onResync`, a manual,
   ungated `engine.resync()`). Quiet when nothing is pending: no new text, no new button.
5. Tests: chip unit, SyncStatus render test (pending vs quiet), hook test with fake timers, engine test.
   Existing browser scenarios POS-AUTOPULL / POS-STOCKDRIFT assert chip text containing "Tersinkron" after the pull;
   they must still pass (pending clears after the pull).

## F22 + W01 — two tabs on one browser profile
Fix at the web boot layer, not in the store.

1. New `apps/pos/src/tabGuard.ts`: `claimActiveTab(): Promise<'owner' | 'blocked'>`-style API built on
   `navigator.locks`. Native (`Capacitor.isNativePlatform()`) -> no-op `owner`. No `navigator.locks` (insecure
   context, very old browser) -> `owner` (documented fallback, logged once). Otherwise
   `locks.request('mandalika-pos-active-tab', { ifAvailable: true }, cb)`; the callback returns a never-resolving
   promise so the lock is held for the page lifetime and released by the browser on close/reload/crash.
   Reload race (old page still tearing down): retry `ifAvailable` for up to ~1.5 s before declaring `blocked`.
2. `main.tsx` `boot()`: call the guard first thing (after `applyBrand`, before `startupOta`/`bootStorage`, so no
   storage hydrate, no journal, no SyncEngine, no draft hook runs in a second tab). `bootStorage.ts` and every
   other journal-guarded file stay untouched. If `blocked`: render `TabBlocked` ("POS sudah terbuka di tab lain"
   plus short explanation; no cart/sale controls) and queue a plain `locks.request` (no ifAvailable): when the
   first tab closes, the lock is granted and this tab continues the normal boot (nothing was read before, so
   it starts from fresh storage state).
3. `TabBlocked.tsx` (like `BootError`: inline styles, no dependencies on brand/auth/storage).
4. Tests: vitest with a fake `navigator.locks` (first claimant owner, second blocked, grant-after-release boots,
   native no-op, no-locks fallback). Browser scenario `POS-TWO-TABS`: second page in the same context shows the
   blocked screen, never writes the outbox/draft keys (assert localStorage unchanged by tab B), tab A cart intact;
   closing tab A lets B boot. Add to `required-scenarios.json`.

## Not changing / guard status
- No journal-guarded file is touched: `packages/sync/src/journal*.ts`, `outbox.ts`, `outboxStore.ts`, `storage.ts`,
  `syncedRefunds.ts`, `partialRefunds.ts`, `bootStorage.ts`, `terminalBinding.ts`, `apps/pos/android`. `engine.ts`
  is not on the guard list (deliberately; its change is additive and read-only).
- `CashierScreen.tsx`, `ProductGrid.tsx`, other wave-C/D/F files untouched.
- `outboxStore.ts` unchanged: it still assumes one writer; the guard enforces that on web. Residual risk: a
  browser without Web Locks, or two different origins/profiles (not a shared store).

## Questions for the reviewer
1. Is `!wall.raised && nonWallPullWanted() !== null` the right "stock pending" predicate (follow-up pulls included)?
2. 60 s hold-off before the chip changes: ok, or should the chip react at once?
3. Any boot-order hazard with guarding before `startupOta()` (native-only; the guard is a no-op there)?
4. Lock held forever by a never-resolving promise: any StrictMode/HMR/bfcache hazard to cover?

## Review record
- Opus `planner`: AGREE WITH CHANGES, all adopted: queue the lock immediately (no timer-gated boot, so fake-clock
  scenarios cannot hang), one `createRoot`, predicate excludes housekeeping and own-sale follow-ups, stock note no
  longer depends on `autoUpdate`, one freshness line, hook only sets a primitive, `pageshow` reload, gated
  POS-STOCK-PENDING scenario, POS-TWO-TABS counts tab B's storage writes, wiring test for guard-before-boot.
- Opus `reviewer` on the built diff: no CRITICAL/HIGH. Engine refactor confirmed behaviour-equivalent; journal guard
  clean. MEDIUM (stock note promised "otomatis" while the stock hourly cap is not in `autoPullAvailable`): fixed by
  dropping the promise. LOW (queued-request failure was reported as "unguarded"): fixed, fails closed with an honest
  warning + test. LOW (reloading the owner tab hands the app to a waiting tab): documented in the notice copy.
- Owner call left open: with a 300 s floor and a 60 s hold-off, an outlet with steady foreign sales shows
  "Stok menunggu diperbarui" for most of each 5 minutes. Hold-off is `STOCK_PENDING_SHOW_MS` in
  `hooks/useStockPending.ts`.
