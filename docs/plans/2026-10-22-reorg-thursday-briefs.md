# Thursday 22 Oct briefs: reorg R1–R12

These are the session briefs for the reorg, one per worktree or commit group. They are ready to paste.

Plan: `docs/plans/2026-10-22-reorg-and-erp-demo-plan.md` (cited below as "plan").
Tools: `docs/plans/2026-10-22-reorg-tools.md`.

## Decisions these briefs rely on

- **Decided 2026-10-21:** D1 scope, D2 Option A + ledger allowlist entries, D3 naming/placement/tools-outside-repo,
  and D10.
- **Also decided 2026-10-21** (the recommended option, under the owner's standing instruction for routine
  technical choices):

| Decision | Used by | Answer |
|---|---|---|
| D4 | Brief 3 | **No** qualifier edits inside frozen bodies; alias shims instead; `service -> write` stays allow-listed until after the demo |
| D5 | Brief 2 | `ota` and `csvimport` are pure leaves; the allow-list has exactly 7 edges |
| D7 | Brief 3, R9 | Password hashing goes to `internal/rules/` |
| D9 | Brief 3, R8 reviewer; R13 | golangci-lint is advisory and lands last; Haiku review is enough for alias-only R8 |

D6 and D8 do not block Thursday.

## Common preamble (paste into every brief)

**Repository and base**
- Repo: `C:\Users\MyBook Hype AMD\Downloads\mandalika-pos`.
- Start from the post-history-purge `origin/prod-hardening` head. SHAs differ from the plan's `3a2dde5`.
- Before starting, prove that the backend tree the plan was derived from is unchanged:
  `git rev-parse HEAD:backend/internal` must print `a41130a2e0af819a97c4b32db73d8ed7f9e7851b`. This is the same
  value at `3a2dde5` and at `c888d3f`.
  - If it differs, STOP. All line ranges below assume this tree.
- Every line number below is at that tree.

**Rules**
- AGENTS.md working rules apply.
- No push, deploy, APK, OTA or Neon access.
- Commit on your own branch only, and only when the commit's gate is green.
- **Moves only** (plan §1.2):
  - Same-package: whole top-level declarations copied verbatim, doc comment through closing brace.
  - Cross-package: `git mv` + package clause + qualifier edits at **non-frozen** sites + alias shims.
  - **Never edit** `createOrderCore` (`service/order.go:249-794`), `RefundTx` (`:858-1066`) or `processOneWithSeq`
    (`sync/sync.go:467-737`). Their declaration hashes must be identical before and after every commit.
- Allowed edits beyond moves:
  - recompute each touched file's import block (seed from the source file's block, then prune; `goimports` is not
    installed and cannot infer the `syncpkg` alias);
  - `gofmt`;
  - drop the `// ── X ──` banners listed in plan A.6 rule 6;
  - the guard-test hunks given below.
- Tools (`declhash`, `splitter`, decl lister) are built **outside the repo** in a scratch directory with
  `go.mod` = `module <name>` / `go 1.26`. Source: the tools doc. Never commit them (D3).

**Gate after every commit** (run from `backend/`):

```
test -z "$(gofmt -l .)" && go build ./... && go vet ./... && go test ./...
```

Use `./...`, not one package: the stock guard in `write` scans every package.

**On failure:** stop, report the failing output verbatim, and do not "fix" a test.

**Caveat:** the R1–R5 dry run and the R7–R10 prototype ran **independently** on pristine copies. The combined
R1 → R11 sequence has not been executed. Expect only import-block differences. Anything else is a stop-and-report.

**Therefore Brief 1 must finish with the FULL verification on the R5 tip before Brief 2 (R6) starts:**
- the common gate;
- `declhash` for all five packages against the pre-R1 parent;
- `make gen-check` and `codegen_gate.py`;
- the reorg Postgres gates;
- `corepack pnpm quality:ci`.

Brief 3 then re-runs the full common gate after every commit (plan §6.4).

---

## Brief 1: WT-main, R1–R5, intra-package splits (Sonnet implements, Opus reviews each commit)

**Goal.** Split the five god files by feature inside their own packages. One commit per file, in this order:

