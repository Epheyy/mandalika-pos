# Pre-re-audit status (verified 2026-10-20, Opus read-only review + main-session spot checks)

Supersedes the Totals line of `2026-10-14-audit-status-sweep.md` and the September statuses in `docs/AUDIT_COVERAGE_TRACKER.md` (both stale). Derived from HANDOFF, git log, plan docs and source; no tests were run by the reviewer. SHAs older than 2026-10-17 are invalid (history rewritten).

Release state: release 8 (backend `00118-gup`, migrations through 0063, OTA 2.1.3, backoffice) is live and contains every slice through A08/A41/A30/A05/A27 T7. Release 9 (2026-10-20, live: backoffice + OTA 2.1.4) shipped: pagefix (backoffice list/export fix, `03726cf`) and autopull (POS auto-pull of reference data, `b06846e`; OTA only).

## All 44 findings
| ID | Title | Status | Left |
|---|---|---|---|
| A01 | Local capture durable | Done-live (slice 9) | kill during first migration unit-tested only; `quarantineCorruptRows` exported but uncalled |
| A02 | Transport failures park/delete | Done-live | – |
| A03 | Receive errors = competing receipt | Done-live | not run on a device before 2026-10-20; receive now device-confirmed (TRF-00010) |
| A04 | Events bound to actor/outlet | Done-live | legacy-envelope cutoff unset (go-live step) |
| A05 | Offline authority | Done-live (rel8) | clock_skew badge noise; native monotonic clock needs an APK |
| A06 | Refund permission via sync | Done-live | – |
| A07 | Refresh authority | Done-live (rel3) | – |
| A08 | Offline approval PIN hashes | Done-live (rel8) | attempt/grant retention; global admin PIN lockable by any outlet's cashier; lock events not in backoffice |
| A09 | Sale/tender invariants | Done-live | slice 8b (discount permission) needs owner policy; its A08-PIN override premise is gone |
| A10 | Quoted receipt total | Parent-open | promotion version stamp + per-promo id/version in discountBreakdown; points-cover-whole-bill rounding mismatch (`pricing.ts:401-404` vs `order.go:343-358`, tied to A22) |
| A11 | Exactly-once writes | Done-live for /sync/batch | direct `POST /cash-flows` (`writes.go:~1342`) has no idempotency key and no client calls it: retire or key it |
| A12 | Shift ownership / late events | Partial | shift-less attribution still present (`attribute.go:283-285`); operator-per-shift is the owner's call |
| A13 | Concurrent transfers | Done-live | – |
| A14 | Stock-count overwrite | Done-live (rel1) | built (guard + difference apply); never checked in a browser |
| A15 | Sold stock reappears | Partial (Phase B built locally, unreleased) | Phase A live; Phase B rebuilt as per-outlet `outlet_stock_seq` (migration 0057, merge `0c47870`, gate ST 56458) not released: needs backend 0057 deploy, OTA 2.1.5, emulator checks; auto-pull heals version-bump cases |
| A16 | Offline inventory workflows | Policy-blocked | owner rule: waits for the re-audit |
| A17 | Movement ledger | Policy-blocked (by owner rule) | – |
| A18 | Return/payout policy | Policy-blocked | – |
| A19 | Exchange/void commands | Policy-blocked | – |
| A20 | Points lots/expiry | Policy-blocked | – |
| A21 | Online-only redemption | Policy-blocked | – |
| A22 | Redemption rounding | Policy-blocked | small fix once a rounding rule is chosen |
| A23 | Linked tiered promo | Parent-open | server-path coverage for fixed, unscoped %, separate-set BXGY, bundle |
| A24 | Guest sales | Done | – |
| A25 | Merge/correction history | **Open, owner policy needed (not in the owner's A16-A22/A08 rule)** | gross vs net lifetime spend; refund does not adjust total_spent/visit_count; code caps after merge; original vs effective owner |
| A26 | Reports aggregate 50 rows | Parent-open | F5 payment filter, F6 Rp0 flash, Dashboard 'Semua' unbounded, float32 input schemas, summary+q at 500k not measured; the 50-row export/list bug is FIXED and LIVE in release 9 (pagefix) |
| A27 | Summary double subtraction | Done-live (rel8) | F1 per-product net of returns, F2 grant/code reports on refund basis |
| A28 | Business time | Done-live (rel8) | code-report 'kedaluwarsa' label + segment recency on Jakarta time; BD gate gaps |
| A29 | Error/batch contracts | Parent-open (server half done locally 2026-10-22, unpushed) | Server done on branch `claude/epic-williamson-532ec6`: sanitised direct-handler errors (`6ae5f72`), Retry-After on 429/503 + default request deadline 25 s / 28 s + sync work budget 20 s (`b0d94f0`), 520-item queue test on local Docker PG, not Neon (`86dd18f`). OPEN, separate POS slice (SyncEngine + OTA, owner gate): client does not read Retry-After (nothing in `packages/` reads it; `classifyFailure` `packages/sync/src/engine.ts:187-199`); no default deadline on non-batch calls (`packages/api/src/client.ts:487-490` only when `timeoutMs` is passed); review lows `engine.ts:562`, `:935` |
| A30 | Permission matrix / privacy | Done-live (rel8) | owner calls L1/L3/L5 (defaults built); Q1 answered 2026-10-20 (separate systems) |
| A31 | Stale polling overwrite | Done | – |
| A32 | Migration/pool budget | Done-live (rel2) | optional rollback drill |
| A33 | Redis required | Done-live (rel3) | Task 9 cleanup on/after 2026-10-30 (re-run Task 0 first); Upstash usage measurement + DelByPrefix SCAN open per sweep (not re-verified) |
| A34 | CI enforcement | Parent-open | dependency-security failed 2026-10-21 on 2 new advisories, fixed locally (see A38), green again only once the fix is pushed; still not in `REQUIRED_CI_WORKFLOWS`; OTA release_type not stored; PG gate port-bind retry; Git Bash env rewrite; branch protection (owner spend) |
| A35 | OTA/journal gates | Done-live | staged rollout deferred (decision #10); no error boundary; Capgo statsUrl needs an APK |
| A36 | Backups/restore | **Open** | whole build (~6 days); restore guard + single-transaction do not depend on O1-O4; rest waits for owner O1-O4 (Neon paid plan, API key, age keys). Follow-up: migration-head checks (`max(name)`, plan line 143) do not see 0057 (applies after 0063 on prod); restore must advance `outlet_stock_seq` (RUNBOOK) |
| A37 | Sensitive evidence | Done-live | panic-recoverer backlog; T10 scrub-or-delete is the owner's call |
| A38 | Dependency audit | Done-live | make it a required gate (with A34); dated SBOM. **2026-10-21:** the dependency-security job failed on 4b0f7f7 with 2 newly published advisories, both closed by bumps (merge `depsec` into prod-hardening, not yet pushed): vite 8.0.16 -> 8.1.6 for GHSA-587h-7wmj-h5pm (launch-editor Windows `existsSync` bypass, dev server only; overrides re-keyed to `vite@8.1.6`/`rolldown@1.1.5`, harness now evaluates the bundled `parseFile`) and Go toolchain 1.26.9 -> 1.26.10 for GO-2026-6809 (crypto/x509 distrust of compromised intermediates, `Certificate.Verify` reachable via TLS; 18 literals in 11 files). No exception added. Local gates green; the real scan re-runs only in CI after the push; the Go fix reaches Cloud Run only with the next backend deploy |
| A39 | CSV import | Done-live (rel5/6) | rename leaves warehouse stock; transfer/stock-count create skip variant-exists check; selectors not re-keyed on rename; no 40P01 gate case |
| A40 | Stale docs | Partial | this file + HANDOFF refresh (done 2026-10-20); tracker table September rows and sweep Totals still stale (superseded by this file); ONBOARDING not trimmed |
| A41 | Local receipts | Done-live (rel8) | SyncedRefunds window ~250 linked refunds/30 days; `orders:last` cache alias; archive one 1-2 MB value, on-device timing unverified; refund in an offline-opened shift blocked (policy default) |
| A42 | Lock ordering | Done-live (rel2) | – |
| A43 | Malformed bodies | Done-live (rel2) | – |
| A44 | Oversell exceptions | Done-live (rel4) | deferred lows L3/L4/L6/L7/L8 |

## ERP developer's backend review (BACKEND_ARCHITECTURE_REVIEW.md), cheap items, 2026-10-22
Done locally on branch `claude/epic-williamson-532ec6` (6 commits on `4052fe8`, unpushed, Opus-reviewed, gates green; backend-only, no migration, no OTA/APK):
| Review ID | State | Commit / notes |
|---|---|---|
| R-1 body caps | Done locally | `e134ad7`: global 1 MiB cap, method+path exception table (sync batch/review 8 MiB, imports 20 MiB, stock-count create / ingredient count save 8 MiB). Shift open/close still answer 400 (not 413) on a chunked oversized body (`service/shift_input.go` drops the error); cap holds. |
| E-1 raw DB errors | Done locally | `6ae5f72`: classifier by error chain; generic `internal error (ref <request id>)`; GET /products/not-a-uuid 500 -> 400; sync routes always 500; source-scan guard. |
| D-1 float32 money | Done locally | `b448c1e`: 59 money fields `format: double`; also fixed the outlet price-override write (float32 at HEAD); generated-type guard test. Quantities and rates stay float32. |
| S-1 customer overwrite | Done locally | `cac0019`: ON CONFLICT DO NOTHING + name/phone read-back, conflict otherwise; email not compared (avoids a guessing oracle; never written). |
| Pre-existing, open | Follow-up | Orders resolve any `customerId` without outlet/device check (`service/order.go:389-397`): a cashier with an id from the phone lookup can attach orders and redeem points (capped at balance). Owner call. |
| Flaky test, open | Follow-up | `internal/redact` `TestScannersScaleLinearly` failed once under full-suite load (wall-clock ratio), passed 5/5 alone and on rerun. |

## Non-policy work left before the re-audit
(a) A15 Phase B built locally, unreleased (release steps in HANDOFF; no unbuilt work left there) [+ A15 T4 now largely covered by auto-pull for bumps]; A36 backups; A33 Task 9 (not before 2026-10-30). Done this session, unreleased: the 50-row export/list truncation fix (the owner's list had missed it; it silently truncated customers/ingredients/stock-count/error-log exports and the products/ingredient pickers).
(b) Recorded follow-ups: A29 parent; A34 parent (cheap: add dependency-security to required gates, store release_type, PG gate port retry); A26 F5/F6/Dashboard 'Semua'/float32; A10 stamp; A23 coverage; shift-less attribution; A27 F1/F2; A28 labels; A08 retention/lock visibility; A41 residuals; A37 panic recoverer; A39 backlog; A44 lows; A11 unused `/cash-flows`; Cloud Run default service account has `roles/editor` (Known gaps); auto-pull: re-measure the production-size pull bundle (plan threshold 500 KB), 4xx suspension is short-lived (LOW-3), `/sync/inbound-transfers` failure could flip reachable.
(c) Owner action/decision (not code): A25 merge semantics; slice 8b; A30 L1/L3/L5; operator-per-shift; lock tablet date/time (A05); WITA outlet timezone only after OTA reaches every tablet (A28); APK 2.1 fleet rollout then legacy-envelope cutoff; A36 O1-O4; A37 T10; Upstash orphan-key deletion; GitHub Support purge + delete the backup bundle; GitHub Pro decision.

## Recommended order
1 doc refresh (this file) -> 2 pagefix + autopull RELEASED (release 9) -> 3 A15 Phase B release (built locally; owner go-ahead) -> 4 A29 parent -> 5 A34 cheap items -> 6 A10 stamp + A23 coverage -> 7 shift-less attribution -> 8 A36 restore guard now, full build after O1-O3 -> 9 A33 Task 9 on/after 2026-10-30 -> 10 owner classifies A25 and 8b -> 11 re-audit (not before 2026-10-30).
