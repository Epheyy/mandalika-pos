# SP-CRM-Merge — Duplicate-Customer Review Queue & Merge

**Date:** 2026-06-12 · **Branch:** `prod-hardening` · **Slice:** SP-CRM-Merge
**Surface:** backend + backoffice only — **no POS code, no APK**
**Migration:** 0034 (next slot) · **Backend rev at start:** `00061-jtw` (migrations →0033)

## The 6 working rules (honored throughout)
1. Ask, don't assume  2. Don't touch unrelated  3. Flag uncertainty
4. Verify on failure  5. Show changes  6. Admit gaps

---

## 1. Problem & Goal

SP-CRM-3 flags same-phone offline-miss duplicates into `customer_dup_candidates`
(migration 0027; `status` pending/merged/dismissed; written by `order.go:683`).
**That table is currently write-only — nothing reads or surfaces it.**

SP-CRM-Merge builds the entire review/merge surface: a backoffice queue where a
high-privilege user reviews each flagged pair side-by-side and either **merges** or
**dismisses** it. A confirmed merge re-points the duplicate's orders to the keeper,
moves its points (with ledger reconciliation), unions tags, recomputes aggregates,
resolves profile-field conflicts, and **soft-tombstones** the duplicate.

**HUMAN-IN-THE-LOOP, NEVER AUTO-MERGE.** Same phone ≠ same person; merges are
destructive. Every merge is explicitly confirmed by a person.

### Locked design decisions (from brainstorming)
- **Tombstone semantics:** soft-tombstone + redirect (`merged_into` column). The dup
  row survives; a stray reference to the dead id still resolves to the keeper.
- **Ledger reconciliation:** one reconciling `adjust` entry on the keeper + a mirror
  entry zeroing the dup; the dup's own `point_transactions` rows stay on the (now
  tombstoned) dup as preserved history. **Append-only invariant intact — no row rewritten.**
- **Conflict UX:** field-by-field, conflicts only, keeper-default-but-prefer-non-null;
  tags always unioned.
- **Undo:** none in v1. Recoverable by design (soft-tombstone + full audit row). Idempotent.
- **POS awareness:** server redirects `merged_into → keeper` at the write boundary;
  active-customer reads exclude merged rows. POS stays unchanged; no APK.
- **Aggregates:** additive (`keeper += dup`) — verified faithful (see §4).

---

## 2. Data model — migration 0034

```sql
-- 0034_customer_merges.sql
-- SP-CRM-Merge: soft-tombstone + redirect for merged duplicate customers,
-- plus an audit spine that makes a mistaken merge recoverable by hand.

ALTER TABLE customers ADD COLUMN merged_into uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN merged_at   timestamptz;

-- Small partial index: only tombstoned rows are indexed (rare), so redirect lookups
-- and "is this active?" checks stay cheap without bloating the big customer indexes.
CREATE INDEX idx_customers_merged_into ON customers(merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE customer_merges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keeper_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dup_id            uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field_choices     jsonb NOT NULL,        -- {"name":"keeper"|"dup","email":...,...}
  dup_snapshot      jsonb NOT NULL,        -- full pre-merge dup row, for hand-recovery
  moved_order_ids   uuid[] NOT NULL,       -- exact orders re-pointed (enables manual reversal)
  points_moved      integer NOT NULL,
  performed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_merges_keeper ON customer_merges (keeper_id, created_at DESC);
```

### Active-customer read filter
Every query that returns "live" customers gains `WHERE merged_into IS NULL`:
- backoffice list `Customers(...)`, search, sort
- `GET /customers/by-phone` dup-check
- `GET /sync/customers/lookup` (cashier)
- `RecentCustomersForOutlet(...)` (POS sync payload)

**FLAG (perf):** the pg_trgm GIN indexes (name/phone/email) and the sort btree
indexes do **not** carry the `merged_into IS NULL` predicate, so Postgres index-scans
then filters the (vanishingly few) tombstoned rows. Acceptable at 50k–500k customers
with rare merges. Converting those to partial indexes is a heavy rebuild and is
**deferred**; revisit only if tombstones ever become a large fraction of the table.

---

## 3. The merge transaction (the heart)

Runs in a **single `Pool.Begin` transaction — NOT the `r.tx` repo wrapper.**

> **FLAG (correctness-critical):** SP-CRM-7's `AdjustPoints` deliberately used
> `Pool.Begin` instead of `r.tx` because `r.tx` bumps `content_versions`, which
> triggers a full customer resync to all 30+ outlets. A merge must likewise avoid
> that blast (POS self-heals via the read filter + write-boundary redirect). The plan
> MUST verify the exact `r.tx` / `content_versions` mechanism in code before wiring,
> and confirm `Pool.Begin` is the right primitive here.

Input: `{candidateId, keeperId, fieldChoices}`. The keeper is one member of the
candidate pair; the other member is the dup.