| Commit | Message | Source | Target files |
|---|---|---|---|
| R1 | `refactor(read): split read/repo.go by feature (moves only)` | `internal/read/repo.go` | 21 |
| R2 | `refactor(write): split write/repo.go by feature (moves only)` | `internal/write/repo.go` | 8 |
| R3 | `refactor(service): split service/order.go (moves only)` | `internal/service/order.go` | 8; `createOrderCore` stays in order.go; `RefundTx` → refund.go intact |
| R4 | `refactor(handlers): split handlers/writes.go by feature (moves only)` | `internal/handlers/writes.go` | 21 |
| R5 | `refactor(sync): split sync/sync.go into pull/batch (moves only)` | `internal/sync/sync.go` | 3; `processOneWithSeq` stays in sync.go |

**Exact move lists.**
- The declaration-to-file tables are plan Appendix A.1–A.5: 377 declarations, each assigned exactly once.
- Mechanically, use the range maps below with the splitter. A declaration goes to the range that contains its
  doc-comment start line.
- Procedure per file:
  1. Run the decl lister on the source and write `file.decls`.
  2. Use the awk converter (tools doc, Appendix A header) with the `.map` to produce `.assigned`.
     - Any `BAD` line on stderr → stop.
  3. Run the splitter on `<src.go>` and `<assigned.tsv>` from `internal/`. It refuses to overwrite existing files.
  4. Prune the imports.

**Range maps** (copied from the verified dry run):

```
read.map
20-90 repo.go
91-218 catalog.go
219-225 outlets.go
226-250 warehouses.go
251-347 ingredients.go
348-458 recipes.go
459-584 ingredient_transfers.go
585-638 ingredient_stock_counts.go
639-824 customers.go
825-884 promotions.go
885-904 loyalty.go
905-922 settings.go
923-967 users.go
968-1019 orders.go
1020-1129 shifts.go
1130-1167 error_logs.go
1168-1206 stock_counts.go
1207-1315 transfers.go
1316-1335 inventory.go
1336-1357 shifts.go
1358-1374 settings.go
1375-1793 inventory.go
1794-1972 promo_reports.go
1973-1991 ota.go

write.map
25-82 repo.go
83-106 catalog.go
107-113 repo.go
114-478 catalog.go
479-519 customer.go
520-781 promotion.go
782-948 discount_code.go
949-994 outlet.go
995-1124 settings.go
1125-1136 repo.go
1137-1155 catalog.go
1156-1176 repo.go
1177-1186 ota.go

service.map
24-160 order.go
161-182 customer.go
183-825 order.go
826-1067 refund.go
1068-1393 promo_resolve.go
1394-1430 settings.go
1431-1483 loyalty_load.go
1484-1812 rewards.go
1813-1823 order.go
1824-1904 customer.go
1905-1949 sqlnull.go

handlers.map
24-80 writes.go
81-141 catalog.go
142-162 customers.go
163-232 promotions.go
233-253 loyalty.go
254-276 outlets.go
277-317 warehouses.go
318-404 transfers.go
405-548 ingredients.go
549-704 customers.go
705-774 ingredient_transfers.go
775-839 ingredient_stock_counts.go
840-910 recipes.go
911-928 settings.go
929-1043 orders.go
1044-1101 loyalty.go
1102-1193 orders.go
1194-1246 shifts.go
1247-1340 error_logs.go
1341-1369 shifts.go
1370-1392 custom_roles.go
1393-1473 stock_counts.go
1474-1545 sync.go
1546-1578 transfers.go
1579-1591 uploads.go
1592-1678 inventory.go
1679-1720 orders.go

sync.map
25-107 sync.go
108-246 pull.go
247-375 batch.go
376-806 sync.go
```

**Floating comments that must stay put** (plan A.6 rule 6):
- the package docs: `write/repo.go:1-2`, `sync/sync.go:1-3`;
- the A42 lock-order note `service/order.go:184-206`, directly above `CreateOrder`;
- the `// ── shared helpers ──` banner at `write/repo.go:1126`.

Every other banner listed in A.6 rule 6 is dropped.

