# A23 qualification / A24 guest acceptance — 2026-09-21

Packet: A23-QUAL-A24-GUEST-20260921-01. Standing AUTH-MANDALIKA-20260919-01.
Reply: CG-A23-SEMANTIC-KEYS-20260921-01-R1, read in full before edits.

## Qualification layers

| Requirement | Actual evidence | Limit |
|---|---|---|
| Explicit catalog preflight | Existing Cloud Run mandalika-pos/asia-southeast2 DATABASE_URL/latest secret reference resolved; CLI scans1 row, findings[], exit0. A24_PREFLIGHT_TARGET.json. Build of current source has identical binary SHA256. | No separately designated staging target. Read-only role probe timed out35s; capability unknown. CLI READ ONLY/REPEATABLE READ and30s timeout unchanged. No remediation, full-schema or production-ready claim. |
| BO semantic authoring | Actual rendered Promotions/PromoFormModal/ProductVariantPicker: bundle P/P-M both orders reject; distinct M/L saves; explicit BXGY whole/variant rejects, M/L saves. UI checkbox converts valid rule to overlap, displays actionable message, Save disabled. Invalid Save click yields zero mutation calls. Duplicate/toggle payloads retain valid config. | Synthetic API responses/recorded mutation calls only; no live catalog writes. Browser uses real components, not SSR. |
| POS physical mechanics | Real CashierScreen plus direct/linked bundle/BXGY pickers open, cancel unchanged, confirm, takeover, removal, clear, participant-edit invalidation. Legacy invalid direct disabled; linked refuses effect/picker. | Synthetic catalog and intercepted API. Earlier Go/DB checks plus53 current database scenarios cover separate backend layer. |
| Queue physical metadata | Four actual browser captures: direct/linked bundle and BXGY. Bundle3 units conserved; BXGY paid3+reward1. Promotion ID owns reward, linked raw code owns sole usage, no fake direct selection. Individual removal/reapply tested. | Not a browser-to-live-service E2E or native power-loss test. |
| Native | adb devices empty; emulator -list-avds empty, installed SDK inspected. | Native UI qualification unavailable. No install. |

## A24 review scenarios

| # | Scenario | Evidence/result |
|---|---|---|
| 1 | Before-fix ordinary guest blocked | guest-gate.js throws on entry source; A24_BROWSER_BEFORE_FIX.json. |
| 2 | Corrected checkout opens | Same real browser assertion passes; A24_BROWSER_GATE_FINAL.json. |
| 3 | Guest cash null identity/key | Actual CashierScreen enqueues cash; payload customerId/customerName null, original device:orderUuid key. A24_BROWSER_GUEST.json. |
| 4 | Enabled noncash | QRIS follows existing tender path; null identity; PostgreSQL direct/batch total and paid100000. |
| 5 | Direct guest persistence | Actual authenticated handler/service/PG: cash+QRIS customer_id IS NULL, stock delta-1, zero earned/redeemed. |
| 6 | Batch guest, no customer ledger effects | Same two cases through actual SyncBatch; full customer/points JSON snapshots equal. Loyalty enabled in fixture. |
| 7 | Generic percentage/fixed | Actual browser direct percentage and retained fixed after clear; two pricing vectors in guestSale.test.ts. |
| 8 | Generic linked code | Browser Raw-Generic, one code intent/no direct promotion ID; unit code validator/pricing/metadata. |
| 9 | Per-customer code | Real browser guest rejection; no code in captured payload; registered eligibility remains allowed in unit test. |
| 10 | Assigned code | Real browser guest rejection; no code intent; matching customer eligibility unit test. |
| 11 | Guest loyalty unavailable | Actual checkout lacks redemption/reward controls; guest totals ignore stale balances; queued points null/no condition reward. Database unchanged customer/points snapshots and zero earned. |
| 12 | Customer benefit then clear | Assigned linked code + separate generic fixed: first confirm removes invalid code and queues nothing; second clean confirm queues guest, no stale identity. Picked loyalty gift/redemption cleared before another guest capture. |
| 13 | Generic benefit survives clear | Independent generic fixed ID retained after assigned-code removal and reflected in queued amount. Existing physical-effect cleanup remains conservative, documented residual. |
| 14 | Registered and add/select flows | Real browser existing customer, new customer_create then sale references created ID/name. Actual database registered direct/batch earns100 and updates customer ledger once. |
| 15 | Receipt/success/reprint | Actual guest success/receipt text no customer/name/phone. Transport-independent ESC/POS buildReceipt and reprint test bytes have no fabricated identity. Physical Bluetooth printer not available/tested. |
| 16 | Retry idempotency | Six DB cases each replay identical request/key twice with unchanged complete business/customer/points snapshots; browser same-storage reload preserves keys/payloads/timestamps. |
| 17 | Existing regressions | POS250, BO19, sync33, printer7, app/test types, seven Go packages. LF/SK+guest DB53 pass. BE/sale-input/shift-decode opt-in DB harnesses skip in ordinary package command and were not separately rerun; their unit/handler/sync checks pass. |

## Source and safeguards

Production change is only CashierScreen.tsx and CustomerPicker.tsx. No backend
production change, migration, historical queue/row rewrite, authentication change,
retry policy or financial recalculation redesign. validateCode remains customer
eligibility authority; an invalid selected code is individually removed before
capture and the cashier must reconfirm. SET_CUSTOMER already clears redemption /
loyalty lines. Final capture also refuses stale guest loyalty state; picker callback
requires a customer, configured loyalty and the existing reachability signal.
This is not new online authority design or immediate server revocation.

The isolated database fixture checks the LF target allowlist, actual data_directory
and empty schema before existing migrations. Both newly created directories are
stopped/retained; earlier S0c cleanup block remains and was not retried. Initial
runner pipe inheritance and fixture-selector mistakes are recorded in verification,
not relabeled passing application checks.

All A01–A44 remain in the sole tracker. A23/T21, A24/T22, A25 historical correction,
A01 durability and all release gates remain open. Later guest attachment/merge,
A29 resource compression, quote/receipt migration and loyalty redesign are separate.
