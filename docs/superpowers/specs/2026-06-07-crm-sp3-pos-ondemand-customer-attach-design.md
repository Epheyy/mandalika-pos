# SP-CRM-3 — POS On-Demand Customer Attach (Design)

Date: 2026-06-07 · Branch: `prod-hardening` · Module: Customers (Pelanggan) / CRM · **POS + APK**

## Context

CRM module progress in [[crm-customers-module]]. SP-CRM-1 (hub) + SP-CRM-2 (scale foundation:
trigram/sort indexes, sort toggle, server-side `by-phone` dup-check, and the cashier on-demand
**`GET /api/v1/sync/customers/lookup`** endpoint — built but unconsumed) are DONE & deployed
(rev `00049-kv7`, migrations →0026).

**The problem SP-CRM-3 fixes:** the POS bulk-syncs the **entire** customer table to **every** outlet.
`backend/internal/sync/sync.go:103` calls `Customers(ctx, 1, 100000, "", "")` (unscoped, cap 100k),
and `apps/pos/src/cashier/CashierScreen.tsx` puts `snapshot.customers` into an in-memory list the
`CustomerPicker` filters client-side. At the brand's real scale (30+ outlets, thousands trx/day,
**50k–500k identified customers**) this is unviable — huge payload, memory, mobile-data cost.

**Current POS customer flow (verified in code):**
- `snapshot.customers` (from the sync pull) + session-local creates → the picker's `customers` array,
  filtered client-side by name/phone substring. **Attaching an existing customer works OFFLINE**
  because the whole list is on-device.
- **New customer:** on-device UUID → offline `customer_create` outbox op (FIFO, flushes before the
  sale) → `service.OrderService.CreateCustomer` inserts with the client id. **Works fully offline.**

So removing the bulk list must not break offline existing-customer attach. Outlet connectivity
**varies a lot by outlet**, so the design degrades gracefully: on-demand when online, a bounded
local cache when offline.

## Goals