**Placement constraint:** `txStock` must land in `write/catalog.go` together with the product stock writers (plan
A.0).

**Guard-test hunks** (D2 decided, Option A). Edit `internal/write/stockseq_guard_test.go` map keys and pins only.
Put each package's part in **that package's commit**:

| Commit | Hunk |
|---|---|
| R1 | allowlist `-"internal/read/repo.go": false` → `+"internal/read/catalog.go": false`, `+"internal/read/inventory.go": false` |
| R2 | allowlist `-"internal/write/repo.go": true` → `+"internal/write/catalog.go": true`; pins `-"internal/write/repo.go": {5, 0}` → `+"internal/write/catalog.go": {5, 0}` |
| R3 | allowlist `+"internal/service/refund.go": true`; pins `"internal/service/order.go": {3, 0}` → `{2, 0}` (comment "lazy row, decrement") plus `+"internal/service/refund.go": {1, 0}` (comment "refund restock") |
| R4, R5 | none |

Invariant: per package, the literal and dynamic stock-write totals are unchanged (service 3+0, write 5+0, read 0+0).

**Verification per commit** (P = parent, C = commit, pkg ∈ read | write | service | handlers | sync):
1. Run the common gate.
2. Run these against the commit:

   ```
   git diff --stat -M P C
   git diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change P C -- backend/internal/<pkg>
   ```

   Only import blocks, dropped banners and the guard hunk may show as non-moved.
3. Run `declhash` on `git archive` extracts of P and C for `backend/internal/<pkg>`, then `diff`.
   - Allowed: only `C` lines for the dropped banners.
   - **Any `D` line = a body changed = reject.**
   - Check explicitly that the `createOrderCore`, `RefundTx` and `processOneWithSeq` hashes are present and
     unchanged.
4. After R5:
   - `make gen-check` and `python3 ../scripts/ci/codegen_gate.py`;
   - the Postgres gates via `python3 scripts/ci/postgres_gate.py` from the repo root (Docker), at least ST, TR, SC,
     RF, OS, LO, S0C, OR, RA, AU, IM, BE and EV;
   - `corepack pnpm quality:ci`.

**Expected sizes after the split** (sanity check): `service/order.go` about 813 lines, `sync/sync.go` about 537,
`write/repo.go` about 112.

**Follow-up, separate commit, comment only:** `service/order.go:203` names `write/repo.go`; it becomes
`write/catalog.go`.

**Rollback:** `git revert` the commit. Each commit is self-contained and green.

**Report:** one line per commit, giving the SHA, gate result, declhash result and the number of files.

---

## Brief 2: WT-main, R6, import-direction test (Haiku implements, Haiku reviews; runs right after R5)

**Goal.** Add `backend/internal/archtest/arch_test.go`. The source is verbatim in plan Appendix C.
- Stdlib `go/build`.
- Production imports only.
- Unclassified package = fail.
- Ratchet: a stale allow-list entry = fail.

**Allow-list (D5 = leaves), exactly 7 entries:**
- `read -> service`
- `service -> write`
- `write -> auth`
- `handlers -> pgconn`
- `sync -> pgx`
- `sync -> pgxpool`
- `sync -> pgconn`

**Verification:**
1. `go test ./internal/archtest/ -v` passes.
2. **Negative check:** add `_ "github.com/mandalika/pos-backend/internal/write"` to any read file → the test fails
   with `forbidden import: read -> write` → revert the injection. Do not commit it.
3. **Cross-check against `go list` (plan §1.6):** run
   `go list -f '{{.ImportPath}} {{join .Imports " "}}' ./internal/...`. Every internal edge and every pgx edge
   must match what the test walked (add a temporary `t.Log` dump, then remove it before committing).
4. Run the common gate.

**Commit:** `test(archtest): enforce backend import direction with today's allow-list`.

**Rollback:** delete the file.

---

## Brief 3: WT-main, R7–R11, cross-package moves (Sonnet implements; Opus reviews R7, R9, R10, R11; Haiku reviews R8)

