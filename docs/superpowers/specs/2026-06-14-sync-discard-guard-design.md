# Sync Dead-Letter Discard Guard — Design

**Date:** 2026-06-14
**Branch:** `prod-hardening`
**Scope:** POS app only (= APK). One file: `apps/pos/src/components/SyncStatus.tsx`. No engine / sync-package / backend / migration change.
**Review tier:** typescript-reviewer (presentational + local state; not a pricing/sync-engine change). Per [[model-routing-policy]].

---

## 1. Context & problem

The POS sync status chip (`SyncStatus.tsx`) shows dead-lettered ("failed") outbox items with two actions:
- **"Coba lagi"** — `onRetryFailed` (re-queues parked items) — already the filled-red primary.
- **"Kirim Log & Tutup"** — `onSendLog` → `discardFailed()` → `engine.discardFailed()` → `outbox.discardDeadLettered()` — permanently removes the parked items after logging them.

`discardDeadLettered()` only ever touches items that failed `MAX_ATTEMPTS=5` times and were never acked — i.e. **transactions the server never recorded** (a dead-lettered `order` crashed `CreateOrder` and rolled back: no sale row, no stock decrement). Today this discard **fires on a single tap** and its caption ("Log disimpan untuk debug; transaksi gagal ditutup agar tidak menghalangi.") frames it as harmless cleanup.

**Real-world impact (observed 2026-06-14):** during SP-Promo-2 on-device testing, promo orders dead-lettered (the NULL-hours `resolvePromo` bug, since fixed in rev `00064-778`). The operator tapped "Kirim Log & Tutup" and permanently discarded those unsynced sales. At scale, one accidental tap = a lost sale + un-decremented stock, silently.

## 2. Goal

Make discarding a dead-letter a **deliberate two-step action** with honest, sale-aware wording, so a single mis-tap can't throw away an unrecorded transaction. Keep retry the easy/primary path.

## 3. Decisions (locked with user, 2026-06-14)

1. **Inline two-step confirm** inside the existing dropdown (no new modal component).
2. **Guard all discards**, but the warning text **names sale-bearing items** (`order`/`refund`) when present.
3. **Defer auto-recovery** of dead-letters (YAGNI — the persistent red "Sinkron gagal (N)" chip already makes manual retry discoverable; auto-requeuing genuinely-poison items risks a churn loop).

## 4. Behavior

In `SyncStatus.tsx`, the `hasFailed` block changes only:

- Keep the failed-items list and the **"Coba lagi"** button (`onRetryFailed`) exactly as-is (filled-red primary).
- Add local state `const [confirmingDiscard, setConfirmingDiscard] = useState(false)`.
- **Un-armed (default):** render the discard button labelled **"Kirim Log & Tutup"** (outlined, secondary). Its `onClick` sets `confirmingDiscard = true` (it no longer calls `onSendLog`).
- **Armed (`confirmingDiscard === true`):** replace the discard button + the soft caption with a confirm row:
  - A warning line. Let `saleCount = failed.filter(f => f.type === 'order' || f.type === 'refund').length`.
    - if `saleCount > 0`: `⚠️ {saleCount} penjualan/refund belum tercatat & akan hilang permanen.`
    - else: `{failed.length} item gagal sinkron akan dihapus.`
  - Two buttons:
    - **"Batal"** (outlined) → `setConfirmingDiscard(false)` (returns to un-armed; nothing discarded).
    - **"Ya, hapus"** (filled red) → `onSendLog()` then `setOpen(false)` (and reset `confirmingDiscard` — see reset rule).
- **Reset rule:** `confirmingDiscard` resets to `false` whenever the dropdown closes, so reopening always starts un-armed. Implement by resetting it in the existing close paths (the backdrop `onClick`, and the chip toggle when it closes) — or via a small effect keyed on `open`. Either is acceptable; the close-handler reset is simplest and matches the file's style.

No change to: the offline/syncing/synced labels, the "Pembaruan tersedia" resync, the "Kirim N antrian" flush, the all-synced empty state, or any prop signature. `onSendLog`/`onRetryFailed`/`failed`/`wall` props are unchanged.

## 5. Components & data flow

- Single component, single responsibility: present sync state + gate the destructive discard locally.
- `failed: FailedItem[]` already carries `.type` (`OutboxType`), so `saleCount` needs **no new prop**.
- The actual discard is still `onSendLog` (unchanged) → the parent's `handleSendLog` (report to server log + `discardFailed()` + share). We only delay *when* it's invoked.

## 6. Testing

- `SyncStatus` is presentational and has no existing component test in the repo (consistent with the project's web-testing posture). Verification = `tsc -b` + `vite build` clean + the on-device tap-through:
  1. With a failed item present, open the chip dropdown → "Coba lagi" + "Kirim Log & Tutup" shown.
  2. Tap "Kirim Log & Tutup" → buttons swap for the ⚠️ warning naming the sale count + "Batal" / "Ya, hapus"; nothing is discarded yet.
  3. "Batal" → back to the un-armed view, items still present.
  4. Re-arm → "Ya, hapus" → items discarded + dropdown closes (existing `onSendLog` behavior: server log + share).
  5. Re-open the dropdown after a Batal/arm cycle → starts un-armed.
- Optional (not required): a vitest render test could assert the two-step gate, but a lone harness for one presentational component is not warranted here.

## 7. Out of scope

- Auto-recovery / auto-requeue of dead-letters after reconnect or a health check.
- Changing `engine`/`outbox` discard semantics or the outbox types.
- Relabeling or restructuring the order outbox.
- Backend / OpenAPI / migration — none.

## 8. Risks & mitigations

- **Stuck-armed state:** if `confirmingDiscard` weren't reset on close, a stale armed view could surprise on reopen → mitigated by the reset rule (§4).
- **Over-warning on non-sale items:** the milder copy for shift/cash_flow/customer_create/transfer_receive keeps the strong "belum tercatat" language for actual sales only, so the warning stays credible.
- **APK required:** POS UI change → new APK + on-device check (USER-PENDING), `gh workflow run android-release.yml` available to the agent.
