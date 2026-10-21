# Backend reorganisation + ERP demo: execution plan (2026-10-22 to 2026-11-02)

Status: **PLAN, owner decisions D1, D2, D3, D4, D5, D7, D9 and D10 DECIDED 2026-10-21** (owner: "go with your recommendation on
D1, D2, D3, D10"; D4, D5, D7 and D9 take the recommended option under the owner's standing instruction for routine
technical choices; see §7). The other decisions are still open. No code, migration, test or CI file has been changed.
Implementation starts Thu 22 from the post-history-purge `prod-hardening` head. Per-worktree briefs:
`docs/plans/2026-10-22-reorg-thursday-briefs.md`.

Base: `prod-hardening` @ `3a2dde5`. Every `file:line` below was re-derived at that commit.
- They are still valid at `c888d3f`: the dependency-security merge `ab994a3` (vite 8.1.6, Go 1.26.10) and the
  HANDOFF note changed no file under `backend/internal`.
- The history purge rewrites SHAs, not file contents. Read `3a2dde5` as "the tree at that point". Paths are relative to
`backend/` unless they start with `apps/`, `packages/`, `scripts/`, `.github/` or `docs/`.

Inputs:
- `docs/plans/2026-10-21-erp-flamboyan-compatibility-assessment.md` (§9, §11–§15)
- `docs/plans/2026-10-21-erp-dev-backend-review-comparison.md`
- `docs/integration/2026-10-21-serah-terima-erp-pos.md` (contract `POST /stock-documents`, work items P-A..P-H)
- the ERP developer's `BACKEND_ARCHITECTURE_REVIEW.md` (§7 idempotency matrix, §9 target structure, §10 order)

Method: five read-only agents (three Opus planners, two Haiku scouts) produced verified notes. Two of them dry-ran
their parts in scratch copies of `backend/`:
- the god-file split: build, vet and test green, declaration hashes identical;
- the cross-package moves plus the import-direction test: green at HEAD, and red on an injected `read -> write`
  import.

Their notes are summarised here. The move map, split tables and import test are reproduced in the appendices. The
helper tools are in `docs/plans/2026-10-22-reorg-tools.md`.

Owner decisions this plan builds on (2026-10-21):
- **Big-bang reorganisation = file and package moves only.** Function bodies are untouched and reviewed with
  `git diff -M`. `createOrderCore`, `RefundTx` and `processOneWithSeq` are not rewritten before the demo.
- **Target layout:** review §9, plus `internal/integration/erp`.
- **Schema changes are additive only.**
- **Demo on 2026-11-02.** Working days: Oct 22, 23, 26, 27, 28, 29, 30.

---

## 0. Summary and critical path

| # | Step | Dates | Depends on | Demo-critical |
|---|---|---|---|---|
| 1 | Reorganisation to the §9 layout | Thu 22 – Fri 23 Oct | owner D1–D3 (§7) | yes: the ledger lands in `internal/ledger` |
| 2 | Ledger `stock_movements` + same-tx writers | Mon 26 – Tue 27 Oct | step 1; owner D10–D14 | yes |
| 3 | Money-path additive fixes | stock keys Mon 26 (with step 2); the rest after the demo | step 1 | partly (§3.6) |
| 4 | External ids + catalog pull | Mon 26 – Wed 28 Oct (parallel worktree) | step 1; SKU mapping data | yes (catalog down) |
| 5 | Outbox + relay + `cmd/erpstub` | stub from Thu 22 (parallel); relay Wed 28 – Thu 29 | step 2 (the outbox row is written by `ledger.Record`) | yes |
| 6 | Rehearsal, deploy to test env, demo | Thu 29 (deploy) – Fri 30 (rehearsal); Mon 2 Nov demo | 2, 4, 5; owner go-aheads | – |

**Critical path:** reorg (22–23) → ledger and writers (26–27) → outbox and relay (28) → deploy, backfill and
scheduler (29) → rehearsal (30) → demo (2 Nov).

Off the critical path, run in parallel worktrees:
- `cmd/erpstub`
- the ERP client codegen spike
- catalog pull and SKU mapping
- the backoffice screens

**Nothing in this plan needs an APK or an OTA.** The tablet keeps selling through the existing `/sync/batch`. All
new work is backend, backoffice (Cloudflare deploy on push) and Cloud Scheduler.