**Precondition:** Brief 1 (R1–R5) is merged on the branch and its full tip verification passed (see the next
paragraph); R6 is committed. D4, D5, D7 and D9 are decided as listed at the top.

Order: R7 → R8 → R9 → R10 → (R11 optional, cut line 3). After R9, two allow-list lines are gone and 5 remain.

### R7: `refactor(rules): new rules leaf; IsCashMethod moves (removes read->service)`

1. Add `internal/rules/doc.go`, containing only the package clause and a doc comment: "Package rules holds pure
   business rules (no pgx)."
2. `git mv internal/service/payment_method.go internal/rules/payment_method.go` and
   `git mv internal/service/payment_method_test.go internal/rules/payment_method_test.go`. Change `package service`
   to `package rules` in both.
3. New `internal/service/rules_compat.go`:

   ```go
   package service

   import "github.com/mandalika/pos-backend/internal/rules"

   // IsCashMethod is a compatibility alias; the rule lives in internal/rules.
   var IsCashMethod = rules.IsCashMethod
   ```

   - The frozen caller (`createOrderCore`, HEAD `order.go:462`) keeps `IsCashMethod` unqualified.
   - `shift.go:237` is unqualified as well and keeps working through the alias.
4. Qualifier edit, in the file that holds HEAD `read/repo.go:1085` after R1 (`read/shifts.go`):
   - change `service.IsCashMethod` to `rules.IsCashMethod`;
   - swap the `service` import for `rules`;
   - update the comment at HEAD `:1030` the same way.
5. In `archtest`, delete the `"read -> service"` line.
6. Verify:
   - the common gate;
   - `go test ./internal/rules/ ./internal/service/ ./internal/read/ ./internal/archtest/`;
   - `git diff -M --word-diff`: only package clauses, imports, the one qualifier and the comment;
   - `declhash` on service: frozen hashes unchanged.

### R8: `refactor(rules): loyalty engine moves behind aliases`

1. `git mv internal/service/loyalty.go internal/rules/loyalty.go` and set `package rules`.
   - **`loyalty_test.go` stays in service.** It uses `wib` and `fptr`, and runs through the aliases.
2. Append to `service/rules_compat.go`:

   ```go
   // Loyalty engine aliases (implementation in internal/rules/loyalty.go).
   type (
   	LoyaltyCondition = rules.LoyaltyCondition
   	EvalCustomer     = rules.EvalCustomer
   	EvalContext      = rules.EvalContext
   	AppliedCondition = rules.AppliedCondition
   	LoyaltyOutcome   = rules.LoyaltyOutcome
   )

   var (
   	EvaluateLoyalty   = rules.EvaluateLoyalty
   	LoyaltyEarnReason = rules.LoyaltyEarnReason
   	ProductRewards    = rules.ProductRewards
   )
   ```

   This makes zero call-site edits. The frozen users at `order.go:425, 482, 498, 684, 703` stay byte-identical.
3. Verify: the common gate; `go test ./internal/rules/ ./internal/service/` (includes `loyalty_test`,
   `promo_timezone_test`); `declhash` frozen hashes unchanged.

### R9: `refactor(rules): PIN lockout and password hashing move (removes write->auth)`

Can be split into R9a (pinlockout; the edge stays) and R9b (password; the edge goes).

1. `git mv` into `internal/rules/` (D7 = rules):
   - `internal/auth/pinlockout.go`, `pinlockout_test.go`
   - `internal/auth/password.go`, `password_compatibility_test.go`, `password_validate_test.go`
   - `internal/auth/testdata/argon2id-v0.46.0.json` → `internal/rules/testdata/`. It is `go:embed`ed by
     `password_compatibility_test.go:17`.
   - Change the package clause to `rules`.
