# LP05 identity containment — A23-LP05-20260920-01

Contract: CG-S0D-ENVELOPE-A23-20260920-01-R1 section 3. Fresh local evidence,
not full A23/T21 or release qualification. The 23 cases in promotionIdentity.test.ts
use real decideApplyCode, cashierReducer and computePricing. Queue cases compose
the production metadata helper with real SyncEngine.enqueue and reconstruction on
the same successful Map-backed KV. Network is disabled and asserted unused.

| Review scenario | Evidence / observed result | Layer / limit |
|---|---|---|
| 01 Direct then linked, combinable | Original regression and queued direct-first: P only, 90000, no code | Real modules / KV |
| 02 Linked then direct, combinable | Original regression and queued linked-first: P only, 90000 | Real modules / KV |
| 03 Direct then linked, non-combinable | False-parameter regression; redundant exclusive code also preserves unrelated selections | Selection/reducer/pricing |
| 04 Linked then direct, non-combinable | False-parameter regression; stale same-ID non-combinable code removed before incoming direct combinability; genuine exclusive still replaces unrelated offers | Selection/reducer/pricing |
| 05 Two linked codes for P | Both combinability values keep Raw-Code-1, 90000; one submitted code/effect | Real modules / KV |
| 06 Same raw code twice | Existing winner unchanged | Selection/reducer |
| 07 Different IDs, equal rules | P and Other remain; 10000 each, total80000 | Real modules / KV |
| 08 Unlinked plus direct | Independent effects total80000, raw Unlinked-Raw retained | Real modules / KV |
| 09 Code-only P | Linked path usable, no direct identity invented, 90000 | Real modules / KV |
| 10 Remove direct winner | Remove/toggle/clear do not revive code; stale duplicate draft also normalized before removal | Reducer/pricing |
| 11 Remove winning code | Redundant second code never returns | Reducer/pricing |
| 12 Clear/exclusive ownership | Direct/linked-first bundle preserves one physical bottle and bookkeeping on redundant code removal; clear/exclusive restores paid bottle. Direct BXGY reward retained until ordinary removal; loyalty reward preserved | Reducer ownership; not linked picker/allocation execution |
| 13 Capture metadata | Six captures/reconstructions assert IDs/singulars/codes/label/breakdown/cash amount. Manual adjustment independent. Frozen duplicate draft not mutated | Helper + actual enqueue/KV; not full React checkout or SQL counter verification |
| 14 Historical duplicate | Parked sale preserves key, duplicate body, timestamps, seq17, failed status, attempts5, error; new capture seq18 | Same KV. Unchanged server seen-ID/codeIDs behavior inspected, not newly SQL-tested |
| 15 Existing regressions | POS204/204, sync33/33; app/explicit test types pass; unchanged shared Go tier goldens16 pass | Installed tools; no backend DB suite rerun |

Before-fix: original ten-case source in LP05_BEFORE_FIX.diff. Seven failed, three
passed: duplicate benefit80000 vs90000, second linked winner replacement, direct
eviction, unrelated eviction and hidden code after removal. Original ten assertions
remain unchanged in the expanded test. No claim that every final edge failed before.

## Actual captured metadata

ZIP evidence/LP05_QUEUED_METADATA.json contains six actual synthetic queue records
with generated key/device/time. A temporary copy of the final test adds file output
only; six queue cases pass, seventeen nonmatching cases intentionally filtered.
It is removed from the app after capture. Initial stdout probes passed but exposed
no console data; file output supplied the records. Full suite separately ran204.

| Selection | promotionIds | discountCodes | label | Breakdown amounts | Quoted/cash paid |
|---|---|---|---|---|---|
| Direct then linked P | P | empty | Ten percent | 10000 | 90000 |
| Linked P then direct | P | empty | Ten percent | 10000 | 90000 |
| Two codes for P | empty | Raw-Code-1 | Raw-Code-1 | 10000 | 90000 |
| Code-only P | empty | Raw-Code-1 | Raw-Code-1 | 10000 | 90000 |
| Direct P + linked Other | P | Raw-Code-1 | Ten percent | 10000,10000 | 80000 |
| Direct P + unlinked | P | Unlinked-Raw | Ten percent | 10000,10000 | 80000 |

CashierScreen.handleConfirmPayment uses the same effective projection for guards
and spreads buildPromotionMetadata into enqueue (source trace, not browser event).
The redundant-code message is source-wired, not browser-verified. Code usage intent
is the effective outbound code list; SQL increments are unchanged inspected source.

## Limits / safeguards

No live/provider connection, new database/server, dependencies, credentials, schema,
commit/push or deployment. Prior S0c/S0d/BE synthetic clusters remain recorded
stopped/retained, not freshly process-verified; blocked cleanup not retried/bypassed.
Successful KV is not native power-loss/storage qualification. No provider, race,
post-commit failure, browser, native sharing or release verification is claimed.

Linked code handler lacks direct bundle/BXGY reward selection/allocation dispatches;
LinkedPromotionInfo/linkedPromoShape lack bundleConfig. Existing direct ownership
is protected; complete linked fulfillment remains A23/T21 (Q-LP05-02). Resource
compression, quote/receipt migration and loyalty redesign remain separate.