1. **Lock** both customer rows `FOR UPDATE`, **ordered by id ascending** (deadlock-safe
   regardless of which is keeper).
2. **Idempotency / validity re-check (all-or-nothing):**
   - both rows exist
   - **both have `merged_into IS NULL`** (neither already merged — blocks merge-into-tombstone and double-merge)
   - `keeperId != dupId`
   - candidate `status = 'pending'`
   - keeper and dup are exactly the two members of `candidateId`'s pair
   On any failure → **409 Conflict** (idempotent no-op), nothing written.
3. **Apply field choices** to the keeper — only the editorial fields where the user
   chose `'dup'`: `name, phone, email, birthday, anniversary, notes`. Server validates
   each key is one of these and value ∈ {`keeper`,`dup`}.
4. **Tags — union:** insert the dup's `customer_tags` onto the keeper where the
   `(keeper, tag_id)` pair does not already exist.
5. **Re-point orders:**
   `UPDATE orders SET customer_id = $keeper WHERE customer_id = $dup RETURNING id`
   → collect `moved_order_ids` for the audit row.
6. **Re-point** `customer_interactions` and `loyalty_condition_applications`
   (`SET customer_id = $keeper WHERE customer_id = $dup`).
   `point_transactions` are **NOT** re-pointed (Fork 2 — they stay on the dup).
7. **Points reconciliation** (skip entirely if `dup.points == 0` — the ledger CHECK
   forbids `points = 0`):
   - keeper: append `point_transactions` `{type:'adjust', points:+dup.points,
     balance_after: keeper.points + dup.points, reason:"Gabung dari <dupPhone> (<dupName>)"}`
   - dup: append `{type:'adjust', points:-dup.points, balance_after:0,
     reason:"Dipindah ke <keeperPhone> (<keeperName>)"}`
   - `UPDATE customers SET points = points + $dupPoints WHERE id = keeper`
   - `UPDATE customers SET points = 0 WHERE id = dup`
   Both ledger chains remain internally valid (`balance_after` correct within each customer).
8. **Aggregates — additive** (verified faithful in §4):
   - `keeper.total_spent += dup.total_spent`
   - `keeper.visit_count += dup.visit_count`
   - `keeper.last_visit = GREATEST(keeper.last_visit, dup.last_visit)` (null-safe)
   - segment is computed-on-read → auto-correct, no write.
9. **Tombstone the dup:** `merged_into = keeper.id`, `merged_at = now()`.
10. **Resolve candidates:** mark `candidateId` `status='merged'`; also resolve any
    **other** pending `customer_dup_candidates` rows referencing the dup
    (`new_customer_id = dup OR existing_customer_id = dup`) → `status='merged'`
    (they now point at a tombstone; surfacing them again would be noise).
11. **Insert `customer_merges`** audit row (field_choices, dup_snapshot, moved_order_ids,
    points_moved, performed_by[+name from the authed caller]).

Commit. On any error → rollback, nothing applied.

### Write-boundary redirect (POS awareness)
`CreateOrder` resolves `merged_into` to its **terminal** keeper before writing the
order + aggregates + points, so a late offline order created against a stale dup id
lands on the live keeper.

> **FLAG (chains):** because a keeper can itself later be found a dup of a third
> customer, chains `A → B → C` can form. The resolver follows `merged_into` to the
> terminal row with a **hop cap (e.g. 10)** and a **cycle guard** (a merge never sets
> `merged_into` to a row that resolves back to itself — step 2 blocks merging into an
> already-merged row, which prevents cycles by construction; the cap is defense in depth).

---

## 4. Why additive aggregates (verified, not assumed)

`order.go` CreateOrder maintains aggregates as pure increments:
```
UPDATE customers SET total_spent = total_spent + $1, visit_count = visit_count + 1,
  last_visit = now(), points = points + $2 - $4 WHERE id = $3
```
**Refund does NOT decrement `total_spent` or `visit_count`** — they appear nowhere in
the refund path. They are monotonic lifetime totals. Therefore `keeper += dup` is the
*faithful* merge — it equals what the running totals would have been had both customers'
orders always belonged to the keeper. Recompute-from-orders would yield a different
(smaller, if any refunds touched order totals differently) value and is the **wrong**
choice. `points` is handled separately via the ledger reconciliation in §3.7.

---

## 5. API