2. Qualifier edits, `auth.` → `rules.` (13 password sites + 8 lockout sites, all non-frozen):

   | File | Lines | Edit |
   |---|---|---|
   | `write/receive_approval.go` | 94, 118, 250, 254, 278, 283, 322, 327 | Lockout |
   | `write/receive_approval.go` | 88, 270 | Hash/Verify; drop the `auth` import |
   | `auth/store.go` | 106, 176, 247 | Unqualified → `rules.`; auth gains a `rules` import (platform → leaf is allowed) |
   | `auth/reset.go` | 70, 87 | Same |
   | `auth/reset_test.go` | 151 | Same |
   | `handlers/auth_authority_integration_test.go` | 89, 713 | Same |
   | `handlers/capture_envelope_integration_test.go` | 101 | Same |
   | `handlers/operation_receipts_integration_test.go` | 449 | Same |
   | `handlers/receive_approval_integration_test.go` | 61 | Same |

   The comment at `fsmigrate.go:35` mentions `auth.VerifyPassword` and may stay (comment only).
3. In `archtest`, delete `"write -> auth"`.
4. Verify:
   - the common gate;
   - `go test ./internal/rules/ ./internal/auth/ ./internal/write/` and `go vet ./internal/handlers/` (compiles the
     integration tests);
   - Postgres gates RA 56466 and AU 56455;
   - `git diff -M --word-diff`: only qualifiers, packages and imports.

### R10: `refactor(ledger): ledger skeleton; BumpStockSeq moves behind a var alias`

1. Add `internal/ledger/doc.go`: "Package ledger is the single door for tx-scoped stock mutation records (plan §2)."
2. `git mv internal/write/stockseq.go internal/ledger/stockseq.go` and set `package ledger`. It is self-contained
   (pgx only).
3. New `internal/write/ledger_compat.go`:

   ```go
   package write

   import "github.com/mandalika/pos-backend/internal/ledger"

   // BumpStockSeq is a compatibility alias (a var, so stockseq_guard_test does not
   // count it as a call); the implementation lives in internal/ledger.
   var BumpStockSeq = ledger.BumpStockSeq
   ```

   **It must be a `var`, never a wrapper func** (the guard counts calls by name).

   Callers stay unchanged:
   - frozen `order.go:782` and `refund.go` (ex-`order.go:1063`);
   - `catalog.go` (ex-`repo.go:101`);
   - `stockcount.go:457`;
   - `transfer.go:307, 436, 486`;
   - `warehouse.go:126`.
4. `stockseq_guard_test.go` stays in write; it walks all of internal/ by callee name.
5. Verify:
   - the common gate;
   - `go test ./internal/write/ -run StockSeq -v` (7 tests);
   - Postgres gate ST 56458;
   - `declhash` frozen hashes unchanged.

### R11 (optional, cut line 3): `refactor(ledger): tx-scoped insert helpers move behind aliases`

**Moves** to `internal/ledger/`, whole functions and types only, with aliases appended to
`write/ledger_compat.go` (types `=`, funcs `var`, consts `const`). The Repo methods stay in write:

| From | Symbols |
|---|---|
| `write/points.go` | `InsertPointTx`, `PointTxRow` |
| `write/stock_exception.go` | the `StockException*` consts, `SaleStockExceptionRow`, `nullUUIDArg`, `InsertSaleStockException`, `InsertRefundUnresolvedVariant` |
| `write/loyalty.go` | `ConditionApplicationRow`, `InsertConditionApplication`, `RewardGrantRow`, `InsertRewardGrant` |

**Stop and skip R11 if:**
- any moved function references an unexported write symbol other than `nullUUIDArg` (which moves with it);
- any white-box test breaks.

**Verify:**
- the common gate;
- Postgres gates S0C 56439, RF 56449, OS 56457, LO 56454, PL 56460;
- `declhash`.

The `service -> write` allow-list line **stays** until D4.

### End of Brief 3

**Full verification on the tip:**
- the common gate;
- `go test ./internal/archtest/`;
- `make gen-check`;
- `python3 ../scripts/ci/codegen_gate.py`;
- all 28 Postgres gates (`scripts/ci/postgres_gate.py`);
- `corepack pnpm quality:ci`;
- `corepack pnpm browser:ci`.

**15:00 Fri 23 cut-line check:** if R7–R11 are not all green and reviewed, drop them and ship R1–R6 only.

**Rollback:** `git revert` in reverse order. There is no migration and no API change.

---

