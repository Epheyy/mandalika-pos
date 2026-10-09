# Linked fulfillment — A23-LINKED-FULFILLMENT-20260920-01

Contract: CG-A23-LP05-20260920-01-R1. All rows describe this turn's evidence;
parent A23/T21 and release gates remain open. Client cases use real decideApplyCode,
planner, reducer, allocators, pricing, metadata and SyncEngine with successful KV.
Picker tests exercise the extracted execution path permitted by the review; cancel
is pure preview plus source-wired pending-state removal, not a browser gesture test.

| Review # | Scenario and result | Evidence layer |
|---|---|---|
| 01 | Deterministic code-only BXGY: same paid/reward quantities and net as direct; raw code sole owner | linkedFulfillment.test.ts / shared DB fixture |
| 02 | Multiple-choice BXGY opens plan; cancellation has no selection/usage/cart effect | Pure planner and CashierScreen cancel wiring |
| 03 | Confirm aggregates repeated picks to qty2 at net15000; wrong quantity/unknown choice rejected | Planner + atomic reducer; direct comparison |
| 04 | Remove code removes P rewards, preserves paid lines; repeat harmless | Six initial regressions / final reducer |
| 05 | Paid quantity shrinks below selected reward quota: whole owner/effect removed | invalidPhysicalPromotionIds + reducer |
| 06 | Direct takeover strips old linked reward before recomputing; no double reward | Real shared execution |
| 07 | Linked after direct is inert | Identity planner/reducer; existing LP05 retained |
| 08 | Code-only unambiguous bundle: same physical lines/maps/prices as direct; no fake direct entry | Client + both HTTP DB routes |
| 09 | Ambiguous bundle opens same choice plan; cancel leaves sale untouched | Pure planner / existing picker wiring |
| 10 | Chosen dearer item freed at5000, retained fullPrice30000, maps/nApp1; all quantities conserved | Direct/code shared allocator comparison |
| 11 | Remove code restores original paid set exactly once; stale REMOVE_BUNDLE cannot over-restore | Real reducer, retained-map source of truth |
| 12 | Freed-participant edit evicts code; anchor nApp2->1 reactive shrink restores two moved units and removes owner/maps | Reducer + extracted reactive predicate |
| 13 | Direct takeover restores linked bundle before applying; cancel takeover picker leaves old linked effect intact | Planner/reducer; browse eligibility uses same restored preview |
| 14 | Code after direct bundle leaves maps/cart untouched | Identity/fulfillment tests |
| 15 | Second raw code for P never reopens picker/reapplies effect; first alone remains; no resurrection | Planner/reducer |
| 16 | Unrelated exclusive direct/code restores/strips old linked effect first | Reducer cases for both physical types |
| 17 | Clear mixed direct/linked bundles restores paid quantities and keeps loyalty reward | Reducer, per-product comparisons |
| 18 | New metadata has code only, P reward IDs, raw code label and one breakdown row; no double financial deduction | Actual metadata helper / enqueue / shared fixture |
| 19 | Synthetic response loss then reconstructed same-KV retry sends identical original key/body/line quantities | Actual SyncEngine; network response stub only |
| 20 | Parked historical duplicate sale retains serialized original identity/body/time/status/attempts/error after new capture | Same successful KV; no migration |
| 21 | Code-only BXGY: total110000, two physical units, one P grant at10000, usage +1 | Real auth/handlers/service/PostgreSQL, direct and batch |
| 22 | Code-only bundle: total105000, two units, one P grant at5000, usage +1 | Same DB routes |
| 23 | Equivalent direct selections have identical goods/prices/grants with usage +0 | Same P/mechanics; code_only flag enabled for linked requests only in synthetic DB |
| 24 | Two retries after first committed response treated as lost: original key acknowledged, all eight business-table snapshots unchanged | Real DB, both routes, all four fixture cases |

## Before-fix and final checks

Initial six regressions all failed: linked bundle snapshot absent, actual linked
handler sequence did not fulfill bundle/BXGY, seeded code-owned bundle/BXGY removal
left physical effects, and participant edit left a ghost code. Final assertions
unchanged. The two fulfillment tests' small driver now invokes the shared planner /
commit action used by the refactored screen; original driver/source is preserved.
Other initial tests use the same real mapper/reducer entry points before/after.

Two later regressions reproduced stale picker substitution and overlapping-slot
overclaim; both pass after commit guards. Intermediate source/tests are supplied
separately, not presented as entry-worktree behavior or hidden from passing counts.

Final focused27, full POS231 (12 files), sync33 (10 files), app and explicit test
types pass. Affected Go handlers/service/sync packages pass, including unchanged
shared tier goldens. Initial explicit test type checks found missing Product fixture
fields and untyped mock arguments; corrected to actual generated types. Full command
outputs/exits and session completions are in LF_VERIFICATION.json.

## Shared queue / conservation evidence

`backend/internal/handlers/testdata/linked_fulfillment_orders.json` is generated
through the real client planner/reducer/metadata/enqueue path and checked against
that path in the default POS suite. Four deterministic direct/code fixtures carry
the original raw code and P physical identity. Only the volatile clientCreatedAt
is omitted from this golden representation; real queue/retry tests preserve time.
Normal tests do not write the fixture; explicit MANDALIKA_LF_FIXTURE_OUTPUT generates it.
The Go harness changes only operation UUID/key per route to keep separate cases,
then retries each exact body/key twice. No fabricated SQL mutation guards.

| Mode | Paid buy | Reward / moved bottle | Total | New code intent | DB grant / usage |
|---|---|---|---|---|---|
| Direct BXGY | 1 at100000 | 1 extra at10000 | 110000 | none | 1 / +0 |
| Linked BXGY | 1 at100000 | 1 extra at10000 | 110000 | Raw-LF-buy_x_get_y | 1 / +1 |
| Direct bundle | 1 at100000 | 1 moved from20000 to5000 | 105000 | none | 1 / +0 |
| Linked bundle | 1 at100000 | 1 moved from20000 to5000 | 105000 | Raw-LF-bundle | 1 / +1 |

Bundle physical quantities are unchanged by application/removal. BXGY adds only
earned reward units; removal keeps bought units unchanged. Physical savings live
in item prices; breakdown's zero amount for these existing types is not another
deduction or a claim that no reward was granted. Label/provenance retains the code.

## Safeguards and limits

PostgreSQL18.3 installed tooling, only127.0.0.1:56442, fixed synthetic DB/user,
parsed DSN and SHOW data_directory match before mutations, empty public schema,
45 unchanged migrations. The first cluster verified eight cases; a fresh second
cluster reran the strengthened retry-status assertions. Both stopped/retained.
Prior S0c/S0d/BE directories and stopped-cleanup policy block remain untouched.
Ordinary Go package runs skip opt-in DB tests; separate explicit DB run passed.

No live/provider changes, install, migration development, backend production edit,
commit/push or deployment. No browser/native device, power loss, concurrent race,
Redis, release or exhaustive catalog qualification. Existing quantity-expansion
resource behavior is unchanged (A29). Q08 stock warning/override remains unchanged.

Shared allocator slots are independent: overlapping slots could emit more freed
units than owned. New client commit guard rejects impossible moves, and stale picks
cannot silently substitute another item. General overlapping-slot/disjoint allocation
semantics and backend overlap behavior remain Q-LF-01, outside the demonstrated
vectors. Complete A23/T21, versioned quote parity and all gates remain open.