Owner gates (AGENTS.md: no commits, pushes, deploys, APK builds or Neon writes without the owner's go-ahead):
- each merge to `prod-hardening`
- each backend deploy (migrations 0064–0066 run at boot, `cmd/server/main.go:45`)
- the Neon opening-balance backfill
- the Cloud Scheduler jobs
- deploying `erpstub`

---

## 1. Step 1: reorganisation to the §9 layout (Thu 22 – Fri 23 Oct)

### 1.1 Target layout and import rule

```
internal/
  api/ apperr/ httpx/ bizday/ phone/ redact/ uploads/ clientip/ promotionkeys/ ota/ csvimport/   leaves (no pgx)
  rules/        NEW leaf, pure, no pgx: payment method (IsCashMethod), loyalty engine, PIN lockout, password hashing
  db/           pool + migrations (unchanged in step 1; tx_busy/classifier moves are deferred, §1.5)
  ledger/       NEW infra: BumpStockSeq (step 1), stock_movements + outbox enqueue (step 2)
  read/ write/ service/          domain: one file per feature (§1.3)
  sync/         transport adapter (pgx use stays allow-listed debt, §1.5)
  handlers/     transport, one file per feature
  integration/erp/               NEW adapter: catalog pull, outbox relay, generated ERP client (steps 4–5)
  auth/ middleware/ cache/ config/ observability/                platform / infra (unchanged)
  server/ codegen/ fsmigrate/ promotionpreflight/ dependencycheck/   root and tools (unchanged)
```

**Allowed imports** (review §9): handlers → {service, read, write, sync} → {ledger, rules, db, api, apperr}.
- `read` never imports `service`.
- `service` never imports `write`.
- Transport (handlers, sync) never imports `pgconn`.
- `integration/erp` sits beside the domain packages: handlers → integration/erp → {ledger, db, leaves}.
- The utility packages listed by review §9 (`ota`, `csvimport`, `uploads`, `promotionkeys`, …) are leaves that
  anyone may import. Whether that holds for `ota` and `csvimport` is decision D5.

### 1.2 What counts as a "move" (rules for the implementer and the reviewer)

| Class | Allowed edits | Proof |
|---|---|---|
| **Pure move** (same package, file split) | Copy whole top-level declarations verbatim, doc comment through closing brace. Recompute each file's import block. `gofmt`. Drop the `// ── X ──` section banners listed in Appendix A. | `declhash` (tools doc): the sorted declaration-hash sets of parent and child commit must be identical. `git diff --color-moved=dimmed-zebra -M`. |
| **Qualifier-only** (cross-package) | `git mv` the file and change `package`. Rewrite `oldpkg.X` → `newpkg.X` at non-frozen call sites, and fix imports. | `git diff --word-diff -M` shows only package clauses, import lines and qualifier tokens. Reviewer counts the sites against §1.4. |
| **Alias shim** (cross-package, frozen callers) | In the OLD package add `type X = new.X`, `var F = new.F`, `const C = new.C`. Frozen bodies stay byte-identical. Sentinel errors alias the same value (`var ErrBusy = db.ErrBusy`), never a fresh `apperr.New`. `BumpStockSeq` must be a `var` alias, never a wrapper func (`write/stockseq_guard_test.go:23-37` counts calls by name). | `declhash` of the frozen functions unchanged. |
| **Deferred** (not in step 1) | Anything that needs an unexported symbol to be exported or renamed, a new declaration other than an alias, or a body edit. | Listed in §1.5. |

**Frozen functions are moved intact and never edited:**
- `createOrderCore` (`service/order.go:249-794`) stays in `service/order.go`.
- `RefundTx` (`service/order.go:858-1066`) moves intact to `service/refund.go`.
- `processOneWithSeq` (`sync/sync.go:467-737`) stays in `sync/sync.go`.

The split dry run verified identical body hashes for all three.

**Test files:**
- In a same-package split, `_test.go` files stay where they are and compile unchanged.
- Cross-package movers take their tests along, listed in §1.4.
- White-box tests of unexported helpers block a move; those moves are deferred.
- Tests are renamed or split later, never in step 1.

### 1.3 Intra-package splits (commits R1–R5)

All 377 top-level declarations of the five god files are mapped exactly once into 61 files, with no name collisions.
Each declaration's line range, name and target is in **Appendix A**. Summary:

| Commit | File (HEAD lines) | Result | Frozen function |
|---|---|---|---|
| R1 | `internal/read/repo.go` (1991, 97 decls) | 21 files: catalog, outlets, warehouses, ingredients, recipes, ingredient_transfers, ingredient_stock_counts, customers, promotions, loyalty, settings, users, orders, shifts, error_logs, stock_counts, transfers, inventory, promo_reports, ota; repo.go keeps `Repo/New/Scope/listJSON/oneJSON/off` | – |
| R2 | `internal/write/repo.go` (1186, 62) | 8 files: catalog (all product stock writers + `txStock`), customer, promotion, discount_code, outlet, settings, ota; repo.go keeps `tx`, `bumpVersion*`, `jsonb`, `delete`, `null*` | – |
| R3 | `internal/service/order.go` (1949, 55) | 8 files: order (keeps `createOrderCore` + its helpers, 813 lines), customer, refund, promo_resolve, settings, loyalty_load, rewards, sqlnull | `createOrderCore` unmoved; `RefundTx` → refund.go intact |
| R4 | `internal/handlers/writes.go` (1720, 131) | 21 files by feature; writes.go keeps `callerID/caller/decodeWrite/created/mutated` | – |
| R5 | `internal/sync/sync.go` (806, 32) | sync.go (Engine, per-item command path, 537 lines) + pull.go (Version/Pull) + batch.go (ProcessBatch, held messages) | `processOneWithSeq` unmoved |

**Blocker found by the dry run (decision D2).** `internal/write/stockseq_guard_test.go` keys its allowlist
(`:23-37`) and per-file SQL pins (`:308-316`) on file paths, so a pure move fails it.

The fix edits only map keys and splits one pin, in the same commit as each split:
- read: `read/repo.go` → `read/catalog.go` + `read/inventory.go`
- write: `write/repo.go` → `write/catalog.go`
- service: `order.go {3,0}` → `order.go {2,0}` + `refund.go {1,0}`

It was verified green. Per-package stock-write totals are unchanged, and the hunk is reproduced in Appendix A §A.0.

Option B avoids the edit by leaving stock-touching code in the old files, but then three of the five god files are
only partly split.

**Decided 2026-10-21 (D2): Option A.** It is the "update this pin" path the guard itself documents.

The 30 route-bound GET handlers that live in `handlers/writes.go` move by feature (listed in A.3). None of them is
cached today: `h.cached(` appears only in `handlers/handlers.go` and `handlers/users.go`. Adding caching is a
behaviour change and is **out of scope**.

### 1.4 Cross-package moves and leak fixes (commits R6–R12)

| Commit | Change | Class | Leak removed | Reviewer |
|---|---|---|---|---|
| R6 | `internal/archtest/arch_test.go` (Appendix C) with today's 7-edge allow-list. Negative check: inject `_ ".../internal/write"` into read → test fails → remove the injection. | new test | – (freezes the graph) | Haiku |
| R7 | `rules/doc.go`; `git mv service/payment_method{,_test}.go rules/`; `service/rules_compat.go` with `var IsCashMethod = rules.IsCashMethod` (frozen caller at `service/order.go:462`); one qualifier edit at `read/repo.go:1085` (lands in `read/shifts.go` after R1) plus the comment at `:1030`; delete the `read -> service` allow-list line | qualifier + shim | **read → service** | Opus (payments) |
| R8 | `git mv service/loyalty.go rules/`; 5 type + 3 var aliases in `service/rules_compat.go`. Frozen users at order.go:425, 482, 498, 684, 703 stay byte-identical. `loyalty_test.go` stays in service (it uses `wib` and `fptr`). | shim | – (ownership only) | Haiku (Opus if points count as money, D9) |
| R9 | `git mv auth/pinlockout.go` (+test) and `auth/password.go` (+2 tests + `testdata/argon2id-v0.46.0.json`, which is go:embedded) to `rules/`; 8 qualifier edits in `write/receive_approval.go` (94, 118, 250, 254, 278, 283, 322, 327) + 2 (88, 270); 11 password edits in `auth` (store.go:106, 176, 247; reset.go:70, 87; reset_test.go:151) and handlers tests; delete `write -> auth` | qualifier | **write → auth** | Opus (auth) |
| R10 | `ledger/doc.go`; `git mv write/stockseq.go ledger/`; `write/ledger_compat.go` with `var BumpStockSeq = ledger.BumpStockSeq`. Callers unchanged: frozen order.go:782, 1063; repo.go:101 (→ catalog.go); stockcount.go:457; transfer.go:307, 436, 486; warehouse.go:126. | shim | – (ownership) | Opus (stock) |
| R11 *(optional, cut line 3)* | Move the tx-scoped insert funcs to `internal/ledger` behind aliases in `write/ledger_compat.go`: `InsertPointTx/PointTxRow` (write/points.go), `InsertSaleStockException/InsertRefundUnresolvedVariant/StockException*` (write/stock_exception.go), `InsertConditionApplication/InsertRewardGrant/*Row` (write/loyalty.go). Repo methods stay. | shim | – (the service→write edge stays until D4) | Opus |
| R12 | `integration/erp/doc.go`. **Owned by the stub worktree (§6.3), not the reorg branch,** to avoid a collision. | new | – | Haiku |

**cmd/ needs no edits.** None of the symbols it uses moves:
- `cmd/server/main.go:39, 54, 64`
- `cmd/seed`
- `cmd/migrate-firestore`
- `cmd/promotion-key-preflight`

### 1.5 Leaks that are NOT pure moves (deferred, with reason)

| Leak / candidate | Uses at HEAD | Why deferred | Unblocks when |
|---|---|---|---|
| service → write | 9 lines in `createOrderCore` (order.go:547, 565, 643, 660, 681, 691, 709, 746, 782); 6 in `RefundTx` (912, 999, 1027, 1034, 1043, 1063); non-frozen: 824, `lockorder.go:85`, `RewardGrantRow` at 1532, 1576, 1648, 1675, 1703, 1771 | Changing qualifiers inside frozen bodies is an edit | D4 = yes, after the demo, plus the tx_busy/points_math exports |
| handlers → pgconn | `handlers/writes.go:12, 1126` (`refundHTTPError`: 40P01/40001/55P03 → 409) | Needs a new `db.IsLockConflict(err)` and a body edit | Separate Opus slice (refund error mapping) |
| sync → pgconn | `sync/classify.go:45, 54, 80` (`classifyPg` also returns `itemOutcome` and uses `write.ErrBusy` :67) | Needs a db classifier API and changes retry semantics | Separate Opus slice (SyncEngine) |
| sync → pgx, pgxpool | `sync.go:26, 105` (Engine.Pool, `New`), `pgx.Tx` closures (sync.go:55–404; frozen 600–683), `attribute.go:75–142` (SQL) | Structural; `sync.Version` also runs SQL (`sync.go:124-150`) | D6: accept as permanent, or move the SQL into read/service after the demo |
| `service/pricing.go` → rules | Unexported helpers used from order.go (`bundleAllocate`, `bxgyRewardDue`, …); `service.DiscountKind` used at frozen `sync.go:539, 542`; white-box tests | Export = rename | After demo, with D4 |
| `service/promo_validate.go` | Needs unexported `wib` (`order.go:32`) at `:93` | Needs a new declaration in rules | D8 |
| `service/tender.go`, `quote.go` | `evaluateTender`, `tenderRejectedError`, `evaluateQuote` at frozen order.go:462-470 | Export = rename | After demo |
| `write/tx_busy.go` → db | `mapBusy` (receive_approval.go:157, transfer.go:235), `retryBusy` (7 sites); `ErrBusy` has 19 users | Export = rename | D8 |
| `write/points_math.go`, `transfer_logic.go`, `stock_logic.go`, `ingredient_stock_logic.go`, `receive_fingerprint.go` | Unexported use, or a rules → write type cycle | Export or type moves | After demo |

### 1.6 Import-direction test (R6)

`internal/archtest/arch_test.go` uses stdlib `go/build` only. It needs no `golang.org/x/tools` (which is only
`// indirect` in go.mod) and no subprocess, and it reads production imports only. The full prototype source is in
Appendix C.

**Deviation from the brief, on purpose.** The brief asked for a `go list`-based test. `go/build.ImportDir` reads the
same `Imports` data that `go list -f '{{.Imports}}'` prints, but needs no `go` subprocess in the test run and no
new dependency.

R6 verification includes a one-time cross-check: diff the test's computed edge set (a `-v` dump) against
`go list -f '{{.ImportPath}} {{join .Imports " "}}' ./internal/...` at the same commit. The two must match.

- Tiers: leaf, infra (db, ledger strict), platform, domain, adapter (integration/erp), transport, root, tool.
- An unclassified package fails the test. When `integration/erp/erpapi` (step 4) lands, it must be added as a leaf.
- **Allow-list at HEAD, exactly 7 edges:**
  - `read -> service`
  - `service -> write`
  - `write -> auth`
  - `handlers -> pgconn`
  - `sync -> pgx`
  - `sync -> pgxpool`
  - `sync -> pgconn`

  `read/write -> ota` and `write -> csvimport` are not listed because ota and csvimport are classified as leaves
  (D5). If D5 = strict, add 3 entries.
- **Ratchet:** an allow-list entry that no longer occurs fails the test, so R7 and R9 must each delete their line.
  At the end of step 1, 5 edges remain.

### 1.7 `.golangci.yml` with a baseline (R13; advisory; after the dependency-security branch merges)

**Current state:**
- No `.golangci.yml` exists, and golangci-lint is not installed locally.
- CI runs only `make gen-check`, `go vet`, `gofmt -l`, `go build`, `codegen_gate.py`, `xmod-consumer-test.py` and
  `go test ./... -race` (`.github/workflows/backend.yml`).

**Proposal:**
- **Version:** `version: "2"`, golangci-lint **v2.15.0**, which supports Go 1.26.
- **Install:** `golangci-lint-action` v9.3.0 in CI, with **no go.mod tool line**.
- **Linters:** `default: none`, then enable govet, staticcheck, gocognit (min 30), nestif (min 5), revive and
  gocritic.
  - revive: `exported`, `var-naming` and `unused-parameter` on; `error-strings` off for the Indonesian messages.
- **depguard stays off.** The archtest is the single source of the import rules.
- **Baseline:** `issues.new-from-rev: <sha of the reorg merge commit>` with `fetch-depth: 0`.
- **Rollout:** a separate job with `continue-on-error: true` for one cycle, then blocking.

**It lands last, not first.** A `new-from-rev` baseline set before the moves would treat every moved body as new
code, so gocognit would fire on `createOrderCore`. This deviates from the review's §10 order on purpose; decision D9.

**Sequencing (satisfied 2026-10-21):** the dependency-security branch merged as `ab994a3` (Go toolchain 1.26.10,
vite 8.1.6; `prod-hardening` @ `c888d3f`). R13, `gen-erp-check` and any `go.mod` change can now land; rebase them on
the post-purge head. Step 1 itself makes **no go.mod change**.

### 1.8 Verification per commit

| Check | Command | When |
|---|---|---|
| Format, build, vet, unit tests | `cd backend && test -z "$(gofmt -l .)" && go build ./... && go vet ./... && go test ./...` | every commit |

Use `./...`, not a single package: the stock guard lives in package `write` but scans every package, so a narrow
run misses breakage in R1 and R3.

| Check | Command | When |
|---|---|---|
| Body identity | `git diff --stat -M P C`; `git diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change P C -- backend/internal/<pkg>`; `declhash` at P and C, then diff (tools doc) | R1–R5: the diff must show only dropped-banner `C` lines and no `D` lines. R7–R11: only `P` package clauses plus alias declarations. |
| Qualifier-only proof | `git diff -M --word-diff P C` | R7, R9: counts must match §1.4 |
| Import direction | `go test ./internal/archtest/` | from R6 on |
| Codegen / contract | `make gen-check` (`backend/Makefile:45`), `python3 scripts/ci/codegen_gate.py`, `corepack pnpm gen:check` | R4, R5, R12 (handlers / generated surface) and the end of the day |
| JS/TS gate | `corepack pnpm quality:ci` (`package.json:12`) | once per day on the branch tip (unchanged TS, but this proves it) |
| Postgres gates | `python3 scripts/ci/postgres_gate.py` (all 28 gates in `scripts/ci/postgres_gate.py:32-61`, ports 56439–56466, PostgreSQL 18.3; needs Docker). Must-pass gates for the reorg: **ST** 56458, **TR** 56445, **SC** 56451, **RF** 56449, **OS** 56457, **LO** 56454, **S0C** 56439, **OR** 56446, **RA** 56466, **AU** 56455, **IM** 56456, **BE** 56441, **EV** 56448 | after R5, after R10, and on the final tip; CI `postgres.yml` on the pushed branch |
| Browser gate | `corepack pnpm browser:ci` (`package.json:19`) | final tip (proves the API is unchanged end to end) |
| Review | Opus reviews R1–R5, R7, R9, R10, R11 (stock, payments, auth, outbox surfaces); Haiku reviews R6, R8, R12 | before merge |

**Merge:** one branch (`reorg/section9`) with commits R1–R11. R12 (`integration/erp/doc.go`) lands from WT-stub. Merge into `prod-hardening` only after the owner's
go-ahead.

**Deploy:** a deploy is optional. It is behaviour-neutral, so it can ship with step 2's release.

**Rollback:**
- Every commit is self-contained and green, so `git revert <sha>` in reverse order works.
- No migration and no API change, so nothing else needs reverting.
- If the branch is not green by **Fri 23 Oct 15:00**, ship R1–R6 only (cut line 3).

**Follow-ups, not in step 1:**
- Fix the stale comment at `service/order.go:203`, which names `write/repo.go`; it becomes `write/catalog.go`.
- Optionally split `handlers/handlers.go` (504 lines).
- Rename the matching tests.

---

## 2. Step 2: ledger `stock_movements` (Mon 26 – Tue 27 Oct)

### 2.1 Design

**`internal/ledger` is the single door for stock movements.**
- **API:** `ledger.Record(ctx, tx, doc Document)` inserts one row per non-zero line into `stock_movements`. From
  Tue 27 it also inserts one `erp_outbox` row per document (step 5), all in the caller's transaction.
- **One added call per writer.** Because the outbox enqueue sits inside `Record`, each writer gets exactly one added
  call, which halves the touches to frozen code.
- **IDs:**
  - `document_id` is deterministic: uuidv5 of e.g. `sale:<order_id>` or `transfer_out:<transfer_id>`.
  - Each line's id is the `movement_id` sent to the ERP. It is unique on a `dedupe_key` such as
    `sale:<order_item_id>`.
  - Insert with `ON CONFLICT DO NOTHING`.
- **Zero-qty lines are skipped** (except `opening`). Count lines with no difference, a transfer received as 0 and a
  no-op adjust are common, so a ledger CHECK can never fail a sale (A44: never block a sale).
- **No DB trigger.** `TestStockSeqNoSqlObjectWritesStock` (`write/stockseq_guard_test.go:272-291`) fails on any
  trigger or function that mentions `outlet_variant_stock`, and its header (`:15-20`) records that a trigger was
  rejected for a lock-order cycle. Adding one would weaken a stock guard (AGENTS.md "Never").
- **Order inside each non-frozen writer:** the ledger call comes **before** `BumpStockSeq`, so the contract "the
  bump is the last stock/version statement" (`ledger/stockseq.go`, ex-`write/stockseq.go:13-27`) stays literally
  true.
- **`outlet_stock_seq` (mig 0057) stays unchanged.** It is the per-outlet, gapless, commit-ordered counter that
  tablets use (`sync/pull.go`, ex-`sync.go:124-188`; kill switch `SYNC_STOCK_SEQ=off`, `sync.go:47-50`). The ledger's
  global `seq` is **not** gapless or commit-ordered, so it must never serve as a relay cursor. Delivery is driven by
  `erp_outbox`.

### 2.2 Migration 0064 `0064_stock_movements.sql` (head today: `0063_receive_pin_wipe.sql`; the two `0005_` files are never renamed)

```sql
SET LOCAL lock_timeout = '5s';
CREATE TABLE stock_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- movement_id sent to the ERP
  seq           bigserial NOT NULL UNIQUE,                     -- diagnostics/ordering only
  document_id   uuid NOT NULL,                                 -- ERP Idempotency-Key
  dedupe_key    text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('sale','refund','transfer_out','transfer_in','transfer_cancel',
                  'receipt','adjust','count','opening','write_off')),
  location_type text NOT NULL CHECK (location_type IN ('outlet','warehouse')),
  location_id   uuid NOT NULL,      -- no FK: history must survive deletes
  product_id    uuid NOT NULL,      -- no FK, same reason
  variant_id    uuid,
  variant_size  text NOT NULL,
  qty           integer NOT NULL CHECK (qty <> 0 OR kind = 'opening'),
  qty_before    integer NOT NULL,
  qty_after     integer NOT NULL CHECK (qty_after = qty_before + qty),
  ref_type      text NOT NULL, ref_id uuid, ref_number text, ref_line text,
  actor         text, device_id text,
  occurred_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  flags         text[] NOT NULL DEFAULT '{}',
  refund_of_movement_id uuid REFERENCES stock_movements(id)
);
CREATE INDEX stock_movements_loc_variant ON stock_movements (location_type, location_id, product_id, variant_size, seq);
CREATE INDEX stock_movements_ref      ON stock_movements (ref_type, ref_id);
CREATE INDEX stock_movements_document ON stock_movements (document_id);
CREATE INDEX stock_movements_occurred ON stock_movements (occurred_at);
```

**Append-only** is enforced by a Go guard test: no `UPDATE` or `DELETE` on `stock_movements` anywhere under
`internal/`. There is a single DB role, so `REVOKE` cannot do it.

**Ingredients** (numeric(14,3), `0023:10`) do not fit an integer ledger and are **out of scope** (decision D14).

### 2.3 Writer inventory and change per writer (paths AFTER step 1; HEAD lines in brackets)

Before/after legend:
- **L** = the old value is read under lock.
- **D** = delta only. Post-read the locked row: after = stock, before = after − delta.
- **R** = `RETURNING stock` is already there.
- **A** = absolute set; needs a locked pre-read.

| # | Flow | New path : function (HEAD) | Before/after | Change | Seq bump | Idempotency today |
|---|---|---|---|---|---|---|
| 1 | **Sale** | `service/order.go:createOrderCore` (decrement `order.go:569-574`, lock :536-540) | L (`stock` :535, `next` :560) | **One call** after the sale-stock-exception loop closes (after `order.go:653`), before the reward-grant loop (:655): `if e := recordSaleMovements(ctx, tx, orderID, orderNumber, in, itemIDs); e != nil { return "", false, false, e }`. Helper in a new non-frozen `service/ledger_hooks.go`. It reads current stock for keys already locked by this tx and walks `in.Items` backwards: after = current stock, before = after + qty; flag `shortage` if after < 0. It runs before `processed_keys` (:769) and `BumpStockSeq` (:782), so a lost same-key race rolls it back too. **Frozen-body edit → decision D10.** | :782 | `processed_keys` :266/:769 |
| 2 | **Refund** | `service/refund.go:RefundTx` (restock `order.go:1005-1012`) | D | **No RefundTx edit.** New `RefundTxLedger` in `service/refund.go` = `RefundTx` + `recordRefundMovements` in the same tx. Callers switch: `Refund()` (`order.go:829-842` → refund.go) and `sync.processOne` (`sync.go:377-379`, which stays in sync.go; one token edit, `e.Orders.RefundTx` → `e.Orders.RefundTxLedger`; not frozen). Restocked lines = order lines without an `unresolved_variant` exception whose stock row exists. `refund_of_movement_id` = the sale movement. Caveat: lands after RefundTx's bump (:1063); takes no stock or version locks. Alternative (D11): one line at `order.go:1012`. | :1063 | status guard :917/:923; sync receipt |
| 3 | **Transfer send** | `write/transfer.go:sendTransfer` (:263-312), helper `deductStockGuarded` (:176-179, :170-174) | D | Helpers gain `RETURNING stock` (Exec → QueryRow, return `after`). The caller calls `ledger.Record` kind `transfer_out` before the bump at :307. | :307 | none → key added (§3) |
| 4 | **Transfer receive** | `write/transfer.go:receiveTransfer` (:321-441), `addStockDelta` (:144-157) | D | Same; kind `transfer_in`; sent qty and variance in flags/extra; before the bump at :436 | :436 | `received_idempotency_key` :337-345 |
| 5 | **Transfer cancel** | `write/transfer.go:cancelTransfer` (:449-491) | D | Same helper; kind `transfer_cancel`; before :486 | :486 | status guard :479 → key added (§3) |
| 6 | **Goods receipt** (outlet / warehouse) | `write/warehouse.go:CreateLocationGoodsReceipt` (:135-196; upsert :177-188) | D (summed per key) | One `RecordDeltas` after the upsert at :188; kind `receipt`, ref `goods_receipt` = `rid` | outlet only, :126 | none → key added (§3) |
| 7 | **Adjust** | `write/warehouse.go:AdjustLocationStock` (:201-239) | A | Locked pre-read (`SELECT stock … FOR UPDATE`, missing = 0) before :213/:221; Record kind `adjust`, qty = new − old; the adjustments insert (:229) gains `RETURNING id`. No `RETURNING OLD` (Neon PG version unverified, D13). | outlet only | none |
| 8 | **Stock count complete** | `write/stockcount.go:completeStockCount` (:416-462), `applyCountDeltas` (:506, :533-548) | R | Record inside the loop; `after` and `delta` are in scope; kind `count` | outlet :457; warehouse none (:450) | completed → replay with zero writes (:429-432) |
| 9 | **Create seeding** | `write/catalog.go:seedOutletStock` (`repo.go:218-255`, from CreateProduct :204) | before 0 | D12: refuse non-zero `variants[].stock` on create (the backoffice always sends 0, `apps/backoffice/src/screens/products/useProductsData.ts:231`), **or** one `opening` Record after :242 | yes (txStock `repo.go:84-106`) | none |
| 10 | **Variant rename** | `write/catalog.go:UpdateProduct` (`repo.go:311-321`) | qty unchanged | D13: refuse a rename while stock ≠ 0 (409). Existing bug: rename moves outlet stock but **not** `warehouse_variant_stock`; fix by mirroring the import's three-table move (`write/import_products.go:358-379`). | no | – |
| 11 | **Variant delete** | `write/catalog.go:UpdateProduct` (`repo.go:335-345`) | A | 409 `ErrVariantHasStock` when any outlet or warehouse stock ≠ 0 (sorted `SELECT … FOR UPDATE`). Existing bug: warehouse rows are left orphaned; fix in the same task. | no | – |
| 12 | **Outlet-config cleanup** | `write/catalog.go:SetProductOutletConfig` (`repo.go:429-433`) | A | Restrict the cleanup DELETE to sizes with no `product_variants` row AND stock = 0. Today a partial payload deletes live stock rows. | no | – |
| 13 | **Product delete** | `write/catalog.go:DeleteProduct` (`repo.go:362` → `delete` :1128), FK CASCADE (`0010_per_outlet_inventory.sql:8`, `0015_warehouses.sql:15`) | A (invisible to grep) | The same 409 guard before the delete | no | – |
| 14 | **Warehouse delete** | `write/warehouse.go:DeleteWarehouse` (:64-72), CASCADE (`0015:14`) | A | The same 409 guard | no | – |
| 15 | **CSV rename** | `write/import_products.go:writeImportedVariants` (:358-379) | qty unchanged | Under D13, block when stock ≠ 0 (the import already guards sizes in open documents, `csvimport/products.go:33-40`) | no | import run key (0056) |
| – | Non-movers | `service/lockorder.go:111-120` (lazy zero rows), `order.go:527-534`, `write/catalog.go` availability upsert (`repo.go:396-401`), `write/warehouse.go:SetOutletPar` (:249-253) | – | Listed as non-movers in the new guard | – | – |

**`mutated()` change.** `handlers/writes.go:64-79` maps only `ErrNotFound` → 404 and `ErrBusy` → 409; everything
else becomes 400. Rows 10–15 need an `apperr.Conflict` → 409 branch. That is a visible backoffice behaviour change:
product save, product delete, warehouse delete and outlet-config save can now refuse with
"varian masih punya stok di <lokasi>; nolkan lewat penyesuaian dulu".

**`product_variants.stock` retirement (stop writing; never drop):**
- Writes to remove: `write/catalog.go` (`repo.go:307` UpdateProduct, `:327` new variant, `:353` insertVariants).
  The one-off tools `fsmigrate/tables.go:59-66` and `sample_seed.sql:36-37` stay.
- **Nothing in `internal/` reads the column.**
- The API field `ProductVariant.stock` (`api/openapi.yaml:726-737`) is the *derived* live value
  (`read/catalog.go`, ex-`read/repo.go:109, 124`), so the API and the TS clients do not change.
- `ProductInput` reuses the schema (`openapi.yaml:2135`), so `stock` stays a required input that the server ignores
  (except under D12).
- After the demo, split out a `ProductVariantInput` (OpenAPI + gen:check, Opus).

### 2.4 Opening-balance backfill: an admin command, not a migration

**Why not a migration.** Migrations run at boot (`cmd/server/main.go:45`, one tx per file under an advisory lock,
`internal/db/db.go:79-135`). During a Cloud Run rollout the old revision keeps writing stock without movements.

**What `cmd/ledger-backfill` does, in one tx:**
1. Takes `LOCK TABLE outlet_variant_stock, warehouse_variant_stock IN SHARE MODE` (blocks writers for seconds;
   acceptable pre-launch).
2. For every stock row, inserts an `opening` movement:
   - qty = live − COALESCE(sum of existing movements, 0);
   - dedupe `opening:<lt>:<lid>:<pid>:<size>`;
   - `ON CONFLICT DO NOTHING`.

**Properties.**
- Idempotent, and correct even if movements began before it ran.
- A `--reanchor` mode writes `adjust` rows (ref_type `backfill`, dedupe `reanchor:<run_id>:…`) for drift after a
  rollback window.
- It also enqueues one `opening` document per location for the ERP (contract §10 example).

**It runs on the test Neon DB only with the owner's OK (D13).**

**Invariant (also the SL gate assertion):** it must return 0 rows.

```sql
WITH live AS (
  SELECT 'outlet' lt, outlet_id lid, product_id, variant_size, stock FROM outlet_variant_stock
  UNION ALL SELECT 'warehouse', warehouse_id, product_id, variant_size, stock FROM warehouse_variant_stock),
led AS (SELECT location_type lt, location_id lid, product_id, variant_size, sum(qty)::int s
          FROM stock_movements GROUP BY 1,2,3,4)
SELECT * FROM live FULL JOIN led USING (lt, lid, product_id, variant_size)
 WHERE COALESCE(live.stock,0) <> COALESCE(led.s,0);
```

### 2.5 Files, tasks, verification, rollback

| Task | Files | Verification | Reviewer |
|---|---|---|---|
| L1 | `db/migrations/0064_stock_movements.sql`, `ledger/ledger.go` (+_test), append-only guard + `TestLedgerEveryStockWriterRecords` (every stock-SQL file calls `ledger.Record*` or is a listed non-mover) | `go test ./...` | Opus |
| L2 | `write/transfer.go` (+ §3 keys) | TR 56445, ST 56458, SL | Opus |
| L3 | `write/warehouse.go` (receipt + adjust + key) | ST, SL | Opus |
| L4 | `write/stockcount.go` | SC 56451, SL | Opus |
| L5 | `service/refund.go` (`RefundTxLedger`), `service/ledger_hooks.go`, `sync/sync.go` (processOne token) | RF 56449, OR 56446, SL | Opus |
| L6 | `service/order.go` (D10 call) | S0C 56439, OS 56457, LO 56454, ST, SL | Opus |
| L7 | delete/rename guards + 409 branch + warehouse rename/delete bug fixes + outlet-config cleanup: `write/catalog.go`, `write/warehouse.go`, `write/import_products.go`, `handlers/writes.go` | IM 56456, ST, SL; manual backoffice check | Opus |
| L8 | Seeding decision (D12) + stop writing `product_variants.stock`: `write/catalog.go`. If seeding is forbidden, the ST case `handlers/stock_seq_writers_integration_test.go:392-404` changes deliberately. | ST | Opus |
| L9 | `cmd/ledger-backfill/`; **new PG gate SL** `("SL", "TestStockLedgerPostgres", 56467, "sl")` in `scripts/ci/postgres_gate.py` + `handlers/stock_ledger_integration_test.go` | SL: drive every writer, assert the invariant after each step, assert replays add 0 movements, assert shortage flags = `sale_stock_exceptions` shortage rows | Opus |

**Stock-guard allowlist hunks (decision D2 covers these too).**

`stockSeqAllowlist` (`write/stockseq_guard_test.go:23-37`) rejects any `internal/` file that mentions
`outlet_variant_stock` and is not listed. A plain SELECT counts as a mention. These new files mention it and get an
entry with value `false` (they are not bumpers), in the commit that creates them:

| Task | File |
|---|---|
| L1 | `internal/ledger/ledger.go` (`RecordDeltas` post-read) |
| L5, L6 | `internal/service/ledger_hooks.go` (sale and refund stock reads) |
| L9 | `cmd/ledger-backfill` (outside `internal/`, not scanned) and the backfill/invariant query, if it lives under `internal/` |
| Step 5 | `internal/integration/erp/payload.go`, only if it reads stock (it should read `stock_movements` only) |

Literal-write pins (`:308-316`) are unchanged: none of these files writes stock.

**Rollback:**
- 0064 is additive: leave it in place and never renumber it.
- Reverting the code stops the writes, and the old revision ignores the table.
- After a rollback window, re-anchor with `--reanchor`.
- The guards and the stop on `product_variants.stock` writes are code-only, so a revert restores today's behaviour.

---

## 3. Step 3: money-path additive fixes still open at HEAD

### 3.1 Idempotency-Key + receipt on backoffice writes

**Today:** `Idempotency-Key` is read only at `handlers/writes.go:976` (`POST /orders`) and `handlers/imports.go:91`.

**Reusable helper:**
- `service.RunWithReceipt(ctx, pool, ReceiptClaim{Key, OpType, Scope, Payload}, effect func(tx pgx.Tx) (json.RawMessage, error))`
  (`service/receipts.go:25-37, 76`).
- It claims `operation_receipts` as the first statement (`:93`, migration 0045) and replays the stored outcome.
- **No migration is needed.**

**Pattern per endpoint:**
- The handler reads an **optional** `Idempotency-Key` (decision D18 on optional vs required), builds a fingerprint
  from the body (`RequestFingerprint`, `receipts.go:49`) and runs the write through `RunWithReceipt`.
- The write function gains a `…Tx(ctx, tx, …)` variant. The existing function becomes a wrapper (non-frozen edit).
- The OpenAPI operation declares the header (reusing `components.parameters` like `ImportIdempotencyKey`,
  `openapi.yaml:76-77`).
- The backoffice generates one uuid per form submit and reuses it on retry. Per-request headers are supported at
  `packages/api/src/client.ts:182-183`. These form changes belong to **WT-bo** on Wed 28, after OpenAPI edit #1
  (§6.3).

**Busy retry vs receipt (semantics change; Opus review).**
- The target writers wrap their whole transaction in `retryBusy`: `write/transfer.go:260, 318, 446` and
  `write/stockcount.go:340, 413`.
- Once the effect runs inside `RunWithReceipt`'s transaction, an inner retry can no longer restart that
  transaction.
- So the busy retry is **lifted to wrap `RunWithReceipt`**. Each attempt is a fresh transaction, and a rolled-back
  claim leaves no `operation_receipts` row, so re-claiming the same key is safe.
- The unkeyed path keeps today's behaviour (`runUnkeyed`, `receipts.go:77-80`).
- TR and SC must show an injected 40P01 retried to one effect.

| Endpoint | Route (`server.go`) | Handler (HEAD) | Write fn (HEAD) | Guard today | Demo-critical? |
|---|---|---|---|---|---|
| POST /inventory/goods-receipt | :247 | `writes.go:1603` | `write/warehouse.go:135` | none | **Yes:** a double submit = two receipt documents at the ERP |
| POST /transfers/{id}/send | :259 | `writes.go:387` | `write/transfer.go:259` | status only | **Yes** |
| POST /transfers/{id}/cancel | :261 | `writes.go:402` | `write/transfer.go:445` | status only | Yes (cheap; same file as send) |
| POST /inventory/adjust | :248 | `writes.go:1617` | `write/warehouse.go:201` | absolute value (replay-safe, overwrites concurrent sales, A17) | Can slip |
| POST /stock-counts/{id}/complete | :315 | `writes.go:1438` | `write/stockcount.go:412` | completed → zero-write replay (:429-432) | Can slip (already replay-safe) |
| POST /inventory/ingredient-goods-receipt | :273 | `writes.go:451` | `write/ingredient.go:146` | none | Can slip (ingredients out of ERP scope) |
| POST /customers/{id}/points/adjust | :304 | `writes.go:672` | `write/points.go:47` | none | Can slip (not stock) |
| POST /cash-flows | :151 | `writes.go:1342` (goes through `OrderSvc.ValidateShiftOutlet` :1354; the write fn was not located by the scout; confirm during implementation) | – | none | Can slip |
| POST /discount-codes/batch | :232 | `writes.go:211` | `write/repo.go:885` (→ `write/discount_code.go`) | none | Can slip |

**Files** (paths after step 1):
- `handlers/inventory.go`, `handlers/transfers.go`, `write/warehouse.go`, `write/transfer.go`
- `api/openapi.yaml` + `internal/api/api.gen.go` + `packages/api` generated TS
- `apps/backoffice` form submits for receipt and transfer

**Verification:**
- Extend OR 56446, or add cases to TR/SL: same key twice → one effect and the same response; same key with a
  different body → 409.
- `gen:check`, `quality:ci`.

**Rollback:** code-only. Receipts rows stay harmless.

**Reviewer:** Opus (stock + generated types).

### 3.2 Global `MaxBytesReader` middleware (can slip)

**Caps today** are 9 call sites, each set inline:
- `auth/handlers.go:157, 219, 257` (8/16 KiB)
- `handlers/imports.go:75` (20 MiB)
- `handlers/oversell.go:81` (16 KiB)
- `handlers/sync_review.go:25` (8 MiB)
- `handlers/writes.go:1260` (error logs 1 MiB)
- `writes.go:1520` + `batch_envelope.go:20` (sync batch 8 MiB)

Everything else is uncapped (goods receipts, transfers, cash-flows, customers, products, `/orders`, `/ota/check`).

**Plan:**
- Add `middleware/bodylimit.go`: 1 MiB default with an explicit exception list. The exceptions are the routes with a
  larger inner cap: imports, `/sync/batch`, sync-review and error-logs.
- A nested `MaxBytesReader` cannot raise an outer limit, so those routes must be exempt from the default rather than
  wrapped twice.
- Insert it after the global stack at `server.go:58-70`.

**Verification:**
- A unit test per exception.
- A 413 test on an uncapped route.
- BE 56441 (batch envelope).

**Rollback:** revert the middleware line.

**Reviewer:** Opus (sync/auth surfaces).

### 3.3 `format: double` on the residual float32 money fields (can slip; never in parallel with the reorg)

**Fields** (`internal/api/api.gen.go`; e.g.):
- `Price` :1485, :1497, :2436, :2571, :2619, :2662, :2857
- `BundlePrice` :1490
- `DiscountValue` :1595
- `SurchargeValue` :1611
- `AmountPaid` :1586
- `RoundingAmount` :1430
- `TotalSpent` :1675
- discount-code `Value` :1740, :1760, :1779
- plus about 30 other money-like fields: `MinPurchase`, `Total`, `UnitCost`, `StartingCash`, `ClosingCash`, …

Quantity fields stay as they are. The full field list with lines is in the scout notes; implementation re-derives
it.

**Change:**
- Add `format: double` to those properties in `api/openapi.yaml`.
- Run `make gen-go`, then fix the compile errors from the float32 → float64 change.
- The non-test `float32(` casts are at `handlers/writes.go:1090` (→ `handlers/loyalty.go`) and
  `read/repo.go:1618, 1621, 1858, 1937` (→ `read/inventory.go` / `read/promo_reports.go`).

TS is unaffected: `double` and `float` both generate `number`.

**Verification:** `make gen-check`, `go build`, `corepack pnpm gen:check`, `quality:ci`, plus every PG gate that
returns money (S0C, TD, QT, A27, RF).

**Reviewer:** Opus (generated types, payments).

**Rollback:** revert the spec and regenerate.

### 3.4 `customer_create`: `ON CONFLICT DO NOTHING` + read-back conflict (can slip; before go-live)

**Today:**
- `service/order.go:1862` (→ `service/customer.go:CreateCustomerTx`) runs
  `ON CONFLICT (id) DO UPDATE SET name, phone, email`.
- Its caller is the sync path, `sync/sync.go:684` (inside frozen `processOneWithSeq`; the call is unchanged).
- The wrapper `CreateCustomer` (:1837) has no caller.
- The HTTP path (`handlers/writes.go:143` → `write/repo.go:491`) has its own INSERT and is not affected.

**Change:**
- Switch to `ON CONFLICT (id) DO NOTHING RETURNING id`.
- If nothing is returned, read the row back. If it is equal, succeed. If it differs, return `apperr.Conflict`.
- On the sync path, `classifyItemError` (`sync/classify.go:35-41`) turns a coded error into a **non-retryable**
  item outcome with code Conflict.
  - **[Likely, unverified]** the tablet then shows it as a review item, as the owner rule "denied offline … =
    visible review item" requires.
  - The implementation must prove this in RV 56450 before merge. A silent drop would be worse than today's upsert.
- The body edit is in `CreateCustomerTx`, which is not frozen.

**Verification:** OR 56446 and RV 56450 (review item), CP 56464.

**Reviewer:** Opus (sync).

**Rollback:** code-only.

### 3.5 What else from the review is already fixed at HEAD

These need no work:
- S-3 PIN lockout (`write/receive_approval.go:22, 98-118`)
- S-4 no PIN hashes in pull (`read/repo.go:925-940`)
- R-2 batch cap 200 items / 8 MiB (`handlers/batch_envelope.go:16-23`)
- AC-3 customer list: `RequireCustomerReader` (`handlers/customerscope.go:40`) on `/customers*` (`server.go:188-198`), A30, release 8

### 3.6 Demo-critical summary

| Item | Status |
|---|---|
| Idempotency-Key on goods receipt, transfer send and transfer cancel | **Demo-critical.** Implemented with L2/L3 in the same commits, because they are the same files |
| Inventory adjust, stock-count complete, ingredient receipt, points adjust, cash-flows, discount batch | Can slip. Planned for Nov 3–6 |
| Global `MaxBytesReader` | Can slip |
| `format: double` | Can slip; generated-type churn right before the demo is a risk without demo value |
| `customer_create` ON CONFLICT | Can slip; it is a go-live blocker (S-1), not a demo item |

---

## 4. Step 4: external ids + catalog pull (Mon 26 – Wed 28 Oct, parallel worktree WT-catalog)

### 4.1 Migration 0066 `0066_erp_external_ids.sql` (additive)

```sql
ALTER TABLE product_variants ADD COLUMN erp_slug text, ADD COLUMN erp_synced_at timestamptz;
CREATE UNIQUE INDEX product_variants_erp_slug ON product_variants (erp_slug) WHERE erp_slug IS NOT NULL;
ALTER TABLE products   ADD COLUMN erp_group_key text;           -- K1 product_slug when the ERP adds it; else POS rule
CREATE UNIQUE INDEX products_erp_group_key ON products (erp_group_key) WHERE erp_group_key IS NOT NULL;
ALTER TABLE outlets    ADD COLUMN erp_slug text, ADD COLUMN erp_code text;  -- erp_code feeds GET /outlets/{code}/stock; outlets.code stays POS-owned (receipt numbers, mig 0052)
CREATE UNIQUE INDEX outlets_erp_slug ON outlets (erp_slug) WHERE erp_slug IS NOT NULL;
ALTER TABLE warehouses ADD COLUMN erp_slug text;               -- contract location.type=warehouse; mapped manually (the ERP API has no warehouse endpoint)
CREATE TABLE integration_watermarks (resource text PRIMARY KEY, watermark timestamptz, last_full_sync_at timestamptz,
  last_run_at timestamptz, last_status text, last_error text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE erp_sync_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resource text NOT NULL, mode text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, pages int, upserted int, tombstoned int,
  status text NOT NULL DEFAULT 'running', error text);
```

Schema facts at HEAD:
- `product_variants` (`0001_init.sql:85`, barcode `0014:3`)
- `products` (`0001:72`, `0013`)
- `outlets.code` (`0005_order_scheme_outlet_code.sql:11`)
- `warehouses.code` nullable, no slug (`0015_warehouses.sql:3`)

### 4.2 Global SKU uniqueness and the one-time mapping

**Today:**
- The SKU is unique **per product** only: `idx_variant_product_sku ON product_variants(product_id, sku)`
  (`0012_variant_sku_unique.sql:8-9`).
- **No code generates SKUs.** The `SKU-xxxxxxxx` values came from the one-time SQL backfill
  (`0012_variant_sku_unique.sql:5-6`).
- The write path requires a SKU (`write/repo.go:140-141`, duplicate check `:143-144` → `write/catalog.go`), and so
  does the CSV import (`csvimport/products.go:20, 192`).

**Procedure:**
1. **Read-only Neon counts.** Needs the owner's OK; secret from GCP Secret Manager, never pasted:
   `SELECT sku, count(*) FROM product_variants GROUP BY sku HAVING count(*) > 1` and
   `SELECT count(*) FROM product_variants WHERE sku LIKE 'SKU-%'`.
2. **`GET /admin/erp/sku-mapping/export`** (admin) → CSV with columns variant_id, product, size, sku, has_stock,
   barcode, plus empty `fg_code`, `fg_slug`, `erp_group_key`.
3. The owner or the ERP developer fills the CSV from the ERP catalog. The FG `code` is immutable, so this is
   one-time.
4. **`POST /admin/erp/sku-mapping/import`**, dry-run first, then apply. Use the existing import pattern:
   `Idempotency-Key` + `import_runs` + advisory lock (`write/import.go:171, 198`).
   - It sets `sku = fg_code`, `erp_slug`, `erp_group_key`.
   - It refuses duplicates, unknown variant ids, and an fg_code already used by another variant.
   - The barcode is left as it is: today it defaults to the SKU (`0014:6`), and printed labels stay valid.
5. **Migration 0067 `0067_variant_sku_global_unique.sql`:** `CREATE UNIQUE INDEX product_variants_sku_global ON product_variants (sku)`.
   - It ships in a **separate later deploy**, only after step 1 returns 0 duplicates on Neon.
   - Migrations run at boot, so a duplicate would crash-loop the revision.
   - The per-product index stays (additive only).
   - `validateVariants` (`write/catalog.go`) gains a global check so the user gets a 409 message, not a raw
     unique-violation 400.

### 4.3 ERP client via oapi-codegen

**Snapshot the spec.** Copy `erp-flamboyan/docs/integration/openapi.v1.json` (ERP `main` @ `1c1d08f5`) to
`backend/api/erp/openapi.v1.json`, and record the ERP sha in a header file.

**Generate:**
- `backend/internal/integration/erp/erpapi/erp.gen.go` with `package erpapi` and `generate: types, client`.
- Config: `backend/internal/integration/erp/erpapi/oapi-codegen.yaml`.
- Use the **already pinned** `go tool oapi-codegen` (go.mod: `oapi-codegen/v2 v2.7.2`, `tool` directive), so there
  is no go.mod change.
- Add a Makefile target `gen-erp` and a drift check `gen-erp-check`.
  - Wire the drift check into `backend.yml` after the dependency-security branch merges; it is a collision file.

**Risk.** The ERP spec is **OpenAPI 3.1.0** (`openapi.v1.json:2`), and the ERP docs tested oapi-codegen **v2.8.0**
(README:190-194). v2.7.2 may reject 3.1 type arrays.

The **Thu 22 spike** decides between:
- (a) v2.7.2 works;
- (b) down-convert the snapshot to 3.0 mechanically (`type: [x, "null"]` → `nullable: true`), with no dependency
  change;
- (c) bump to v2.8.0 after dependency-security merges. That changes go.mod/go.sum and the dependency policy, and the
  codegen guard checks the dep version (`internal/codegen/guard.go:169`).

**Recommendation: (b) if (a) fails.**

**Client wrapper** `integration/erp/client.go`:
- base URL and key from config; add `ERP_BASE_URL`, `ERP_API_KEY` (Secret Manager) and `ERP_INTEGRATION_ENABLED` to
  `config.go` (struct ~:30-45, `Load()` :166-198, `Validate()` :226);
- 10 s timeout, following the only existing outbound client (`observability/observability.go:70`);
- retry on 429/503 honouring `Retry-After`;
- URL-encoded `updated_since` (README:99).

### 4.4 Catalog pull job (`integration/erp/catalog.go`)

Follows the ERP watermark protocol (README:101-125):
- Save the first page's `server_time` as candidate W.
- Fetch all pages until `next_cursor` is null, upserting by slug.
- Commit W only when the run completes.
- The next incremental run uses `updated_since = W − 5 min`. Never derive W from `max(updated_at)`.

**Finished goods** (`IntegrationFG`, `openapi.v1.json` ~:578): upsert `product_variants` by `erp_slug`.
- **Known slug:** update ERP-owned fields (name, category, status → active). **Never rename a size that holds stock.**
  Size and category renames do not bump `updated_at` (README:126), so only the full run sees them.
- **Unknown slug:**
  - find the parent by `erp_group_key` (K1 `product_slug` when available, else the POS rule: normalised name minus
    size, within the category; D19);
  - create the variant with size label from `size` (ml) as `"<n>ml"`, or the K2 convention for non-ml items;
  - set `sku = code` and `price = 0`;
  - leave the product **not sellable until a price is set in the backoffice** (D20).
- **`DISCONTINUE` or `deleted_at`** → variant inactive; the product is inactive when all its variants are.
- Tombstones never hard-delete.

**Outlets** (`IntegrationOutlet` ~:690): upsert by `erp_slug`, store `erp_code`, update name, address and phone.
- **Never overwrite `outlets.code`.**
- An unknown ERP outlet is created **inactive** for an admin to finish.

**Full run + reconcile** (`mode=full`): records absent from a complete full run are deactivated. Reconcile only if
every page succeeded (README:117-125). Each run writes an `erp_sync_runs` row.

**Triggers:**
- **Scheduler:** `POST /internal/erp/catalog-pull?mode=incremental|full`.
  - Authenticated by the scheduler credential (D15); outside `RequireAuth`.
  - Cloud Scheduler runs incremental every 15 min and full daily at 02:00 WIB.
  - Cloud Run is request-driven (no ticker exists, `cmd/server/main.go:52-87`), so each run has a time budget below
    the 30 s write timeout and resumes from the watermark next time.
- **Backoffice "Tarik katalog sekarang":** `POST /admin/erp/catalog-pull` (admin JWT, `mw.RequireRole("admin")`,
  `middleware.go:45`).

**Content version.** A changed catalog must bump the content version (`write/repo.go:bumpVersion`) so tablets pull it
through the normal `/sync/version` → `/sync/pull`.

### 4.5 Backoffice read-only gating of ERP-owned fields

When `erp_slug` is set, the ERP owns name, size, category, active and SKU. The POS keeps price, images, barcode,
bundles, recipes and loyalty.

**UI:**
- `apps/backoffice/src/screens/products/ProductFormModal.tsx` (name, category :107, active :113-116)
- `VariantRows.tsx` (size :49, sku :51)
- `screens/inventory/OutletFormModal.tsx` (:111-114)
- CSV `ImportExportBar` on `screens/Products.tsx:39` (import skips ERP-owned columns for linked rows and warns)
- A badge "Dari ERP" on the row.

**Server:**
- `write/catalog.go:UpdateProduct` and `write/outlet.go:UpdateOutlet` reject changes to ERP-owned fields on linked
  rows (409).
- `csvimport/products.go` treats them as read-only.
- OpenAPI adds read-only `erpSlug`, `erpGroupKey` (Product), `erpSlug` (ProductVariant) and `erpSlug`, `erpCode`
  (Outlet).

**Cut line 6:** keep UI gating only, or none.

### 4.6 Files, verification, rollback (step 4)

**Files:**
- `db/migrations/0066_erp_external_ids.sql`
- `api/erp/openapi.v1.json`
- `internal/integration/erp/{erpapi/*, client.go, catalog.go, mapping.go}`
- `handlers/erp_admin.go` (new)
- `server.go` (one route block)
- `config/config.go`
- `api/openapi.yaml` + generated files
- `apps/backoffice/src/screens/products/*`, `screens/inventory/OutletFormModal.tsx`
- `scripts/ci/postgres_gate.py`

**Verification:**
- **New PG gate ER** `("ER", "TestErpIntegrationPostgres", 56468, "er")`. It runs the catalog pull against an
  in-process `httptest` erpstub covering full, incremental, tombstone, interrupted run (watermark not advanced),
  never-rename-with-stock, outlet code untouched, and mapping import dry-run/apply/duplicate refusal.
- `gen:check`, `quality:ci`, `browser:ci`.
- archtest: `integration/erp` adapter tier, `erpapi` leaf.

**Rollback:**
- 0066 is additive; leave it in place.
- `ERP_INTEGRATION_ENABLED=false` stops every pull.
- Remove the Scheduler jobs.
- The UI gating is code-only.

---

## 5. Step 5: outbox + relay + `cmd/erpstub`

### 5.1 Migration 0065 `0065_erp_outbox.sql` (lands with L1–L9 on Tue 27)

```sql
CREATE TABLE erp_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL UNIQUE,            -- = stock_movements.document_id = ERP Idempotency-Key
  kind             text NOT NULL,
  location_type    text NOT NULL, location_id uuid NOT NULL,
  ref_type         text NOT NULL, ref_id uuid,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','held','sending','delivered','replayed','dead')),
  attempts         int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_until      timestamptz,
  last_http_status int, last_error text, hold_reason text,
  payload          jsonb,        -- frozen at first build: retries send byte-identical bodies (ERP 409 on a body change)
  payload_sha256   text,
  erp_response     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX erp_outbox_due ON erp_outbox (next_attempt_at) WHERE status IN ('pending','held','sending');
```

`ledger.Record` **always** inserts the outbox row (`ON CONFLICT (document_id) DO NOTHING`) in the same tx as the
movements. 0064 and 0065 ship in the **same release** (nothing deploys before Thu 29), so no writer ever runs without
the outbox table and no runtime table check is needed. On Mon 26, 0065 is drafted alongside 0064 in WT-main.

Migration numbers 0064–0067 are pre-assigned here so parallel worktrees do not race. Otherwise owner rule #11
renumbers in the PR that merges second.

**Document size limit (handoff §4.6: ≤ 200 lines per document).** `ledger.Record` splits any document with more
than 200 lines into parts.
- Each part shares `ref.id` and carries `part: n`.
- Each part gets its own deterministic `document_id` = uuidv5(`<document key>:part:<n>`), and therefore its own
  outbox row.
- Lines are ordered by (product_id, variant_size) before chunking, so parts are stable across replays.
- This covers the opening backfill (an outlet with more than 200 variants), large stock counts and large receipts.
- ER gate case: a 450-line count → 3 documents → all delivered → the stub balance equals the sum.

### 5.2 Relay (`integration/erp/relay.go`)

**Claim.** `UPDATE erp_outbox SET status='sending', lease_until=now()+interval '60s' WHERE id IN (SELECT id … WHERE status IN ('pending','held') OR (status='sending' AND lease_until<now()) AND next_attempt_at<=now() ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING …`.
Concurrent scheduler hits cannot double-send.

**Build the payload** on first send from `stock_movements` (by `document_id`) joined to:
- `product_variants.sku` → `fg_code`
- `outlets.erp_slug` / `warehouses.erp_slug` → `location.slug`
- for sale and refund: `orders` (number, payment method, amounts) → `ref.number`, `tenders`

The shape follows contract §4.3 and the §10 examples. Store `payload` + `payload_sha256`.

**Unmapped variant or location** → status `held` with `hold_reason`, retried every run without counting an attempt.
Once the SKU mapping lands, held documents flow on their own.

**POST** `/api/integration/v1/stock-documents` with `Idempotency-Key: <document_id>`.

| ERP response | Outbox result |
|---|---|
| 200 `applied` | `delivered` |
| 200 `replayed` | `replayed` |
| 409 `IDEMPOTENCY_CONFLICT`, 422, 403 | `dead` immediately (needs a human) |
| 429, 503, 5xx, network | `attempts++`, `next_attempt_at = now() + min(2^attempts min, 60 min)`, honour `Retry-After`; after **10** attempts → `dead` |

**Enable flag.** `ERP_RELAY_ENABLED` (default **off**): when off, documents accumulate and nothing is sent.

**Triggers:**
- Cloud Scheduler every 2 min → `POST /internal/erp/relay` (scheduler credential, D15).
- Backoffice `POST /admin/erp/relay` (admin) for the manual "Kirim sekarang".
- Each run has a 20 s budget.

**Dead-letter API (admin):**
- `GET /admin/erp/outbox?status=&kind=&page=` (paginated)
- `GET /admin/erp/outbox/{id}` (payload + last response)
- `POST /admin/erp/outbox/{id}/retry` (dead or held → pending, attempts reset)

All of these are added to `api/openapi.yaml`, so the `/ota/*` spec gap is not repeated.

### 5.3 Backoffice dead-letter view

New `apps/backoffice/src/screens/integration/ErpOutboxScreen.tsx`, with a nav entry in `App.tsx:39-52` NAV
("Integrasi ERP", admin only; `canSeeNav` :113). It shows:
- counts by status;
- a table of held and dead documents (kind, ref number, location, reason, attempts, last HTTP status);
- a detail drawer with the payload;
- a "Kirim ulang" button;
- the last catalog run from `erp_sync_runs`;
- a "Tarik katalog sekarang" button.

In-screen view swap, no router (existing convention).

**Cut line 5:** API + SQL only.

### 5.4 `cmd/erpstub` (Thu 22 – Fri 23, parallel worktree WT-stub)

A standalone Go binary (stdlib `net/http`, generated `erpapi` models for the catalog shapes; `cmd/` is not walked
by archtest) that implements the contract, so **the demo does not depend on the ERP being hosted**.

**Endpoints:**
- `GET /api/integration/v1/catalog/finished-goods` and `/catalog/outlets`: seeded from a JSON fixture, with the full
  watermark semantics (`server_time`, `updated_since`, `cursor`, `take` 1-500, `deleted_at` tombstones,
  DISCONTINUE).
- `GET /outlets/{code}/stock`.
- `POST /api/integration/v1/stock-documents`: exactly the handoff §4.3 contract.
  - Bearer key, `Idempotency-Key` = `document_id`.
  - Dedupe on `(pos:<brand>, document_id)` with a request hash.
  - Same body → 200 `replayed`; different body → 409 `IDEMPOTENCY_CONFLICT`.
  - Unknown `fg_code` or slug → 422 `VALIDATION_ERROR`, nothing written.
  - Per-line `movement_id` uniqueness.
  - A live balance per (fg, location) (option A of handoff §4.4).
- Demo and test hooks:
  - `GET /_stub/documents`, `GET /_stub/balances`
  - `POST /_stub/fg` (create an FG live to show "catalog down")
  - `POST /_stub/fault?status=503&count=3` (show retry)

**Storage:** in-memory with optional `-state file.json` persistence.

**Tests:** `cmd/erpstub/main_test.go` uses the handoff §10 example documents as fixtures.

**Contract file.** `docs/integration/stock-documents.v1.yaml` (OpenAPI 3.0 fragment of §4.3) is written from the
handoff and offered to the ERP developer. The relay and the stub share hand-written Go structs in
`integration/erp/document.go`, plus a contract test against the §10 JSON examples.

**Hosting for the demo (D16):**
- (a) a second Cloud Run service `erpstub` (owner deploy go-ahead), or
- (b) the real ERP if it is hosted with `stock:write` by Thu 29.

The relay switches by `ERP_BASE_URL` only.

### 5.5 Files, verification, rollback (step 5)

**Files:**
- `db/migrations/0065_erp_outbox.sql`
- `ledger/ledger.go` (enqueue)
- `integration/erp/{relay.go, document.go, payload.go}`
- `handlers/erp_admin.go`
- `server.go`
- `config/config.go`
- `api/openapi.yaml` + generated files
- `apps/backoffice/src/screens/integration/*`, `App.tsx`
- `cmd/erpstub/*`
- `docs/integration/stock-documents.v1.yaml`
- `scripts/ci/postgres_gate.py` (ER cases)

**Verification (ER gate + unit tests):**
- sale → one document → delivered;
- replay → `replayed`, no second ERP movement;
- a 503 ×3 fault → retries then delivered;
- 422 → dead → mapping fix → retry → delivered;
- an unmapped variant → held → mapped → delivered;
- two concurrent relay runs → each document sent once;
- the payload byte-identical across retries.

**Rollback:**
- `ERP_RELAY_ENABLED=false`.
- 0065 is additive.
- Outbox rows are inert when the relay is off.
- Remove the Scheduler job.

**Reviewer:** Opus (outbox, sync-adjacent).

---

## 6. Demo, schedule, parallel work, risks, cut lines

### 6.1 Demo script (Mon 2 Nov) with expected results

**Environment:**
- backend on Cloud Run (test env, the release from Thu 29) with `ERP_INTEGRATION_ENABLED=true`,
  `ERP_RELAY_ENABLED=true` and `ERP_BASE_URL` = erpstub (or the real ERP);
- one tablet or emulator on APK 2.1 / OTA 2.1.5, which needs no change;
- the backoffice open on the "Integrasi ERP" screen;
- a psql read-only session for the invariant query.

| # | Action | Expected result |
|---|---|---|
| 1 | Show the mapping: backoffice product list with "Dari ERP" badges; SKU = FG code | Linked variants show `erpSlug`; name, size, category and SKU fields are read-only |
| 2 | Create an FG in the ERP (`POST /_stub/fg` or the ERP UI) → "Tarik katalog sekarang" | `erp_sync_runs` row ok; new variant under the matching product, price 0 and not sellable; set a price → tablet "Sinkron" → item visible |
| 3 | Sell 2 items on the tablet (one line oversold) | `/sync/batch` ok; 2 `sale` movements (one flagged `shortage`); outbox document `pending` → after relay `delivered`; ERP/stub balance −2; `sale_stock_exceptions` shortage row = flagged movement |
| 4 | Re-send: the tablet replays the same batch item; then "Kirim ulang" on the delivered document | Tablet: `processed_keys` replay, 0 new movements; ERP: `replayed`, balance unchanged |
| 5 | Refund the sale on the tablet | `refund` movements (+2) with `refund_of_movement_id`; document delivered; ERP balance restored |
| 6 | Backoffice transfer warehouse → outlet: send (double-click "Kirim"); receive 9 of 10 on the tablet | One `transfer_out` (−10 warehouse); the second click replays (same key) → 1 transfer; `transfer_in` +9 with variance flag; two ERP documents with the same `ref.id` |
| 7 | Goods receipt at the outlet, submitted twice with the same key (simulated retry) | One receipt, one `receipt` document |
| 8 | Fault: `POST /_stub/fault?status=503&count=3`, then sell | Document retries (attempts 1–3, backoff) then `delivered` |
| 9 | Dead-letter: a variant with an fg_code unknown to the ERP | 422 → `dead` in the dead-letter view with the reason; fix the mapping → "Kirim ulang" → `delivered` |
| 10 | Try to delete a variant with stock | 409 "varian masih punya stok di <lokasi>; nolkan lewat penyesuaian dulu" |
| 11 | Run the §2.4 invariant query | 0 rows: the ledger sum equals live stock at every location |

Out of demo scope (handoff §8): daily reconciliation report (P-H), ERP-to-POS corrections, ingredients, ERP movement
reports.

### 6.2 Day-by-day schedule

| Day | Main line (WT-main, one implementer, Opus reviews) | Parallel | Owner / ERP |
|---|---|---|---|
| **Thu 22 Oct** | Morning: D6/D8 are not needed for Thursday (D1–D5, D7, D9, D10 decided 2026-10-21). R1–R5 splits (+ guard hunks), R6 archtest; Opus review of R1–R5 | **WT-stub:** `integration/erp/doc.go` (R12), `api/erp/openapi.v1.json` snapshot, erpapi codegen spike (§4.3 a/b), start `cmd/erpstub` catalog endpoints | Owner OK for read-only Neon SKU counts (§4.2 step 1). ERP: agree contract §4.3/K1/K2/tenant |
| **Fri 23 Oct** | R7–R11, full verification (§1.8), Opus review; **15:00 cut-line check**; owner go-ahead → merge to `prod-hardening` | WT-stub: `POST /stock-documents` stub + tests, `docs/integration/stock-documents.v1.yaml`; draft SQL for 0064–0066 (new files only) | Mapping CSV export spec agreed; ERP hosting status |
| Sat 24 – Sun 25 | – (no planned work) | – | – |
| **Mon 26 Oct** | L1 (0064 + `internal/ledger`), L2 (transfers + keys), L3 (receipt + adjust + key), L4 (count); OpenAPI edit #1 (Idempotency-Key params) | **WT-catalog** (after the merge): 0066, ERP client wrapper, `catalog.go`, `handlers/erp_admin.go` (catalog routes), ER gate skeleton | Owner D10–D13 answers if not given Thu |
| **Tue 27 Oct** | L5 refund wrapper, L6 sale call (D10), L7 guards, L8 seeding/stop writes, L9 backfill + SL gate; 0065 + outbox enqueue in `ledger.Record` | WT-catalog: mapping export/import, backoffice read-only gating; OpenAPI edit #2 (erp fields + catalog admin) | Mapping CSV filled by owner/ERP dev |
| **Wed 28 Oct** | Relay (`relay.go`, payload builder, held/dead/retry), `/internal/erp/relay` + `/admin/erp/outbox*`, scheduler auth (D15); OpenAPI edit #3; ER gate (relay cases vs in-process stub) | WT-catalog: catalog full/incremental/reconcile against erpstub, ER cases; **WT-bo:** dead-letter screen (after edit #3 lands) | ERP endpoint test from their side (`integration:smoke`) |
| **Thu 29 Oct** | Opus review of the whole release; quality:ci, all 30 PG gates (28 + SL + ER), browser:ci; owner go-ahead → push, deploy backend as a traffic-free tag, smoke, promote; deploy erpstub (D16); Neon backfill (D13); create Scheduler jobs; apply the SKU mapping; 0067 only if Neon dup count = 0 | WT-bo: polish, merged before the deploy | Owner go-aheads (deploy, Neon writes, Scheduler) |
| **Fri 30 Oct** | **Rehearsal** of §6.1 end to end on the test env (twice), fix findings, HANDOFF update; **17:00 freeze** | – | ERP joint E2E if hosted (handoff §8) |
| Sat 31 – Sun 1 Nov | Buffer only (no planned work) | – | – |
| **Mon 2 Nov** | Demo | – | – |
| Tue 3 – Fri 6 Nov | §3 slip items (keys on the other 6 endpoints, MaxBytes, `format: double`, customer_create), R13 golangci advisory, deferred leaks (§1.5) as separate Opus slices | – | – |

### 6.3 Parallel worktrees and collision files

| Worktree | Owns (new or exclusive files) | Window | Must not touch |
|---|---|---|---|
| WT-main | `backend/internal/{read,write,service,sync,handlers}` moves; `internal/{rules,ledger,archtest}`; ledger + writers; relay; `0064`, `0065` | Thu 22 → Thu 29 | `apps/backoffice` |
| WT-stub | `backend/cmd/erpstub/**`, `backend/internal/integration/erp/{doc.go,erpapi/**}`, `backend/api/erp/**`, `docs/integration/stock-documents.v1.yaml` | Thu 22 → Fri 23 (merges first) | any existing file |
| WT-catalog | `0066`, `integration/erp/{client,catalog,mapping}.go`, `handlers/erp_admin.go` (catalog half), `apps/backoffice/src/screens/products/**`, `screens/inventory/OutletFormModal.tsx` | Mon 26 → Wed 28 (after the reorg merge) | `write/` stock writers, `ledger/` |
| WT-bo | `apps/backoffice/src/screens/integration/**`, `App.tsx` NAV line, and the `Idempotency-Key` send/reuse in the goods-receipt and transfer send/cancel forms (§3.1; demo steps 6–7) | Wed 28 → Thu 29 | backend |

**Collision files (serialise; one owner at a time, in this order):**
- **`backend/api/openapi.yaml`, `internal/api/api.gen.go`, generated TS in `packages/api`:** edit #1 WT-main Mon 26
  → #2 WT-catalog Tue 27 → #3 WT-main Wed 28 → `format: double` after the demo.
- **`internal/server/server.go`:** one route-block commit per worktree, rebased.
- **`internal/config/config.go`:** WT-catalog adds the `ERP_*` keys once; WT-main reuses them.
- **`scripts/ci/postgres_gate.py`:** SL from WT-main, ER from WT-catalog (different tuple lines; rebase).
- **`write/stockseq_guard_test.go`:** WT-main only.
- **`backend/go.mod`/`go.sum`, `.github/workflows/*.yml`:** the dependency-security session first; R13 and
  `gen-erp-check` after it.
- **Migration numbers:** pre-assigned 0064 (ledger), 0065 (outbox), 0066 (external ids), 0067 (SKU global unique,
  separate deploy).
- **`HANDOFF.md`:** the main checkout has an uncommitted ERP paragraph; only the main-line session edits it.

### 6.4 Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| ~~Owner declines the 3-line call in frozen `createOrderCore` (D10)~~ **Retired 2026-10-21: D10 allowed.** | – | Fallbacks B (Tx wrapper through the `begin` seam, `order.go:242/249`) and C (post-commit derivation) stay documented in §2.3 only in case the Opus review of L6 rejects the insertion point |
| ERP not hosted or no `stock:write` by Thu 29 | High / low (stub) | erpstub is the demo target; the relay changes only `ERP_BASE_URL` |
| oapi-codegen v2.7.2 fails on OpenAPI 3.1 | Medium / low | Spike Thu 22; down-convert the snapshot (no dependency change) |
| SKU mapping data not ready | Medium / medium | Held documents wait without failing; the demo can use a mapped subset; 0067 waits |
| Duplicate SKUs on Neon make 0067 crash-loop at boot | Low / high | Read-only count first; 0067 in a separate later deploy |
| Reorg slips past Fri 23 | Medium / high (critical path) | Cut line 3 at 15:00 Fri: ship R1–R6 only |
| The combined R1 → R11 sequence was **not dry-run end to end**. The split dry run (R1–R5) and the cross-package prototype (R7–R10) each ran on a pristine copy | Medium / medium: import-block or guard-key interactions between the two | Thursday's first commit group (R1–R5) re-runs the **full** verification on its tip **before R6 starts**: the common gate, declhash, `make gen-check`, `codegen_gate.py`, the reorg Postgres gates and `quality:ci` (§1.8). R7–R11 then re-run the full gate per commit. Any difference beyond import blocks is a stop-and-report |
| Rename/delete 409 surprises backoffice users | Medium / low (pre-launch) | Message names the location and the fix; demo step 10 shows it on purpose |
| Old revision writes stock without movements during rollout | Certain / low | Backfill after drain; `--reanchor`; SL invariant checked post-deploy |
| Neon stale pooled connection gives a transient 400 on the first write after idle | Known / low | Re-run warm (known app-wide transient); not a ledger bug |
| Merge conflicts with in-flight branches | Low | No other unmerged local branch at `3a2dde5`; only the dependency-security session is active (go.mod, Dockerfile, CI, package.json) |
| New scheduler auth path (D15) is a security surface | Medium / medium | Shared secret with constant-time compare + Opus/security review; OIDC after the demo |
| Cloud Run request time budget cuts long relay or catalog runs | Low | Batches of 50 documents / one page per call, 20 s budget, resumable |

### 6.5 Cut lines in priority order (cut from the top first)

1. R13 golangci-lint CI job (keep the config file, run nothing).
2. §3 non-demo items: keys on adjust / stock-count / ingredient receipt / points / cash-flows / discount batch;
   `MaxBytesReader`; `format: double`; customer_create.
3. Cross-package moves R7–R11. Keep the R1–R5 splits + R6 archtest; `internal/ledger` is created new in L1 instead
   of R10.
4. Cloud Scheduler + 24 h reconcile: demo triggers runs manually through the admin buttons.
5. Backoffice dead-letter screen: API + psql instead.
6. Backoffice read-only gating: server guard only, then none.
7. Ledger kinds `adjust`, `count`, `write_off`. Keep sale, refund, transfer_*, receipt, opening; deletes stay
   blocked by 409.
8. Real ERP endpoint: erpstub only.
9. Catalog pull: the mapping CSV import only (the demo shows movements up, not catalog down).

**Never cut:**
- same-tx movements for sale, refund, transfer and receipt;
- the idempotent outbox + relay;
- erpstub;
- the SL invariant gate;
- Opus review of stock, sync and generated-type diffs.

---

## 7. Owner decisions still open, and what they block

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Approve this plan's scope: reorg = R1–R12 by Fri 23, golangci last | **DECIDED 2026-10-21: approved** | Step 1 start (Thu 22) |
| D2 | Stock-guard test edits (`write/stockseq_guard_test.go`, map keys and pins only, never weakening a check): (a) in the split commits, Option A (map keys + pin split) vs Option B (partial split); (b) `false` allowlist entries for the new ledger files that read stock (§2.5) | **DECIDED 2026-10-21: Option A, and yes to (b)** | R1–R3, L1, L5, L6 |
| D3 | Section banners dropped; snake_case new files; plural in read/handlers, singular in write; placements in Appendix A notes; helper tools kept outside the repo | **DECIDED 2026-10-21: yes to all** | R1–R5 |
| D4 | May `pkg.` qualifiers change inside the frozen bodies? | **DECIDED 2026-10-21** (recommended option, owner's standing instruction): **No for now.** Alias shims keep the bodies byte-identical; service→write stays allow-listed until after the demo | Removing service→write (deferred) |
| D5 | Are `ota` and `csvimport` pure leaves (allowed targets)? | **DECIDED 2026-10-21** (recommended option, owner's standing instruction): Yes | archtest allow-list size (7 vs 10) |
| D6 | Is `sync` allowed pgx/pgxpool permanently, or is it debt to remove? | Allow-listed debt; revisit after the demo | §1.5 sync rows |
| D7 | Password hashing destination: `rules/` or its own leaf (`internal/passwd`) | **DECIDED 2026-10-21** (recommended option, owner's standing instruction): `rules/` | R9 |
| D8 | Export `mapBusy`/`retryBusy` (tx_busy → db) and give rules its own `wib` | After the demo | Deferred leaks |
| D9 | golangci-lint advisory first, landing after all moves (deviates from review §10 order); loyalty moves count as money (Opus)? | **DECIDED 2026-10-21** (recommended option, owner's standing instruction): Yes; Haiku review is enough for alias-only R8 | R13, R8 reviewer |
| D10 | **Frozen `createOrderCore`: allow ONE added line (`recordSaleMovements`) after `order.go:653`?** Alternatives: Tx-wrapper (B) or post-commit derivation (C) | **DECIDED 2026-10-21: allow (A).** The single `recordSaleMovements` call goes after the sale's stock update; no existing statement changes. Opus review mandatory | L6 |
| D11 | Refund: wrapper outside `RefundTx` (runs after its seq bump) or one line at `order.go:1012` | Wrapper | L5 |
| D12 | Product create with non-zero stock: refuse (changes the ST case at `stock_seq_writers_integration_test.go:392-404` on purpose) or emit `opening` | Refuse | L8 |
| D13 | Block variant rename while stock ≠ 0; delete with stock → 409 (not auto write-off); run the backfill on test Neon after rollout; Neon PG version check | Yes to all | L7, L9, deploy day |
| D14 | Ingredients out of ERP phase 1 (numeric qty; no sale consumption, `write/recipe.go`) | Out | Scope of L* |
| D15 | Scheduler → backend auth: shared secret in Secret Manager (header, constant-time compare) or Cloud Scheduler OIDC token verified against Google certs (likely a new dependency → dependency policy) | Shared secret for the demo; OIDC after | `/internal/erp/*`, Scheduler jobs |
| D16 | Demo ERP target: deploy erpstub as a second Cloud Run service, or the real ERP if hosted | erpstub, switch if the ERP is ready Thu 29 | Thu 29 deploy |
| D17 | Who may see and retry the outbox: admin only, or a new permission `manage_integration` | Admin only for the demo | `/admin/erp/*`, WT-bo |
| D18 | `Idempotency-Key` on backoffice writes: optional (accept old clients) or required | Optional now, required after the backoffice ships | §3.1 |
| D19 | Product grouping rule until ERP K1 `product_slug` exists (handoff §9.2) | Normalised name minus size, within category, stored in `erp_group_key` and overridable in the mapping CSV | §4.4 new-FG creation |
| D20 | New ERP FG on the POS: created not-sellable at price 0 until priced | Yes | §4.4, demo step 2 |
| D21 | Handoff §9 (ERP or owner): tenant model (one ERP per brand vs shared; K4 code uniqueness) | – | `source.brand`/scope value, multi-brand rollout (not the demo) |
| D22 | Handoff §9: non-ml size convention (K2) | – | Size labels for non-ml FGs in §4.4 |
| D23 | Handoff §9: ERP live balance option A (new table) vs B | A | ERP side only; erpstub implements A |
| D24 | Handoff §9: oversell, ERP accepts `flags: ["shortage"]` and records a negative balance | Accept and record | Demo step 3 at the real ERP |
| D25 | Handoff §9: tenders and `customer_ref` sent now (stored, unused)? | Send | Payload builder (sent either way; the ERP may ignore) |
| D26 | Handoff §9: goods receipt for ERP POs, POS records, ERP matches manually (phase 1) | POS records | `receipt` documents |
| D27 | **Review S-2 OTA publish/signing:** `POST /ota/publish` is under `manage_settings` (`server.go:300-309`, handler `handlers/ota.go:110`); Capgo `autoUpdate: true` with no `publicKey` (`apps/pos/capacitor.config.ts:48`). Options: admin-only or a CI identity, bundle signing (public key in the APK, so it needs an APK), restrict `url` to the release bucket prefix | Admin-only now (backend only); signing with the next APK | Nothing in the demo; go-live |
| D28 | **Review AC-3 customer list:** already closed at HEAD (`RequireCustomerReader`, `server.go:188-198`, A30, release 8). Still open from A30: Q1 (do the three brands share one system? default "separate") and the review's staff-directory projection in pull (§5.11; approvers are already reduced to `userId, displayName`, `read/repo.go:925-940`) | Keep the defaults | Nothing in the demo; the multi-brand decision ties to D21 |
| D29 | Release go-aheads: merge reorg (Fri 23); push + deploy with 0064–0066 (Thu 29); Neon backfill + SKU mapping apply (Thu 29); Scheduler jobs; erpstub deploy; 0067 later | – | §6.2 Thu 29 |

---

## Appendix A: intra-package split tables (R1–R5)

Generated from the per-declaration assignment, with a declaration count check: 377 units, each assigned exactly
once. Line ranges run from doc-comment start to declaration end at `3a2dde5`. The splitter, the declaration lister
and `declhash` are in `docs/plans/2026-10-22-reorg-tools.md`.

### A.0 Stock-guard test edit (decision D2)

`backend/internal/write/stockseq_guard_test.go` has two path-keyed maps:

- `stockSeqAllowlist` (`:23-37`): files that mention `outlet_variant_stock` or call `BumpStockSeq`.
- `stockSQLPins` (`:308-316`): per-file count of literal stock-write SQL.

The guard scans every package, so a pure move fails it. These are the dry-run failures, unedited:

- `read/catalog.go`, `read/inventory.go`, `service/refund.go` and `write/catalog.go` are reported as "mentions ... not in stockSeqAllowlist".
- `read/repo.go` and `write/repo.go` are reported as "no longer mentions: remove the stale entry".
- `service/order.go` is reported as "literal 2; pinned 3".
- `write/catalog.go` and `service/refund.go` are reported as "no pin".

**Required edit (map keys and pin split only; verified green):**

```diff
 	"internal/service/order.go":    true,
+	"internal/service/refund.go":   true,
 ...
-	"internal/write/repo.go":       true,
+	"internal/write/catalog.go":    true,
 ...
-	"internal/read/repo.go":             false,
+	"internal/read/catalog.go":          false,
+	"internal/read/inventory.go":        false,
 ...
-	"internal/service/order.go":         {3, 0}, // lazy row, decrement, refund restock
+	"internal/service/order.go":         {2, 0}, // lazy row, decrement
+	"internal/service/refund.go":        {1, 0}, // refund restock
 ...
-	"internal/write/repo.go":            {5, 0}, // seed, rename, delete variant, availability, cleanup
+	"internal/write/catalog.go":         {5, 0}, // seed, rename, delete variant, availability, cleanup
```

**Invariant check.** Per package, the literal and dynamic stock-write totals are unchanged: service 3+0, write 5+0, read 0+0. `stockHelperCallers` is keyed by function name, so it is unaffected.

Put each package's hunk in the commit that splits that package, so every commit stays green. This affects the read, write and service commits.

**Placement constraint.** `txStock` (`write/repo.go:84-106`) holds the file's only `BumpStockSeq` call, and `CreateProduct` is its only caller. It **must** land in the same file as the stock writers `seedOutletStock`, `UpdateProduct` and `SetProductOutletConfig`. Otherwise one file bumps without mentioning the table, and the other mentions the table but is not a bumper.

**Option B (no test edit):** keep every stock-touching unit in its current file. That means:

- read/repo.go keeps catalog (`productObjScoped` to `Bundles`) and inventory (`LocationStock`, `InventoryOverview`, `IngredientOverview`, `MovementSummary`).
- write/repo.go keeps `txStock` plus products/categories.
- `Refund`/`OrderOutlet`/`RefundTx` stay in service/order.go.

Option B leaves 3 of the 5 god files only partly split.

**Recommendation: Option A,** with the edit above. It is exactly the "update this pin" path that the guard documents.

### A.1 R1 read/repo.go (1991 lines, 97 units) -> 21 files

| new file | lines at HEAD 3a2dde5 (doc start to decl end) | declarations moved (exact names; receivers dropped) | # |
|---|---|---|---|
| repo.go | 20-90 | ErrNotFound, Repo, New, Scope, listJSON, oneJSON, off | 7 |
| catalog.go | 94-218 | productObjScoped, availabilityWhere, sellableWhere, Products, Product, ProductOutletConfig, Categories, Bundles | 8 |
| outlets.go | 220-225 | Outlets | 1 |
| warehouses.go | 229-250 | Warehouses, WarehouseStock | 2 |
| ingredients.go | 252-347 | Ingredients, IngredientCategories, IngredientUsage, IngredientLocationStock | 4 |
| recipes.go | 349-458 | recipeLinesSQL, VariantRecipe, RecipeVariantIDs, RecipeVersions, RecipeVersion | 5 |
| ingredient_transfers.go | 460-584 | ingTransferItemsSubq, ingTransferObj, ingTransferFrom, IngredientTransfers, IngredientTransfer | 5 |
| ingredient_stock_counts.go | 588-638 | ingStockCountLocationExpr, IngredientStockCounts, IngredientStockCount | 3 |
| customers.go | 642-824 | segmentMatch, segmentSel, segmentIdSel, customerObj, customerObjWithTags, Customers, CustomerByPhone, customerPosObj, CustomerByPhoneNorm, CustomerLookup, Customer, Interactions, PointTransactions, RewardGrants, Tags, Segments | 16 |
| promotions.go | 828-884 | Promotions, WithoutCustomerNames, DiscountCodes, DiscountCodesByIDs | 4 |
| loyalty.go | 886-904 | LoyaltyConditions, LoyaltySettings | 2 |
| settings.go | 906-922, 1359-1374 | AppSettings, RecipesEnabled | 2 |
| users.go | 924-967 | ReceiveApprovingUsers, CustomRoles, userObj, Users, User | 5 |
| orders.go | 971-1019 | orderObj, Orders, Order | 3 |
| shifts.go | 1021-1129, 1337-1357 | shiftObj, Shifts, fillOpenCashRefunds, oneShift, Shift, CurrentShift, CashFlows | 7 |
| error_logs.go | 1131-1167 | errorLogObj, ErrorLogRetentionDays, ErrorLogs | 3 |
| stock_counts.go | 1169-1206 | stockCountObj, StockCounts, StockCount | 3 |
| transfers.go | 1208-1315 | transferObj, transferFrom, Transfers, Transfer, TransfersForOutlet, OutletTransferHistory | 6 |
| inventory.go | 1317-1335, 1376-1793 | LocationStock, InventoryOverview, IngredientOverview, MovementSummary | 4 |
| promo_reports.go | 1797-1972 | PromoRewardGrantRow, RewardGrantsByOrder, GrantReportFilters, PromoRewardGrantReport, CodeReportFilters, DiscountCodeReport | 6 |
| ota.go | 1974-1991 | LatestOtaRelease | 1 |

Notes:
- `catalog.go` and `inventory.go` mention `outlet_variant_stock`. They need the A.0 allowlist entries, both `false`.
- `LocationStock` (used by the transfers handler) goes to `inventory.go`, not `warehouses.go`. This keeps the stock-mentioning read files to two.
- `RecipesEnabled` reads `app_settings` and gates the recipe routes via `middleware.RequireRecipesEnabled` (`server.go:264`), so it goes to `settings.go`.
- `CashFlows` goes to `shifts.go`.
- `RewardGrantsByOrder` has no non-test caller. This is noted only; it is not removed.
- Existing read files keep their unsnaked names (`dupcandidates.go`, `orderfilter.go`, `syncreview.go`). Renaming them is a later question.

### A.2 R2 write/repo.go (1186 lines, 62 units) -> 8 files

| new file | lines at HEAD 3a2dde5 (doc start to decl end) | declarations moved (exact names; receivers dropped) | # |
|---|---|---|---|
| repo.go | 25-82, 108-113, 1128-1136, 1157-1176 | ErrNotFound, Repo, New, bumpVersion, bumpVersionOutlets, tx, jsonb, delete, nullStr, nullUUID, nullDate | 11 |
| catalog.go | 84-106, 117-478, 1138-1155 | txStock, Variant, variantBarcode, validateVariants, Product, productImages, CreateProduct, seedOutletStock, UpdateProduct, insertVariants, DeleteProduct, SetProductOutletConfig, Category, CreateCategory, UpdateCategory, DeleteCategory, barcodeConflict | 17 |
| customer.go | 482-519 | Customer, CreateCustomer, UpdateCustomer, DeleteCustomer | 4 |
| promotion.go | 523-781 | BXGYConfigInput, TierInput, TieredConfigInput, validateTiered, BundleSlotInput, BundleConfigInput, validateBundle, validateBXGY, Promotion, CreatePromotion, UpdatePromotion, DeletePromotion | 12 |
| discount_code.go | 785-948 | DiscountCode, CreateDiscountCode, codeAlphabet, randSuffix, DiscountCodeBatch, CreatedCode, prefixRe, validateDiscountCodeBatch, CreateDiscountCodeBatch, UpdateDiscountCode, DeleteDiscountCode | 11 |
| outlet.go | 952-994 | Outlet, CreateOutlet, UpdateOutlet | 3 |
| settings.go | 998-1124 | validatePaymentMethods, UpdateAppSettings, UpdateLoyaltySettings | 3 |
| ota.go | 1178-1186 | PublishOtaRelease | 1 |

Notes:
- `repo.go` keeps the package doc, the infrastructure (`tx`, `bumpVersion*`, `jsonb`, `delete`) and the "shared helpers" banner with `nullStr`/`nullUUID`/`nullDate`. It ends up at about 112 lines.
- `catalog.go` (419 lines) is the only stock writer from this file. It takes the `true` allowlist entry and the {5,0} pin.
- Singular filenames follow the existing write/ convention (`ingredient.go`, `segment.go`, `tag.go`).

### A.3 R4 handlers/writes.go (1720 lines, 131 units) -> 21 files

| new file | lines at HEAD 3a2dde5 (doc start to decl end) | declarations moved (exact names; receivers dropped) | # |
|---|---|---|---|
| writes.go | 24-80 | callerID, caller, decodeWrite, created, mutated | 5 |
| catalog.go | 84-141 | CreateProduct, UpdateProduct, DeleteProduct, GetProductOutletConfig, PutProductOutletConfig, CreateCategory, UpdateCategory, DeleteCategory | 8 |
| customers.go | 143-162, 552-704 | CreateCustomer, UpdateCustomer, DeleteCustomer, Tags, CreateTag, UpdateTag, DeleteTag, SetCustomerTags, Segments, CreateSegment, UpdateSegment, DeleteSegment, ReorderSegments, Interactions, CreateInteraction, DeleteInteraction, PointTransactions, AdjustPoints, RewardGrants | 19 |
| promotions.go | 164-232 | CreatePromotion, UpdatePromotion, DeletePromotion, CreateDiscountCode, UpdateDiscountCode, DeleteDiscountCode, CreateDiscountCodeBatch | 7 |
| loyalty.go | 234-253, 1045-1101 | CreateLoyaltyCondition, UpdateLoyaltyCondition, DeleteLoyaltyCondition, loyaltyPreviewBody, previewClock, LoyaltyPreview | 6 |
| outlets.go | 255-276 | CreateOutlet, UpdateOutlet | 2 |
| warehouses.go | 280-317 | Warehouses, CreateWarehouse, UpdateWarehouse, DeleteWarehouse, WarehouseStock | 5 |
| transfers.go | 321-404, 1547-1578 | Transfers, Transfer, TransferLocationStock, CreateTransfer, UpdateTransfer, SendTransfer, ReceiveTransfer, CancelTransfer, GetInboundTransfers, GetOutletTransfers | 10 |
| ingredients.go | 408-548 | Ingredients, CreateIngredient, UpdateIngredient, DeleteIngredient, IngredientUsage, CreateIngredientLocationGoodsReceipt, AdjustIngredientLocationStock, IngredientLocationStock, IngredientCategories, CreateIngredientCategory, UpdateIngredientCategory, DeleteIngredientCategory | 12 |
| ingredient_transfers.go | 708-774 | IngredientTransfers, IngredientTransfer, CreateIngredientTransfer, SendIngredientTransfer, ReceiveIngredientTransfer, ingredientTransferCancelBody, CancelIngredientTransfer | 7 |
| ingredient_stock_counts.go | 778-839 | IngredientStockCounts, IngredientStockCount, CreateIngredientStockCount, StartIngredientStockCount, ingredientStockCountSaveBody, SaveIngredientStockCount, CompleteIngredientStockCount | 7 |
| recipes.go | 843-910 | VariantRecipe, RecipeVariantIDs, RecipeVersions, RecipeVersion, SaveVariantRecipe, RestoreRecipeVersion | 6 |
| settings.go | 912-928 | UpdateAppSettings, UpdateLoyaltySettings | 2 |
| orders.go | 932-1043, 1103-1193, 1680-1720 | createOrderBody, CreateOrder, createOrder, returnOrder, refundHTTPError, RefundOrder, discountRejectMessage | 7 |
| shifts.go | 1195-1246, 1342-1369 | OpenShift, openShift, CloseShift, closeShift, CreateCashFlow | 5 |
| error_logs.go | 1248-1340 | errorLogsBodyLimit,maxErrorLogItems, CreateErrorLogs, errorLogSweepInterval,errorLogSweepBatch,errorLogSweepBatches,errorLogSweepBudget, maybeSweepErrorLogs | 4 |
| custom_roles.go | 1373-1392 | CreateCustomRole, UpdateCustomRole, DeleteCustomRole | 3 |
| stock_counts.go | 1396-1473 | CreateStockCount, UpdateStockCount, countConflict, CompleteStockCount | 4 |
| sync.go | 1477-1545 | SyncVersion, SyncPull, SyncBatch, syncBatch | 4 |
| uploads.go | 1580-1591 | SignUpload | 1 |
| inventory.go | 1595-1678 | locTarget, CreateLocationGoodsReceipt, AdjustLocationStock, SetOutletPar, InventoryOverview, IngredientOverview, MovementSummary | 7 |

**Route-bound GET handlers in writes.go.** 30 are derived by intersecting `server.go` `h.X` GET bindings with writes.go methods. `server.go` has 70 `.Get(` lines: 66 bind `h.X`, plus `/healthz`, `/livez`, `/readyz` and `/auth/me` (`ah.Me`).

None of these 30 go through `h.cached`. Correction to the brief: `h.cached(` is used in `handlers/handlers.go` **and** `handlers/users.go`. This is recorded only. Adding caching would be a behaviour change and is out of scope.

| handler | server.go line | route | new file |
|---|---|---|---|
| Warehouses | server.go:127 | `/warehouses` | warehouses.go |
| WarehouseStock | server.go:128 | `/warehouses/{id}/stock` | warehouses.go |
| SyncVersion | server.go:156 | `/sync/version` | sync.go |
| SyncPull | server.go:157 | `/sync/pull` | sync.go |
| GetInboundTransfers | server.go:162 | `/sync/inbound-transfers` | transfers.go |
| GetOutletTransfers | server.go:163 | `/sync/outlet-transfers` | transfers.go |
| GetProductOutletConfig | server.go:181 | `/products/{id}/outlet-config` | catalog.go |
| Tags | server.go:199 | `/tags` | customers.go |
| Segments | server.go:204 | `/segments` | customers.go |
| Interactions | server.go:213 | `/customers/{id}/interactions` | customers.go |
| PointTransactions | server.go:216 | `/customers/{id}/points` | customers.go |
| RewardGrants | server.go:217 | `/customers/{id}/reward-grants` | customers.go |
| InventoryOverview | server.go:250 | `/inventory/overview` | inventory.go |
| IngredientOverview | server.go:251 | `/inventory/ingredient-overview` | inventory.go |
| MovementSummary | server.go:252 | `/inventory/movement-summary` | inventory.go |
| Transfers | server.go:254 | `/transfers` | transfers.go |
| TransferLocationStock | server.go:255 | `/transfers/location-stock` | transfers.go |
| Transfer | server.go:256 | `/transfers/{id}` | transfers.go |
| Ingredients | server.go:265 | `/ingredients` | ingredients.go |
| IngredientUsage | server.go:270 | `/ingredients/{id}/usage` | ingredients.go |
| IngredientLocationStock | server.go:272 | `/inventory/ingredient-location-stock` | ingredients.go |
| IngredientCategories | server.go:275 | `/ingredient-categories` | ingredients.go |
| IngredientTransfers | server.go:279 | `/ingredient-transfers` | ingredient_transfers.go |
| IngredientTransfer | server.go:280 | `/ingredient-transfers/{id}` | ingredient_transfers.go |
| IngredientStockCounts | server.go:285 | `/ingredient-stock-counts` | ingredient_stock_counts.go |
| IngredientStockCount | server.go:286 | `/ingredient-stock-counts/{id}` | ingredient_stock_counts.go |
| RecipeVariantIDs | server.go:292 | `/products/{productId}/recipe-variant-ids` | recipes.go |
| VariantRecipe | server.go:293 | `/products/{productId}/variants/{variantId}/recipe` | recipes.go |
| RecipeVersions | server.go:295 | `/products/{productId}/variants/{variantId}/recipe/versions` | recipes.go |
| RecipeVersion | server.go:296 | `/products/{productId}/variants/{variantId}/recipe/versions/{versionId}` | recipes.go |

Notes:
- `customers.go` (181 lines) holds customer CRUD plus the CRM sub-resources: tags, segments, interactions, points, reward grants. This mirrors `read/customers.go`.
- `GetInboundTransfers`/`GetOutletTransfers` (POS sync-wall transfer reads) go to `transfers.go`, by feature.
- `discountRejectMessage` goes to `orders.go`; its only caller is `createOrder`.
- `previewClock` and `LoyaltyPreview` go to `loyalty.go`.
- `handlers/handlers.go` (504 lines of cached read GETs for the same features) is not a target here. Splitting it to match is a later pass.

### A.4 R3 service/order.go (1949 lines, 55 units) -> 8 files

| new file | lines at HEAD 3a2dde5 (doc start to decl end) | declarations moved (exact names; receivers dropped) | # |
|---|---|---|---|
| order.go | 24-160, 208-825, 1814-1823 | ErrNoItems,ErrNoOutlet,ErrOrderClosed, wib, outletZone, OrderItem, CreateOrderInput, pickSaleTime, withClockSkewWarning, pendingStockException, shortfallOf, OrderService, NewOrderService, CreateOrder, CreateOrderResult, CreateOrderSeq, createOrder, createOrderCore, idempotencyConstraints, isIdempotencyConflict, replayAfterConflict, nextOrderNumber | 20 |
| customer.go | 162-182, 1825-1904 | resolveMergedCustomer, CreateCustomerInput, CreateCustomer, CreateCustomerTx, recordDupCandidate | 5 |
| refund.go | 827-1067 | Refund, OrderOutlet, RefundTx | 3 |
| promo_resolve.go | 1069-1393 | combinabilityViolation, dedupeNonEmpty, combinedViolations, parseTieredConfig, parseBXGYConfig, parseBundleConfig, loadPromoSpec, resolvePromos | 8 |
| settings.go | 1395-1430 | appSettings, loadAppSettings, parsePaymentMethods | 3 |
| loyalty_load.go | 1432-1483 | rowQueryRower, loadLoyalty, rowQuerier, loadActiveConditions | 4 |
| rewards.go | 1485-1812 | rewardLineAllowed, rewardCatalog, loadRewardCatalog, resolveRewardLines, resolveBundleLines, rewardLineEntitled, variantKey | 7 |
| sqlnull.go | 1906-1949 | nullStr, nullUUID, nullNum, nullBytes, nullCodes | 5 |

Notes:
- **order.go** keeps the unmoved `createOrderCore` (246-794) and the helpers on its path that have no better home: `outletZone`/`wib` (also used by `loyalty_preview.go` and `promo_validate.go`), `pickSaleTime`, `shortfallOf`, idempotency replay and `nextOrderNumber`. It keeps the A42 note above `CreateOrder`.
  - order.go ends up at 813 lines, still over 800 because `createOrderCore` alone is about 550 lines and must not be edited.
  - The `ErrNoItems,ErrNoOutlet,ErrOrderClosed` var block stays whole in order.go, even though `ErrOrderClosed` is mostly a refund/shift error. A grouped block cannot be split without editing it.
- **customer.go:** `resolveMergedCustomer` is used by `resolvePromos` and `lockorder.go`.
- **settings.go:** `loadAppSettings` is also used by `shift.go`.
- **loyalty_load.go:** `rowQueryRower` is also used by `shift.go`, and `loadLoyalty`/`loadActiveConditions` by `loyalty_preview.go`.
- **rewards.go:** `variantKey` is also used by `pricing.go` and `loyalty_preview.go`. It sits with the reward code because it is contiguous there.
- **sqlnull.go:** `nullStr`/`nullUUID` are also used by `shift.go`.
- Stock guard (A.0): `order.go` stays a bumper (`BumpStockSeq` at :782, literals at :528 and :570, so {2,0}). `refund.go` becomes a bumper (literal at :1006, bump at :1063, so {1,0}).

### A.5 R5 sync/sync.go (806 lines, 32 units) -> 3 files (light split)

| new file | lines at HEAD 3a2dde5 (doc start to decl end) | declarations moved (exact names; receivers dropped) | # |
|---|---|---|---|
| sync.go | 25-107, 377-806 | Engine, saleResolver, resolveSaleTx, refundSaleID, New, processOne, refundFunc, receiptOutcome, keyed, replay, decodeEnvelope, processOneWithRefund, processOneWithCommands, processOneWithSeq, fillTransfer, approverAllowed, receiveScope, transferReceivePayload, orderPayload | 19 |
| pull.go | 109-246 | VersionInfo, Version, PullBundle, Pull | 4 |
| batch.go | 250-375 | BatchItem, ItemResult, BatchResult, Caller, ProcessBatch, closeHeldMessage, openHeldMessage, heldMessage, processBatch | 9 |

Notes:
- `sync.go` keeps the package doc, `Engine`/`New`, refund-sale resolution and the per-item command path, including the unmoved `processOneWithSeq` (467-737). It ends up at 537 lines.
- `pull.go` holds the content-version wall and the delta pull.
- `batch.go` holds the batch envelope types, `ProcessBatch`/`processBatch` and the held-shift messages.
- `approverAllowed`/`receiveScope` are referenced only from `transfer_receive_test.go` and sync.go. They stay in sync.go.
- No file collisions with `attribute.go`, `classify.go`, `contact.go` or `offlinecap.go`.

### A.6 Implementer rules carried from the dry run


1. **Moves only.** Each moved unit's bytes, from doc comment to closing brace, are copied verbatim. The only allowed edits are:
   - Recomputing the import block of each touched or new file. Seed it with the source file's full import block, then prune unused specs. Do NOT rely on `goimports` to *add* imports: `handlers` imports `syncpkg ".../internal/sync"`, and goimports cannot infer that alias. goimports is also not installed locally.
   - `gofmt`. CI gates on `test -z "$(gofmt -l .)"` (`.github/workflows/backend.yml:34`).
   - Dropping section banners (A.6 rule 6).
   - The A.0 guard-test map edit.
2. `createOrderCore` stays in `service/order.go`, unmoved.
3. `RefundTx` moves intact to `service/refund.go`. Its hash is identical in the dry run.
4. `processOneWithSeq` stays in `sync/sync.go`, unmoved.
5. **Existing `_test.go` files stay where they are.** They are in the same package and compile unchanged. Rename or split tests only later.
6. **Floating comments.** Comments that are not doc comments:
   - **Package docs stay:** `write/repo.go:1-2` and `sync/sync.go:1-3`. `read/repo.go`, `handlers/writes.go` and `service/order.go` have none.
   - **The A42 lock-order note (`service/order.go:184-206`) stays in order.go**, directly above `CreateOrder`. `write/stockseq.go:22` points readers to it.
   - **The `// ── shared helpers ──` banner (`write/repo.go:1126`) stays** with `delete`/`null*` in repo.go.
   - **Every other `// ── X ──` banner is dropped.** The filename now says the same thing. The dropped banners:
     - read: 92, 227, 586, 640, 826, 949, 969, 1795
     - write: 115, 445, 480, 521, 783, 816, 950, 996
     - handlers: 82, 278, 319, 406, 449, 518, 550, 590, 630, 660, 706, 776, 841, 930, 1371, 1394, 1475, 1593
     - sync: 248
7. **New file layout:** `package <pkg>` + pruned import block + the moved units in their original order.
8. **No file-name collisions.** Each package directory was listed. Decisions on existing same-feature files:
   - `read/reports.go` (ReportSummary only): **not appended**. Grant/code reports go to a new `promo_reports.go`.
   - `read/oversell.go`, `read/syncreview.go`, `write/transfer.go`, `handlers/ota.go`: nothing from the god files belongs there, so they are left untouched. OTA goes to new `read/ota.go` and `write/ota.go`, and these sit fine beside `handlers/ota.go`.
   - `write/loyalty.go` (conditions CRUD): **not appended**. `UpdateLoyaltySettings` goes to `write/settings.go` with `UpdateAppSettings`, mirroring the old "Settings (singletons)" section.
   - `handlers/users.go`: **not appended**. Custom roles go to a new `custom_roles.go`.
   - `service/payment_method.go`: **not appended**. `parsePaymentMethods` stays next to its only caller `loadAppSettings` in `settings.go`.
   - `service/loyalty.go` (pure engine, no DB): **not appended**. The DB loaders go to `loyalty_load.go`.
   - The `handlers/writes.go` name is **kept** for the shared write plumbing: `callerID`, `caller`, `decodeWrite`, `created`, `mutated`. These are also used by `merge.go`, `pos_devices.go`, `receive_approval.go`, `sync_review.go` and `users.go`.


## Appendix B: per-file move map (all 113 non-test, non-generated `.go` files under `backend/internal`)

Built from `find internal -name '*.go' ! -name '*_test.go' ! -name api.gen.go` at `3a2dde5` (113 files; `api.gen.go` is generated and regenerated, never moved). 5 split in place (R1–R5), 5 moved across packages (R7–R10), 3 optional insert-function moves (R11), 100 stay. Test files follow the rule in §1.2; the movers' tests are named in §1.4. New files created by step 1: `rules/doc.go`, `ledger/doc.go`, `archtest/arch_test.go`, `service/rules_compat.go`, `write/ledger_compat.go`, `integration/erp/doc.go` (WT-stub).

| current path | new path / action |
|---|---|
| `internal/apperr/apperr.go` | stays |
| `internal/auth/context.go` | stays |
| `internal/auth/handlers.go` | stays |
| `internal/auth/jwt.go` | stays |
| `internal/auth/password.go` | R9: `internal/rules/password.go` (+ 2 tests + testdata JSON; destination is owner decision D7); 13 qualifier edits |
| `internal/auth/permissions.go` | stays |
| `internal/auth/pinlockout.go` | R9: `internal/rules/pinlockout.go` (+ test); 8 qualifier edits in write/receive_approval.go |
| `internal/auth/reset.go` | stays |
| `internal/auth/sessions.go` | stays |
| `internal/auth/store.go` | stays |
| `internal/bizday/bizday.go` | stays |
| `internal/cache/cache.go` | stays |
| `internal/cache/memcounter.go` | stays |
| `internal/clientip/clientip.go` | stays |
| `internal/codegen/guard.go` | stays |
| `internal/config/config.go` | stays |
| `internal/csvimport/customers.go` | stays |
| `internal/csvimport/ingredients.go` | stays |
| `internal/csvimport/products.go` | stays |
| `internal/csvimport/reader.go` | stays |
| `internal/csvimport/report.go` | stays |
| `internal/csvimport/values.go` | stays |
| `internal/db/db.go` | stays |
| `internal/fsmigrate/fsmigrate.go` | stays |
| `internal/fsmigrate/tables.go` | stays |
| `internal/handlers/batch_envelope.go` | stays |
| `internal/handlers/customerlookup.go` | stays |
| `internal/handlers/customerscope.go` | stays |
| `internal/handlers/handlers.go` | stays |
| `internal/handlers/imports.go` | stays |
| `internal/handlers/merge.go` | stays |
| `internal/handlers/order_filter.go` | stays |
| `internal/handlers/ota.go` | stays |
| `internal/handlers/oversell.go` | stays |
| `internal/handlers/pos_devices.go` | stays |
| `internal/handlers/receive_approval.go` | stays |
| `internal/handlers/reminders.go` | stays |
| `internal/handlers/shift_receipt.go` | stays |
| `internal/handlers/sync_review.go` | stays |
| `internal/handlers/sync_review_input.go` | stays |
| `internal/handlers/users.go` | stays |
| `internal/handlers/writes.go` | R4: split in place into 21 files in `internal/handlers/` (writes.go keeps callerID/caller/decodeWrite/created/mutated), table A.3 |
| `internal/httpx/httpx.go` | stays |
| `internal/middleware/clientip.go` | stays |
| `internal/middleware/logging.go` | stays |
| `internal/middleware/middleware.go` | stays |
| `internal/middleware/ratelimit.go` | stays |
| `internal/observability/observability.go` | stays |
| `internal/ota/decide.go` | stays |
| `internal/phone/phone.go` | stays |
| `internal/promotionkeys/diagnostic.go` | stays |
| `internal/promotionkeys/keys.go` | stays |
| `internal/promotionpreflight/scan.go` | stays |
| `internal/read/dupcandidates.go` | stays |
| `internal/read/orderfilter.go` | stays |
| `internal/read/oversell.go` | stays |
| `internal/read/reminders.go` | stays |
| `internal/read/repo.go` | R1: split in place into 21 files in `internal/read/` (repo.go keeps Repo/New/Scope/helpers), table A.1 |
| `internal/read/reports.go` | stays |
| `internal/read/syncreview.go` | stays |
| `internal/redact/redact.go` | stays |
| `internal/server/server.go` | stays |
| `internal/service/lockorder.go` | stays |
| `internal/service/loyalty.go` | R8: `internal/rules/loyalty.go`; 5 type + 3 var aliases in `service/rules_compat.go` (loyalty_test.go stays in service) |
| `internal/service/loyalty_preview.go` | stays |
| `internal/service/order.go` | R3: split in place into 8 files in `internal/service/`; createOrderCore stays in order.go unmoved, RefundTx moves intact to refund.go, table A.4 |
| `internal/service/order_input.go` | stays |
| `internal/service/payment_method.go` | R7: `internal/rules/payment_method.go` (+ test); `var IsCashMethod = rules.IsCashMethod` shim in `service/rules_compat.go` |
| `internal/service/pricing.go` | stays |
| `internal/service/promo_validate.go` | stays |
| `internal/service/quote.go` | stays |
| `internal/service/receipts.go` | stays |
| `internal/service/refund_input.go` | stays |
| `internal/service/shift.go` | stays |
| `internal/service/shift_input.go` | stays |
| `internal/service/tender.go` | stays |
| `internal/sync/attribute.go` | stays |
| `internal/sync/classify.go` | stays |
| `internal/sync/contact.go` | stays |
| `internal/sync/offlinecap.go` | stays |
| `internal/sync/sync.go` | R5: split in place into sync.go/pull.go/batch.go; processOneWithSeq stays in sync.go unmoved, table A.5 |
| `internal/uploads/sign.go` | stays |
| `internal/write/device.go` | stays |
| `internal/write/doc_sequences.go` | stays |
| `internal/write/errorlog.go` | stays |
| `internal/write/import.go` | stays |
| `internal/write/import_customers.go` | stays |
| `internal/write/import_ingredients.go` | stays |
| `internal/write/import_products.go` | stays |
| `internal/write/ingredient.go` | stays |
| `internal/write/ingredient_stock_logic.go` | stays |
| `internal/write/ingredient_stockcount.go` | stays |
| `internal/write/ingredient_transfer.go` | stays |
| `internal/write/interaction.go` | stays |
| `internal/write/loyalty.go` | stays; R11 (optional): tx-scoped insert funcs move to `internal/ledger/` behind aliases, Repo methods stay |
| `internal/write/merge.go` | stays |
| `internal/write/points.go` | stays; R11 (optional): tx-scoped insert funcs move to `internal/ledger/` behind aliases, Repo methods stay |
| `internal/write/points_math.go` | stays |
| `internal/write/receive_approval.go` | stays |
| `internal/write/receive_fingerprint.go` | stays |
| `internal/write/recipe.go` | stays |
| `internal/write/repo.go` | R2: split in place into 8 files in `internal/write/` (repo.go keeps Repo/tx/bumpVersion/null*; stock writers to catalog.go), table A.2 |
| `internal/write/segment.go` | stays |
| `internal/write/stock_exception.go` | stays; R11 (optional): tx-scoped insert funcs move to `internal/ledger/` behind aliases, Repo methods stay |
| `internal/write/stock_logic.go` | stays |
| `internal/write/stockcount.go` | stays |
| `internal/write/stockseq.go` | R10: `internal/ledger/stockseq.go`; `var BumpStockSeq = ledger.BumpStockSeq` in `write/ledger_compat.go` |
| `internal/write/syncreview.go` | stays |
| `internal/write/tag.go` | stays |
| `internal/write/transfer.go` | stays |
| `internal/write/transfer_logic.go` | stays |
| `internal/write/tx_busy.go` | stays |
| `internal/write/warehouse.go` | stays |

## Appendix C: import-direction test prototype (`internal/archtest/arch_test.go`; passes at `3a2dde5`, fails on an injected `read -> write`)

```go
// Package archtest enforces the backend import direction (ERP review §9).
// Production imports only (test files may cross layers). Stdlib only: go/build
// honours build constraints and needs no subprocess or new module dependency.
package archtest

import (
	"go/build"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const mod = "github.com/mandalika/pos-backend/internal/"

type tier int

const (
	leaf      tier = iota // pure: stdlib + non-pgx third party + other leaves
	infra                 // db, ledger, cache, config, observability
	platform              // auth, middleware
	domain                // read, write, service
	adapter               // integration/erp
	transport             // handlers, sync
	root                  // server (composition root)
	tool                  // offline tools; may not reach domain/transport/root
)

var tiers = map[string]tier{
	"api": leaf, "apperr": leaf, "bizday": leaf, "phone": leaf, "promotionkeys": leaf,
	"redact": leaf, "ota": leaf, "csvimport": leaf, "uploads": leaf, "httpx": leaf,
	"clientip": leaf, "rules": leaf,
	"db": infra, "ledger": infra, "cache": infra, "config": infra, "observability": infra,
	"auth": platform, "middleware": platform,
	"read": domain, "write": domain, "service": domain,
	"integration/erp": adapter,
	"handlers":        transport, "sync": transport,
	"server":  root,
	"codegen": tool, "fsmigrate": tool, "promotionpreflight": tool,
}

// allowed internal targets per package (beyond leaves, which everyone may import).
var allowed = map[string][]string{
	"db":              {},
	"ledger":          {"db"},
	"read":            {"db", "ledger"},
	"write":           {"db", "ledger"},
	"service":         {"db", "ledger"},
	"integration/erp": {"db", "ledger"},
	"sync":            {"db", "ledger", "read", "write", "service", "integration/erp", "auth", "cache"},
	"handlers":        {"db", "ledger", "read", "write", "service", "sync", "integration/erp", "auth", "cache", "config", "middleware"},
}

// strict packages may import only leaves plus their allowed list.
var strict = map[string]bool{"db": true, "ledger": true}

const (
	pgx     = "github.com/jackc/pgx/v5"
	pgxpool = "github.com/jackc/pgx/v5/pgxpool"
	pgconn  = "github.com/jackc/pgx/v5/pgconn"
)

// knownViolations is the ratchet: edges that exist at HEAD 3a2dde5. A fix must
// delete its line (the test fails if a listed edge no longer exists).
var knownViolations = map[string]string{
	"read -> service":       "read/repo.go:1085 service.IsCashMethod",
	"service -> write":      "write.Insert*/BumpStockSeq/ErrBusy/RewardGrantRow in createOrderCore/RefundTx",
	"write -> auth":         "write/receive_approval.go HashPassword/VerifyPassword + PIN lockout",
	"handlers -> " + pgconn: "handlers/writes.go:1126 refundHTTPError",
	"sync -> " + pgx:        "pgx.Tx in sync.go:55,383,394 + attribute.go poolLookup",
	"sync -> " + pgxpool:    "sync.go:26,105 Engine.Pool",
	"sync -> " + pgconn:     "classify.go:45,54,80",
}

func isPgx(p string) bool { return p == pgx || strings.HasPrefix(p, pgx+"/") }

func violations(pkg string, imports []string) []string {
	t, ok := tiers[pkg]
	if !ok {
		return []string{pkg + " -> ? (unclassified package: add it to tiers)"}
	}
	var bad []string
	ok2 := map[string]bool{}
	for _, a := range allowed[pkg] {
		ok2[a] = true
	}
	for _, imp := range imports {
		if strings.HasPrefix(imp, mod) {
			dep := strings.TrimPrefix(imp, mod)
			dt, known := tiers[dep]
			switch {
			case !known:
				bad = append(bad, pkg+" -> "+dep)
			case t == root, dt == leaf && dep != pkg, ok2[dep]:
			case t == tool && dt < domain:
			case (t == infra || t == platform) && dt <= platform && !strict[pkg]:
			default:
				bad = append(bad, pkg+" -> "+dep)
			}
			continue
		}
		if !isPgx(imp) {
			continue
		}
		switch {
		case t == leaf:
			bad = append(bad, pkg+" -> "+imp)
		case t == transport && (imp == pgconn || pkg == "sync"):
			bad = append(bad, pkg+" -> "+imp)
		}
	}
	return bad
}

func TestImportDirection(t *testing.T) {
	seen := map[string]bool{}
	err := filepath.WalkDir("..", func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() || d.Name() == "testdata" {
			return err
		}
		bp, err := build.ImportDir(p, 0)
		if err != nil || len(bp.GoFiles) == 0 {
			return nil // no production Go files (archtest, dependencycheck, migrations)
		}
		rel, _ := filepath.Rel("..", p)
		for _, v := range violations(filepath.ToSlash(rel), bp.Imports) {
			seen[v] = true
			if _, known := knownViolations[v]; !known {
				t.Errorf("forbidden import: %s", v)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var stale []string
	for k := range knownViolations {
		if !seen[k] {
			stale = append(stale, k)
		}
	}
	sort.Strings(stale)
	for _, k := range stale {
		t.Errorf("knownViolations entry %q no longer occurs: delete it (ratchet)", k)
	}
}
```

When `internal/integration/erp/erpapi` lands (step 4) add `"integration/erp/erpapi": leaf` to `tiers`; R7 and R9 delete their `knownViolations` lines (ratchet).