1. Replace the global bulk customer sync with a **bounded per-outlet recent-customer cache** (offline
   coverage of who's likely to return at that outlet).
2. Add **on-demand online lookup** to the cashier picker (consume SP-CRM-2's `/sync/customers/lookup`),
   merged with the local cache; offline falls back to the cache.
3. **Detect + flag** offline-miss duplicate customers (same phone) for a future merge tool — without
   merging anything now.
4. Roll out with **zero device degradation** (APK first, backend flip second).

## Phasing (zero-degradation rollout)

This sprint **builds everything**, but the destructive/heavy change is gated:

- **Phase 1 — deploy now (APK + safe backend):**
  - POS APK: picker gains on-demand online lookup + offline cache fallback (backend bootstrap
    **unchanged**, still sends the current list → nothing degrades).
  - Backend: `customer_create` dup-detection + flag (migration 0027); the bounded per-outlet query
    **implemented but NOT wired** into the sync bootstrap; supporting index.
- **Phase 2 — user-gated follow-up (after the fleet reports updated):**
  - One-line backend flip: sync bootstrap `Customers(1,100000)` → `RecentCustomersForOutlet(...)`.
    **This is when the heavy-load win lands.** Marked in the plan: **DO NOT deploy until the user
    confirms the APK fleet is updated.**

## Non-goals (later sprints)

- **The customer-merge tool** → new **SP-CRM-Merge** sprint: a **backoffice approval review queue**
  (staff see each flagged pair side-by-side, confirm/dismiss; the merge re-points the dup's orders,
  lets aggregates recompute, resolves field conflicts, tombstones the dup). Destructive + judgment-
  laden (same phone ≠ same person) → human-in-the-loop, never auto-merge. SP-CRM-3 only records
  candidates.
- Tags (SP-CRM-4), segment engine (SP-CRM-5), lifecycle/interaction log (SP-CRM-6), points ledger
  (SP-CRM-7).
- Changing the offline `customer_create` create-with-client-id behavior (kept, so in-flight orders
  stay consistent).
- Phone normalization (still deferred).

## Key decisions (locked with the user)

| Decision | Choice | Rationale |
|---|---|---|
| Offline cache | **Per-outlet recent customers** (bounded) | Caches who's likely to return at that outlet; small vs 100k global. |
| Cache bound | **last 90 days, cap 1000 most-recent distinct** | Balanced coverage vs payload; tunable later. |
| Online attach | On-demand `/sync/customers/lookup`, merged with local cache; offline → cache only | Graceful degradation for "varies a lot by outlet". |
| Offline-miss dup | **Accept + flag** (detect on `customer_create`, record candidate, still create with client id) | Online lookup prevents the common case; true reconciliation needs an id-alias layer (out of scope). |
| Merge tool | **Backoffice approval queue, deferred** (own sprint) | Merges are destructive + judgment-laden; human-in-the-loop. |
| Rollout | **APK first → user confirms fleet updated → backend flip** | Zero device degradation. |

## Data model — migration `0027`

```sql
-- 0027_customer_dup_candidates.sql
CREATE TABLE customer_dup_candidates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  new_customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  existing_customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone                text NOT NULL,
  status               text NOT NULL DEFAULT 'pending',  -- pending | merged | dismissed
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dup_candidates_status ON customer_dup_candidates(status);

-- Supports RecentCustomersForOutlet (distinct customers per outlet, recent-first)
-- on the multi-million-row orders table.
CREATE INDEX idx_orders_outlet_created ON orders (outlet_id, created_at DESC);
```

The `status` column makes the table **review-queue-ready** so the future SP-CRM-Merge tool needs no
further migration.

**Flag (rule 3):** `idx_orders_outlet_created` adds one btree to the **hot `orders` table** (highest
write rate). Cost is modest (one composite btree; orders already carries 4 indexes) and the bounded
query runs only at device sync-bootstrap (not per request), but it's an index on the busiest table —
calling it out for sign-off.

## Backend

### Read (`backend/internal/read/repo.go`)
- New `RecentCustomersForOutlet(ctx, outletID string, days, cap int) ([]api.Customer, error)`:
  distinct customers with an order at `outletID` within the last `days`, ordered by their most-recent
  order desc, capped at `cap`. Reuses `customerObj`. Defaults wired by the caller: `days=90`,
  `cap=1000`. Parameter-bound.

### Write / service (`customer_create` path)
- In the customer-create path used by the POS offline outbox (`service.OrderService.CreateCustomer`,
  invoked by `sync.go` `case "customer_create"`): after the create, if another customer (different id)
  has the same trimmed phone, insert a `customer_dup_candidates` row
  (`new_customer_id` = the just-created id, `existing_customer_id` = the prior match, `phone`,
  `status='pending'`). Never blocks the create. (The backoffice create path already has the
  interactive SP-CRM-2 `by-phone` soft-warn, so detection here targets the offline-miss case.)

### Sync bootstrap (`backend/internal/sync/sync.go`)
- **Phase 1:** unchanged — keep `Customers(ctx, 1, 100000, "", "")`.
- **Phase 2 (gated):** replace that line with `RecentCustomersForOutlet(ctx, <bootstrap outletID>, 90, 1000)`.
  The bootstrap already resolves an outlet scope (`sc`/`sc.OutletID`) for products — reuse it for the
  customer set. This is the only cutover change.

### API
- No new endpoints (lookup + by-phone shipped in SP-CRM-2). `RecentCustomersForOutlet` is internal
  (sync bootstrap), not a public route. No OpenAPI change expected; if anything is added, regen +
  `make gen-check`.

## POS (APK) — `apps/pos/src/cashier`

- **`CustomerPicker` / `CashierScreen`:** when the search term is ≥2 chars **and the device is
  online**, call `api.lookupCustomers(q)` (debounced, with an `ignore`/stale-guard like the SP-CRM-2
  dup-check) and **merge** the results with the existing local-cache filter — dedupe by `id`,
  exact-phone match first, cap the combined list. When **offline**, use only the local-cache filter
  (today's behavior). Use the POS's existing online/offline signal (the sync engine's connectivity
  state — confirm the exact hook during planning).
- New-customer create (offline `customer_create` outbox) is **unchanged**.
- This is an APK change → **requires a release build** (GH Actions `android-release.yml`,
  workflow_dispatch). **Ask the user before dispatching.**

## Testing & verification

- **Backend:** `go build`/`go vet`/`go test ./...`; live-check `RecentCustomersForOutlet` returns the
  correct bounded per-outlet recent set (seed/identify an outlet with known recent orders); live-check
  that an offline-style `customer_create` with a colliding phone records a `customer_dup_candidates`
  row (and still creates the customer). Migration 0027 applies (`/readyz`).
- **POS:** `tsc -b` + `vite build`; on-device check on the new APK — online search finds customers via
  lookup, offline falls back to the cache, new-customer create still works offline. **APK build is
  user-gated.**
- **Honest caveats (rule 6):**
  - The **Phase 2 flip cannot be fully verified until the fleet updates** — SP-CRM-3 verifies Phase 1
    + the bounded query in isolation (call it against a real outlet and confirm the set), not the live
    bootstrap swap.
  - On-demand picker behavior is only meaningful on a real device — backoffice/web verification is
    limited to build + the endpoint (already verified in SP-CRM-2).

## Risks & mitigations

- **APK + on-device testing required** (first POS-touching sprint of the CRM line). Coordinate the
  build; verify on a device before the Phase 2 flip.
- **Phase 2 is user-gated** — until it ships, the heavy 100k sync persists (acceptable, by design).
- **Offline-miss duplicates are flagged, not prevented** — the agreed tradeoff; the SP-CRM-Merge tool
  resolves them later.
- **`idx_orders_outlet_created` on the hot orders table** — modest write cost, flagged for sign-off.
- Connectivity-signal reliability in the POS — verify the existing online/offline hook during planning;
  a wrong "online" reading would make the picker await a lookup that can't complete (mitigate with a
  short timeout + fallback to cache).
- Neon first-write-after-idle transient — retry warm.

## Files touched (anticipated)

- `backend/internal/db/migrations/0027_customer_dup_candidates.sql` (new)
- `backend/internal/read/repo.go` (`RecentCustomersForOutlet`)
- `backend/internal/service/order.go` (dup-candidate detection in `CreateCustomer`)
- `backend/internal/write/repo.go` (insert helper for `customer_dup_candidates`, if not in service)
- `backend/internal/sync/sync.go` (Phase 2 one-line flip — gated)
- `apps/pos/src/cashier/CustomerPicker.tsx` + `CashierScreen.tsx` (on-demand lookup + offline fallback)
- possibly `packages/api` (only if a new type/route is needed — not expected)