## Brief 4: WT-stub, R12 + ERP client spike + `cmd/erpstub` (Sonnet implements, Opus reviews the stub's idempotency logic; Thu 22 – Fri 23)

**Owns only new files:**
- `backend/internal/integration/erp/doc.go` (R12)
- `backend/internal/integration/erp/erpapi/**`
- `backend/api/erp/**`
- `backend/cmd/erpstub/**`
- `docs/integration/stock-documents.v1.yaml`

**Touches no existing file.** The exception is the Makefile `gen-erp` target, which is deferred to step 4 unless
trivial.

1. **R12** `chore(erp): integration/erp package skeleton`: `doc.go` only.
   - **If R6 has already landed on the branch you rebase onto, add the `"integration/erp"` tier.** It already exists
     in Appendix C (`adapter`).
2. **Spec snapshot:** copy `C:\Users\MyBook Hype AMD\Downloads\erp-flamboyan\docs\integration\openapi.v1.json`
   (ERP `main` @ `1c1d08f5`) to `backend/api/erp/openapi.v1.json`, plus `backend/api/erp/SOURCE.md` recording the
   ERP sha and the date.
3. **Codegen spike** (plan §4.3):
   - Config `internal/integration/erp/erpapi/oapi-codegen.yaml` with `package: erpapi`,
     `generate: {models: true, client: true}` and `output: erp.gen.go`.
   - Run with the pinned tool: `go tool oapi-codegen -config ... ../../../../api/erp/openapi.v1.json`.
   - Option (a): it succeeds and `go build ./...` is green → keep it.
   - Option (b): it fails on 3.1 constructs → write `backend/api/erp/openapi.v1.as30.json`, a mechanical
     down-conversion (`type: [x, "null"]` → `type: x, nullable: true`; nothing else), and generate from that.
   - **Do not change go.mod.** If neither works, report back; option (c), the v2.8.0 bump, needs the owner.
   - Add `"integration/erp/erpapi": leaf` to the archtest tiers once R6 exists.
4. **`cmd/erpstub`** (plan §5.4):
   - stdlib `net/http`, `erpapi` models for the catalog JSON shapes;
   - **GET endpoints:** catalog FG/outlets with the watermark semantics (`server_time` on every page,
     `updated_since`, opaque `cursor`, `take` 1–500, `deleted_at` tombstones), and `GET /outlets/{code}/stock`;
   - **`POST /api/integration/v1/stock-documents`** per handoff §4.3:
     - Bearer key;
     - `Idempotency-Key` must equal `document_id`;
     - same body → 200 `replayed`; different body hash → 409 `IDEMPOTENCY_CONFLICT`;
     - unknown `fg_code` or slug → 422, nothing written;
     - per-line `movement_id` uniqueness;
     - a live balance per (fg, location);
     - a document of more than 200 lines → 422;
   - **Hooks:** `GET /_stub/documents`, `GET /_stub/balances`, `POST /_stub/fg`, `POST /_stub/fault?status=503&count=N`;
   - **Persistence:** `-state file.json` optional;
   - **Tests:** `cmd/erpstub/main_test.go` with the handoff §10 example documents as fixtures, plus replay, conflict,
     422, fault and paging cases.
5. **`docs/integration/stock-documents.v1.yaml`:** an OpenAPI 3.0 description of handoff §4.3, including `part`
   for documents split at 200 lines. This is the file offered to the ERP developer.

**Verification:**
- `cd backend && go build ./... && go vet ./... && go test ./cmd/erpstub/ ./internal/integration/...`;
- the common gate;
- `go test ./internal/archtest/` if R6 is present.

**Rollback:** delete the new directories.

**Report:**
- which codegen option worked;
- the stub's test list;
- any contract ambiguity found in handoff §4.3, to raise with the ERP developer.

---

## Merge order (owner go-ahead each)

1. WT-stub (new files only) can merge first, any time.
2. WT-main R1–R6 next, then R7–R11 after the Fri 15:00 check. Rebase WT-stub's archtest tier lines if R6 landed
   after them.
3. R13 golangci and `gen-erp-check` follow after the reorg merge. The dependency-security precondition is already
   met (`ab994a3`).
