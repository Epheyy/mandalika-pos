# BE and LP validation — S0D-ENVELOPE-A23-20260920-01

Controlling reply CG-S0D-SHIFT-DECODE-20260920-01-R1; authority AUTH-MANDALIKA-20260919-01.
S0d corrective work locally verified, re-review pending. A23 mapper locally
verified, review pending, with LP05 PARTIAL/OPEN. Full A43/T25, A23/T21 and gates open.

## Envelope contract and actual evidence

Only handlers/syncBatch changes production intake, via batch_envelope.go.
No global DecodeLoose change, inner shift/service rewrite, schema/generated change
or retry policy. Parse one complete object; reject trailing bytes and repeated
consumed outer items or item type/idempotencyKey/payload before dispatch, including
case/escaped aliases and identical repeats. Unknown metadata and single aliases
remain compatible. Payload RawMessage bytes remain intact for command validators.

Absent/null/empty items remain existing no-op behavior, despite the OpenAPI's
stricter required declaration. No producer needs omitted items to create effects.
Non-object items, wrong primitive metadata types and absent/null/blank original
keys reject the whole request; never generate or trim a key. Missing/null/unknown
type with a known key and absent/null payload remain unambiguous per-command
failures, not structural ambiguity. Duplicate key VALUES across separate items
are not newly governed; universal receipt/fingerprint semantics remain A11 work.
No claim that rejecting ingestion means a previously captured event never happened.

| Scenario | Actual evidence | Limits |
|---|---|---|
| BE01 | Raw actual handler trailing junk, truncated second value and object/scalar/array/null tails reject before caller/dispatch; DB rows unchanged | Real project, no lab stubs shipped |
| BE02 | Duplicate items exact/case/escaped-equivalent, identical/different collections rejected | Entire request, no discarded first collection |
| BE03 | Duplicate type/key/payload exact/case/escaped-equivalent rejected | Even identical repetitions rejected |
| BE04 | Earlier valid item plus later ambiguous item yields no dispatch or DB business effects | Full structural pass precedes processing |
| BE05 | Whitespace, benign unknown metadata, aliases and {}, items:null, items:[] pass | No-op shapes do not create financial rows |
| BE06 | Bad shift + good shift + forged forbidden refund: original error/ok/error keys, one shift effect | Actual JWT/caller/service/DB |
| BE07 | Duplicate cash inside RawMessage rejected per item; valid independent shift succeeds | Established inner decoder unchanged |
| BE08 | Real JWT/lookup wrong outlet/missing/invalid token rejects; allowed token processes; forged body authority ignored | Existing nine-case permission mapping suite includes admin/permitted/refreshed/expired tokens; no live revocation proof |
| BE09 | 34 negative raw-body DB subcases and four auth/empty/positive/mixed control groups pass | Ten table full-row snapshots, positive controls require only shifts change among these tables |
| BE10 | Two tests, one each shift type: whole request throws HTTP400, five attempts, visible parked count, repeated export, same successful KV reconstruction, original-key retry | Diagnostic generation exercised, real OS clipboard/share not rerun; no native power-loss proof |
| BE11 | Go auth/middleware/handlers/service/sync pass, server compiles; sync 33, pre-A23 POS160, API/sync/POS types pass | Normal Go opt-in DB tests skipped; BE DB separately ran. No whole audit or deployment test |

Before fix: real-handler TestBatchEnvelopeRejectsBeforeDispatch has 26 failing and
8 already-passing subcases. The supplied five raw cases all fail with dispatch=1.
After: same 34 assertions pass. Original S0d SD05/SD07 text now distinguishes the
old direct/inner evidence from the outer gap; old logs/bundles/counts are immutable.

## A23 mapper evidence

Production change is three lines: typed tieredConfig in LinkedPromotionInfo,
copy on decideApplyCode, and copy in linkedPromoShape. No backend pricing rewrite,
quote/receipt migration, resource compression or queued-history repricing.

| Scenario | Actual evidence | Limits |
|---|---|---|
| LP01 | Real selection chain before direct90000/linked100000; after both90000 | Same regression assertion |
| LP02 | Shared golden below/at/above thresholds, unordered tiers and first-tie selection | Supported small cases, not exhaustive allocations |
| LP03 | Fixed/percentage, half rounding, fractional subtotal, fixed/subtotal and overall clamps | Existing arithmetic preserved |
| LP04 | Missing/null/empty config all yield established zero discount | No fallback from unrelated value |
| LP05 | Same raw code duplicate does not stack; independent codes combine, exclusive replaces; code/promo eligibility intersection passes | PARTIAL: same promotion directly AND by code double-counts. Separate failing probe preserved, Q-LP05-01 |
| LP06 | Linked/unlinked fixed/percentage checks plus existing POS BXGY/bundle/reward suite pass | Broader promotion snapshot/combination equivalence not claimed |
| LP07 | Raw mixed-case code and exact assigned customer identity preserved; frozen catalog/cart/selected input unchanged by compute | No historical store rewrite or merge/reissue tests |
| LP08 | One shared JSON file, 16 Go Compute and TS full selection/pricing examples agree; final POS181 and app/new-test types pass; sync33 remains current | Backend SQL resolver not freshly exercised for dedup; source shows it |

An initial LP05 assertion incorrectly required reducer object identity; source
returns an equivalent copy while clearing UI input. Corrected to deep state
equality; no production change for that test issue. LP01 assertion unchanged.

Separate review probe (not part of the 181 passing tests): selection reducer first
applies a combinable promotion, then its linked code. Expected once-only total
90000; actual80000. Backend resolvePromos maintains seen IDs and skips redundant
linked codes (source evidence). The probe is included under evidence/, with its
exact failed output and rerun instructions; it is not treated as acceptable
behavior or hidden in passing counts. Full LP05/A23 acceptance is outstanding.

## Fixture and verification limits

New fixture C:/Users/MYBOOK~1/AppData/Local/Temp/mandalika-be-lp-a8nu0jbr/postgres-synthetic,
127.0.0.1:56441, mandalika_be_synthetic, be_test. Installed PostgreSQL18.3.
Test validates parsed host/port/db/user, SHOW data_directory, empty public schema,
then applies the 45 existing migrations to synthetic data only. Snapshot tables:
shifts, cash_flows, orders, order_items, outlet_variant_stock, customers,
point_transactions, discount_codes, promo_reward_grants, processed_keys.
Preseeded content version/infrastructure metadata is outside those business tables.

New server stopped exit0, directory retained. Old S0c and S0d fixtures remain
untouched with their previously recorded stopped status; old S0c cleanup policy
block not retried via any path/tool. No filesystem cleanup attempt in this turn.
No live database, credentials, installs, remote checks, commits, pushes or deploys.

No new post-commit readback behavior/injection; no Redis, concurrency, native,
real sharing, live payment, restore or release qualification. Original S0a/b/c/d
regressions run in affected suites; old sale/shift opt-in DB tests not rerun.
POS app config excludes tests: the NEW LP test received a separate explicit tsc
check. Sync tsc includes its tests. No generated contract change; hashes preserved.
Self-review only; ChatGPT has not accepted these changes yet.
