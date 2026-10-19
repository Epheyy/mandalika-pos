# A23 promo parity (tiered leftover): plan (2026-10-19)

## State (verified by the planner from source)
The original A23 defect is fixed: `linkedPromoShape` (apps/pos/src/cashier/pricing.ts:307-322) copies id, type, value, applicableProductIds and the bxgy/tiered/bundle configs, the only fields
`calcPromoDiscount` (TS) and `calcPromotionDiscount` (Go, backend/internal/service/pricing.go:496) read. `TestLinkedTierGolden` (16 vectors in testdata/linked_tier_golden.json; the sweep says 12) and
`linkedTierParity.test.ts` (21 tests) pass. Server recomputes in order.go:223 via resolvePromos/loadPromoSpec, so a client cannot set the price.
LEFT for A23 itself (small, tests only): (a) the Go golden calls `Compute` with a hand-built PromoSpec, never through loadPromoSpec/resolvePromos: no server-path test for direct promotion vs linked code;
(b) no shared Go/TS parity matrix beyond tiered (stacking, manual+promo cap, scoped items, bogo, BXGY same-set/separate-set, bundle, tax, rounding).
The captured-quote half (client total, per-promotion id+version, "differs" review item) is FOLDED INTO A10. If no parity vector fails: no migration, no OpenAPI change, no generated types, no release.
If a vector exposes TS/Go drift: fix ships by OTA (web) + backend deploy if Go changes; no APK; Go and TS must change together; Opus review.

## Tasks
T1 shared parity matrix (tests first). New `backend/internal/service/testdata/promo_parity_golden.json`; each case: cart lines {productId, variantSize, price, qty, subtotal}, promotions in API Promotion shape
(type, value, applicableProductIds, bxgy/tiered/bundle config), manual discount, surcharge, tax/rounding settings, expected {promoDiscount, discountAmount, taxAmount, total}.
Cases: scoped percentage hit and miss on eligible items; fixed above subtotal; bogo; BXGY same-set with maxApplications; BXGY separate-set and bundle contribute 0; tiered mixed with a percentage under
combinable stacking; manual+promo above subtotal (cap); tax 11% with nearest_500 and nearest_1000; a .5 half-rounding case. All inputs non-negative (Go math.Round vs JS Math.round differ only on negative halves).
New `backend/internal/service/promo_parity_golden_test.go`: map fixture promotions to PromoSpec with a helper mirroring loadPromoSpec (order.go ~1059-1083: Kind, Value, ApplicableProductIDs, IsBOGO, configs); pin case count.
New `apps/pos/src/cashier/promoParity.test.ts`: per case run computePricing twice (direct via appliedPromotions; linked via decideApplyCode selection, pattern in linkedTierParity.test.ts:15-19), both equal golden.
If a case fails: STOP and report which engine is wrong; never edit the golden to match.
T2 server path direct vs linked (Opus review; PG gate): `backend/internal/handlers/promo_linked_parity_integration_test.go` `TestPromoLinkedParityPostgres` modelled on linked_fulfillment_integration_test.go.
Per kind (tiered, scoped percentage, bogo, BXGY same-set): seed one promotion + one discount code with promotion_id; online order with promotionIds:[P]; second order with discountCodes:[code] on an identical cart;
assert equal total, discount_amount, discount_warning=false. Edges: direct+linked to the same promotion deduplicated (discount once); code_only promotion through the direct path rejected/flagged per existing rule.
Register in scripts/ci/postgres_gate.py GATES with a free port (56459 is highest in use; check other branches before taking 56460).
T3 docs: docs/AUDIT_COVERAGE_TRACKER.md ~1295-1305 + HANDOFF: A23 parity done; captured-quote/version residual moved to A10.

## Verify
`go test ./internal/service -run Golden -count=1`; `corepack pnpm --filter @mandalika/pos exec vitest run src/cashier/promoParity.test.ts`; `corepack pnpm quality:ci`;
full `python scripts/ci/postgres_gate.py --no-race --output artifacts/postgres/result.json` (Docker Desktop running).

## Handover to A10 (belongs in the A10 plan)
Promotion versioning (`promotions.version int NOT NULL DEFAULT 1`, bumped in write/repo.go:687 UpdatePromotion, in read SQL/JSON, OpenAPI Promotion, generated types, sync bundle); captured quote
(optional promotionId + promotionVersion per discountBreakdown entry built in promotionMetadata.ts; jsonb so no orders column; client quotedTotal + difference in A10's columns; flag-only "differs / promotion changed" reason);
migration 0058 or next free at merge (0057 claimed by A15 Phase B). Risks: old queued events lack new fields (absent = not captured, never mismatch; no rewrite of history); deploy backend first, tablets at 0 pending, then OTA;
keep expression order identical (`sub * (value/100)`) if any engine edit happens. Owner questions: none (mismatch is flagged, never rejected, online or offline: slice-8 precedent).
