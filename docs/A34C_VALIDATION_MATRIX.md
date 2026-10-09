# A34c verification matrix

Packet: A34C-BROWSER-CI-20260921-01. Reply: CG-A34B-POSTGRES-CI-20260921-01-R1.
All runtime statements below use this turn's local source; hosted proof is pending.

| Review acceptance | Actual evidence |
|---|---|
|1 Inventory | Required registry26;18 historical source/helper paths inventoried. S0a/S0b included; redundant/manual entries explicit. |
|2 Discovery | Canonical gate actual26 equals independent required26 exactly once. |
|3 Execution | Final26 PASS,0 skips/fixmes; completion reporter verifies status and expectedStatus. |
|4 BO semantics | BO-SEMANTIC:5 key vectors plus real picker edit/duplicate/toggle; invalid save makes0 write calls; valid mechanics preserved. |
|5 BO pagination | BO-PAGES-CSV/XLSX:51/201/1000 rows/totals, Dashboard complete product low-stock, payment/status/date filters; page2 failures disable export. |
|6–7 Outlet races | BO-RACE-SUCCESS/ERROR each hold outletA page2 of201, publishB then finishA; B state persists. |
|8–9 Fulfillment | POS-PICKERS10 records, POS-INVALIDATION9, POS-PHYSICAL-QUEUE4; direct/linked bundle/BXGY, conservation, raw code, promotion reward owner. |
|10–11 Guests | POS-GUEST10 records incl same-storage reconstruction; null identity/no loyalty, generic codes, restricted rejection, clear/reconfirm and registered preserved. Separate new-customer queue link test. |
|12 Recap | POS-RECAP:401 orders/flows,251 history, selected historical shift index60 with401 orders/401 flows; late-page error retains full cache and real offline panel remount reconstructs. |
|13 Hook |13 individually required real React/DOM cases through actual production usePolledQuery; A26 whole-cohort race included. |
|14 External | Disposable browser fetch to unexpected.invalid aborted; network evidence captures URL; error-swallowing does not prevent gate exit1. |
|15 Skip/missing | Separate missing-ID and all-required-skipped probes exit1. Completion records every skipped/not-passed ID. No implicit pass from process success. |
|16 Only | Actual test.only fails discovery via forbidOnly; no browser/servers started. |
|17 Assertion | Actual rendered title intentionally mismatches; exit1; screenshot/trace retained; remaining unexecuted tests also fail completion. |
|18 Chromium absent | Empty browser location has no executable; exit1 without download/system fallback; Vite cleanup confirmed. |
|19 Readiness | Backoffice never listens in disposable copy,3s timeout; about11s whole runner; owned processes gone and ports closed. |
|20 Credentials | Fixed nonfunctional synthetic identities/tokens; app env loading disabled; child env allowlist; no real login/service calls. |
|21 Artifacts | Synthetic-only fixture trace/screenshot, JSON/JUnit allowlist; seven-day upload on failure only; no profile/storageState file. |
|22 Android | Parsed needs=[quality,database,backend,browser], no bypass conditional; all checkout callerSHA; no secrets inherited. |
|23 Prior CI | quality/postgres/backend/React Doctor workflows byte-preserved; shared package quality adds browser typecheck and passes. |
|24 Business source | No production business edit. Existing test harness case selector and test-server decorative asset substitution only. |

Additional required rendered checks: S0a five diagnostic outcomes preserve2 original
operations and reconstructed visibility; S0b denies5 attempts, exports/reconstructs
same record, then manually retries original key and simulates one mutation.
These are browser fixtures, not PostgreSQL-backed authorization proof.

Quality baseline:347 PASS; one pre-existing optional A26 PostgreSQL page replay SKIP
because MANDALIKA_A26_PAGES is absent. No required browser scenario skipped. Both
production bundles/types/schema pass. Generated schema bytes and unrelated entry
files preserved. See A34C_ARTIFACT_CHECKS.json for patch/hash/tracker checks.

Seven negative proofs are actual checked-in gate runs in a disposable installed
copy, not mocked exit codes. Mutation restoration and active-source preservation
are asserted. Normal45s/server,120s/test,900s/suite,960s/outer,25min/job limits remain.
Linux process-group cleanup and hosted system dependency installation are source
reviewed, not locally executed on Windows. Abrupt SIGKILL/host loss cannot run finally.
No claim of full A34/T29, A13/A42 business concurrency, native/provider or release closure.