All under the existing `/customers` route group. OpenAPI edited → `oapi-codegen`
regen `api.gen.go` → `pnpm --filter @mandalika/api gen` regen `schema.d.ts` →
build/test → `make gen-check` clean. Reads use the `{data:...}` envelope (`httpx.JSON`);
the merge/dismiss writes return enveloped via `writeJSON`.

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /customers/dup-candidates?status=pending&page&limit` | `manage_customers` | Paginated pairs; each row carries both customers' side-by-side summary (name/phone/email/points/total_spent/visit_count/order_count/created_at) + the candidate's `created_at`/`phone`. |
| `GET /customers/dup-candidates/{id}` | `manage_customers` | Full pair detail for the merge screen: both full profiles + a computed `conflicts` array (only fields that differ, each with keeper value, dup value, and the suggested default). |
| `POST /customers/dup-candidates/{id}/merge` | `manage_settings` | Body `{keeperId, fieldChoices}` → runs the §3 transaction → returns the keeper customer. 409 on any §3.2 re-check failure. |
| `POST /customers/dup-candidates/{id}/dismiss` | `manage_customers` | `status='dismissed'` (idempotent; 404 if candidate missing). |

**Permission rationale:** merge mints/moves value and is destructive → `manage_settings`,
matching SP-CRM-7's `adjustPoints`. Reviewing and dismissing are non-destructive →
`manage_customers`.

New TS client methods: `listDupCandidates`, `getDupCandidate`, `mergeDupCandidate`,
`dismissDupCandidate`.

---

## 6. Backoffice UI (in-screen view swap — no router, matches the module)

- New **`Duplikat`** sub-tab in `screens/Customers.tsx` (`Daftar | Pengingat | Duplikat`),
  with a **pending-count badge** next to the label.
- **List view:** pending pairs; each a compact side-by-side row (the two names/phones,
  flagged date) + a **"Tinjau"** button.
- **Merge-review view** (view swap on a `selectedCandidateId`, like the Daftar→Detail
  swap):
  - Two customer cards side-by-side: profile fields + points + total_spent +
    visit_count + order_count.
  - **Keeper toggle** — default keeper = the **existing/older** customer in the pair
    (`existing_customer_id`); user can swap which side is keeper.
  - **Conflicts-only radio panel:** one radio pair per differing editorial field,
    defaulting to keeper except where keeper is empty and dup is set (default to the
    non-null side). Identical fields are not shown.
  - **Tags union preview** (read-only; shows the merged tag set).
  - **"Gabungkan"** button → confirm dialog *"Gabungkan permanen? Tidak bisa
    dibatalkan otomatis."* → POST merge → back to list (badge decrements).
  - **"Bukan Duplikat"** button → dismiss → back to list.
- New files: `screens/customers/DupCandidates.tsx` (list), `screens/customers/MergeReview.tsx`
  (detail), `screens/customers/mergeTypes.ts` (field labels / conflict typing).

---

## 7. Testing

**Pure/unit (Go + TS):**
- conflict detection + non-null-preferring default selection
- the `merged_into` terminal resolver: single hop, multi-hop chain, hop cap, cycle guard

**Go integration (the merge tx):**
- orders re-pointed to keeper; interactions + loyalty applications re-pointed
- ledger: keeper gains `+dup.points` entry with correct `balance_after`; dup gains the
  mirror `-dup.points → 0` entry; dup's prior rows untouched; `dup.points == 0` path
  writes no ledger entries
- aggregates additive; `last_visit = max`; tags unioned (no duplicates)
- tombstone set; candidate → `merged`; sibling pending candidates resolved; audit row
  written with moved order ids + dup snapshot
- **idempotent replay:** a second merge call no-ops (409), no double-move
- **block merge-into-already-merged**; **block self-merge**; dismiss path

**Live e2e** (throwaway `cmd/<name>`, real `service.OrderService` against the test DB,
**all artifacts deleted + state restored**, same protocol as SP-CRM-7/8/9):
- create customer A (keeper) + B (dup), give each orders + points
- merge B→A → assert: A owns all orders, A.points = combined with reconciling entries,
  A aggregates additive, B tombstoned and absent from `/customers/by-phone` + lookup
- **post-merge order placed on B's dead id redirects to A** (write-boundary redirect proven)
- cleanup: delete all rows, restore.

`-race` not run locally (no cgo on this Windows box); CI runs race on Linux.

---

## 8. Model routing (per [[model-routing-policy]])

This slice touches the points ledger, order re-pointing, customer aggregates, a
migration, and type-gen — **all correctness-critical**. Therefore:
- **Implementation → Sonnet** (per task).
- **Review → Opus** across the board (migration, merge tx, API/type-gen, backoffice
  that drives the merge call). Mechanical-only spec-conformance checks may go to Haiku,
  but any Haiku finding is **re-derived from source by Opus** before accept/dismiss.
- Per task, announce the chosen tier + one-line rationale.

---

## 9. Out of scope / deferred (admit gaps)

- **Self-service undo** — recoverable by hand via the audit row; no button in v1.
- **POS merge-map push / client self-heal** — server redirect + read filter suffice; no APK.
- **Partial-index conversion** of the big customer indexes for `merged_into IS NULL`.
- **Auto-merge / fuzzy dup detection** — detection stays exactly as SP-CRM-3 built it
  (same-phone offline-miss). This slice only reviews what's already flagged.
- **Merging more than two customers at once** — one pair per operation; chains handled
  by the terminal resolver.
- **Phone normalization** (08xx vs +62) — still deferred module-wide.
