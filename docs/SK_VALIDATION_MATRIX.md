# Semantic promotion keys — A23-SEMANTIC-KEYS-20260921-01

Authority: AUTH-MANDALIKA-20260919-01; owner's 2026-09-21 relay accepts linked
fulfillment within evidence and directs semantic disjoint-key validation. No new
reply file/ID was supplied. E19 acceptance / E20 local implementation are distinct.

## Contract and source trace

- Bundle design: docs/superpowers/specs/2026-07-02-promo-sp3b-bundle-design.md,
  decisions9, sections2/3: save-time disjoint slots justify independent counts.
- BXGY design: 2026-06-22-promo-sp3b-buy-x-get-y-design.md, decisions2/7 and
  validation: disjoint explicit buy/get sets, composite keys, empty-get same-set.
- ProductVariantPicker.tsx explicitly gives whole-product selection all variants
  and clears its variant selections; a variant selection clears whole-product.
- Before-fix write.validateBundle and validateBXGY compared raw strings; both
  CreatePromotion/UpdatePromotion already called these before opening a transaction.
- Service bundleSlotIndex assigned the first matching slot; bundleFreedNets now
  rejects an overlapping config before that assumption is used. No new allocator.
- Shared TS package/types and Go internal/promotionkeys implement one contract,
  checked against the same twelve JSON vectors. Case-sensitive, no normalization.

| Required behavior | Actual evidence |
|---|---|
| P/P and P\|M/P\|M reject | Shared vectors; Go write tests and real database Create/Update; POS both owner/action paths |
| P/P\|M and reverse reject | Before-fix Go authoring/runtime and POS failures; shared vectors; DB both orientations |
| P\|M/P\|L and distinct products stay valid | Shared vectors, actual Create/Update, POS bundle/BXGY physical execution and code metadata |
| Backoffice rejects before save | Real shared authoring guard; actual modal Save button server-rendered with final wizard step selected; callback checks again before API |
| Backend independently rejects create/update | Real Repo methods, nil-pool no-dispatch guards and isolated PostgreSQL row/content-version snapshots |
| POS direct/code legacy invalid rule is inert | Real planner/APPLY_FULFILLMENT plus legacy APPLY_PROMOTION/APPLY_PROMO_CODE/APPLY_BUNDLE; same state/cart, no owner/usage intent |
| Client impossible-move guard retained | Entry guard block byte-equivalent; existing negative regression retained; no allocator expansion |
| Backend invalid bundle fails before first-slot resolution | Pure bundleApplications and bundleFreedNets regression; online direct HTTP422 through real auth/service/SQL |
| Online no new money/stock/grant/code/key effects | Eight cases: bundle/BXGY x direct/code selection x key orientation; eight complete business-table snapshots unchanged |
| Captured offline facts preserved | Eight batch cases: original reward price1234, qty1 plus paid qty1, total/paid101234, two stock units, warning, raw code provenance, original-key retry unchanged |
| Offline invalid semantic BXGY reward is not dropped | New narrow resolver branch; reward_invalid warning, original price/subtotal/quantity retained, no validated grant |
| One code use; no invalid grant | Offline code-owned capture increments usage once; direct increments zero; invalid mechanics create zero validated grants; retries preserve all rows |
| BXGY whole/variant cross-set overlap rejects | Same shared vectors and both authoring/execution layers; exact overlap remains rejected |
| Same-set / empty-buy complement remain valid | Go/TS shared vectors, existing pricing/reward tests, actual DB authoring vectors |
| Existing valid physical fulfillment remains green | All earlier LF tests, unchanged shared queue fixture and eight real DB direct/batch x direct/code x bundle/BXGY cases |
| Queued historical evidence unchanged | Same successful KV reconstructed parked legacy operation byte-equal; all33 existing sync tests; sync source unchanged |
| Stored-config release diagnostic read-only | READ ONLY/REPEATABLE READ scan, before/after DB equality; actual executable flags active+inactive deliberately invalid rows |
| Repository compatibility inventory | SK_COMPATIBILITY.json: ten entry JSON files, two mechanics objects, no overlaps; three known intentional negative source fixtures; dynamic/source-search limits explicit |

The Backoffice form test changes only the initial wizard step through a React hook
mock; validators and rendered Save button are real. It is not a browser-click or
native-device test. The page's secondary save callback is source-traced, not a
browser/API integration test. Backend authoring tests invoke real Repo methods;
sale tests invoke real authenticated HTTP handlers and PostgreSQL.

Direct HTTP creates online commands; batch hardcodes offline origin in current
source. Tests retain that trusted route mapping, not a payload-controlled origin.
The eight tables compared are orders, order_items, outlet_variant_stock,
product_variants, discount_codes, promo_reward_grants, point_transactions and
processed_keys. Authoring also compares promotions and content_versions.

## Commands, failures and final results

SK_VERIFICATION.json preserves exact cwd/commands/tool exits/output and session
completion. Initial Go regressions fail both semantic directions and unsafe
runtime counts/first-slot acceptance. Initial POS run had an empty catalog masking
BXGY; after correcting that fixture both bundle/BXGY cases failed before code edits.
The recorded second before-fix POS output is tool-truncated, explicitly retained.

Final: POS241/241 (13 files), Backoffice19/19 (3), sync33/33 (10), both app typechecks,
explicit new-test types, affected Go packages pass. The database harness passes47
leaf scenarios:22 authoring,8 prior valid,8 online invalid,8 offline captured,1 scan.
No individual tests were removed to obtain green results. Old opt-in DB suites skip
in the ordinary Go run; their historical isolated runs are not current verification.

Intermediate test corrections: shared fixture path was one directory too high;
pricing fixture needed loyalty fields; parked counts are dead-letter counts, not
automatic pending counts; linked fixture needed isBOGO; HTTP assertion needed the
existing localized error message rather than an absent machine code. First DB run
failed that message assertion; final run used a fresh empty cluster. None required
changing the application error envelope. Local encoding review restored original
Unicode comments after a Windows-default decoding error; final source was checked
against entry and affected Go tests rerun. No incidental encoding changes remain.

Preflight executable exits1 when it finds the two seeded overlaps (expected),2 for
missing explicit target (expected). The first PowerShell no-target invocation
reported wrapper1; a follow-up propagated $LASTEXITCODE and verified native2.

## Safeguards and limits

Installed PostgreSQL18.3 only; same allowlisted synthetic database/user and loopback
port56442, new task-specific directories, checked data_directory and empty public
schema before45 unchanged migrations. Both new clusters stopped/retained. Previously
blocked S0c cleanup was not attempted; prior clusters were not touched. No live DB,
.env, installs, migration edits, credentials/provider changes, commit/push/deploy.

No live/staging legacy-row inventory, browser/native gestures, power-loss durability,
concurrency/Redis, exhaustive malformed-config validation or release qualification.
Preflight checks semantic overlap and uninspectable key structures, not every
catalog/schema/money invariant. Other missing/invalid BXGY offline line-drop paths
remain outside this new semantic-overlap branch and require separate review.
A23/T21, A10 quote/receipt work, A29 resource safety and all release gates stay open.
