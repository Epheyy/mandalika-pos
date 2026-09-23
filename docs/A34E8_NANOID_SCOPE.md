# A34e8 — nanoid through the actual PostCSS consumer

Scope ID: **A34E8-NANOID-20260923-01**
Authority: **AUTH-MANDALIKA-20260919-01**

## Goal

Remediate the two currently recorded nanoid findings by moving the actual PostCSS-resolved **3.3.12 -> 3.3.18**, preserving supported 3.x behavior, real CSS tooling, all earlier fixes and truthful dependency evidence.

This is a candidate minimum, not a blanket declaration of security. Refresh official source/advisories and all installed parent ranges before editing. Do not use a broad upgrade, add an unused root dependency, migrate to Nano ID 5, or replace a caller API to force compatibility.

## 1. Source and dependency boundary

Record the entry SHA and dirty paths. The reviewed checkpoint is `1e76b42755bfe6f827905d465ec1e49bc461f8d0` on `audit/hosted-proof-20260922`. Preserve subsequent legitimate local work.

The supplied snapshot has one selected nanoid version (3.3.12), reached from PostCSS 8.5.14. Upstream PostCSS 8.5.14 declares `^3.3.11`; confirm the exact installed manifest and every relevant peer-context resolution, including Vite/Vitest/Tailwind entry paths. Distinguish secure, non-secure, async, browser, CommonJS and ESM imports actually used from API branches tested only for the advisory.

Use the smallest reproducible dependency/lock update. Try the ordinary targeted resolution when appropriate. If it cannot move the leaf, a narrowly documented **postcss@8.5.14>nanoid:3.3.18** override is an available option after range proof. All unrelated package versions and importers should remain unchanged unless an unavoidable graph movement is explicitly justified.

## 2. Artifact and installed identity

Record exact official npm source, retrieval time, version, engines/exports, package byte count, locked SRI, SHA-256 and actual license/notice evidence. Inspect the tarball without running scripts and without unsafe extraction. No floating source or unrelated fork.

A clean frozen installation must resolve 3.3.18 from each actual PostCSS parent context, not only from the repository root. Compare the consumed package metadata and source files with the verified archive. The package remains `npm/nanoid@3.3.18` in inventories, SBOMs and advisory requests.

## 3. Actual caller compatibility

PostCSS's published Input source calls `nanoid/non-secure` with a constant 6 when there is no filename. Verify that the installed parent matches this source before relying on it.

Test actual PostCSS Input/parse/process behavior with tiny synthetic CSS:

- anonymous input retains its supported `<input css ...>` identifier shape, six-character body and correct `.from`/diagnostic associations;
- an explicit source filename remains the source identity rather than being replaced by a random label;
- CSS text, Unicode, positions, error location and small source-map associations are preserved;
- a simple real plugin transform produces independent expected CSS, and a no-op transform preserves supported content;
- several anonymous inputs do not accidentally share one cached constant label, but do not claim collision resistance or cryptographic quality from a small sample;
- do not compare exact random bytes across dependency versions or freeze global Math.random/crypto in production.

Exercise real installed code, not a copied approximation of PostCSS. Its fixed-positive-size caller does not prove the negative/zero advisory input is application-reachable. No business transaction IDs, customer IDs, secrets or historical records should change.

## 4. Narrow security regressions

Use actual authentic old/new packages with the same final corrected harness. Keep vulnerable cases in individually supervised children; never invoke a potentially infinite loop in the main test process.

Targeted IDs:

- **GHSA-28wg-ghj8-5hjv**: non-secure `nanoid` / `customAlphabet` negative-size loop; current fixed 3.x range starts at 3.3.16.
- **GHSA-2v37-7h3g-55p8**: custom generators at size zero; current feed's 3.x fixed boundary is 3.3.18.

Candidate 3.3.18 source returns an empty string for the named non-secure nonpositive-size paths and for nonpositive custom-generator invocations. Match actual upstream behavior; do not require every invalid input to throw. Retain and classify any contradicting feed/source result.

At minimum use tiny cases for:

1. non-secure `nanoid(-1)`;
2. non-secure custom alphabet with a negative invocation/default size;
3. secure customAlphabet with default size zero and with a normal positive default overridden by zero;
4. customRandom's equivalent zero-size calls with a finite deterministic **test-only** byte supplier;
5. ordinary positive/default-size direct and custom generators, supported alphabets and output lengths;
6. CJS and ESM package entry compatibility as supported by the actual distribution.

Inventory async/browser branches too. Test a small async case if that branch is part of the published advisory fix or installed use, but do not claim React Native/device verification from a Node test.

Budget: each risky child at most 5 seconds, 96 MiB V8 heap, 512 KiB stack, 64 KiB captured output; fixture inputs should be tiny (ordinary IDs at most 64 characters). Terminate timed-out children and verify owned process/fixture cleanup. These are bounded test conditions, not universal operating-system memory/disk quotas. No high-volume entropy tests, huge allocations or network target.

Do not expand the contract to every malformed alphabet, NaN/fractional size, positive override on a zero-default factory, or hostile randomness callback. Discovered material residuals must be documented rather than hidden or broadly fixed inside this patch.

## 5. Evidence and policy

Before/after collect exact inventories, parent edges, lock delta, fresh scan/advisory records and raw/actionable results. Target the exact IDs, not a hardcoded lower count.

On the supplied unchanged baseline two target removals would imply 23 raw / 21 actionable / 2 reviewed / 0 exceptions, but **fresh feeds determine the measured result**. Do not bake those numbers into enforcement. Any other change must be explained at advisory/package/version level.

Keep package coverage complete; an absent scan query is not remediation. Preserve both SheetJS assessments, exact artifact/provenance and deadline **2026-10-23T00:00:00Z**; the empty exceptions register; policy thresholds; tar, xmldom and all three brace patches. No new applicability rule, risk exception, license approval or severity adjustment.

A useful negative policy proof is replaying the two old-version advisory records through the unchanged real policy evaluator and observing its blocking result. Do not rollback active source or mark unavailable scans as clean.

## 6. Qualification and publication

Add focused checks to mandatory quality rather than leaving them as a review-only script. Preserve 20 brace, 10 XML, 6 tar, vendor/policy/applicability and existing app checks. Run the canonical quality command including actual schema generation/typechecks/builds.

Use explicit staging and existing Cloudflare/Vercel verification-branch safeguards. Commit/push normally, no force push. No Android release, deployment, OTA, native platform actions, external device operations, or live data.

Require on the same final SHA:

- quality success, including focused nanoid checks;
- backend success;
- PostgreSQL success (six mandatory fixtures, zero skips);
- browser success;
- dependency-security fresh scan completed, with exact target delta and unrelated blockers retained.

Security may legitimately remain red. No need to duplicate local full Go/database runs solely for a Node leaf when unchanged mandatory hosted equivalents provide the proof; run additional local checks if the actual diff introduces a dependency requiring them.

## 7. Acceptance matrix

| ID | Required evidence |
|---|---|
| NI01 | Entry/dirty-state classification and complete actual nanoid parent/API inventory. |
| NI02 | Official archive, integrity/license/engine/export checks without install-time execution during inspection. |
| NI03 | Range-compatible minimal resolution/override and exact unrelated-lock preservation. |
| NI04 | Clean frozen install; actual parent-context resolution; consumed package bytes match verified source. |
| NI05 | Real PostCSS anonymous/named Input identity and independent CSS/position expectations. |
| NI06 | Real no-op/plugin/source-map pipeline compatibility; canonical app builds/schema generation intact. |
| NI07 | Positive/default-size nanoid and custom generators, with supported CJS/ESM semantics. |
| NI08 | Bounded negative-size regressions; exact before/after outcomes, no assumed throw semantics. |
| NI09 | Bounded zero-size custom-generator regressions and classified async/browser evidence. |
| NI10 | Child termination, output/fixture bounds and honest cleanup/housekeeping limits. |
| NI11 | Old-version policy negative and exact fresh target advisory-ID delta; coverage remains complete. |
| NI12 | Preserved SheetJS/tar/XML/brace/policy/exception hashes; all required focused tests stay mandatory. |
| NI13 | All five hosted workflows on one SHA: four successes plus complete fresh policy result. |
| NI14 | One current packet and compact ZIP, exact diffs, source/provenance/NI matrix, tracker/progress and manifest. |

Do not award a pass for a missing dependency/skip or change the acceptance criteria just to match observed output. Report a concrete independent limitation where tooling or true scope prevents a check.

## 8. Non-goals and return

Keep PostCSS/Vite themselves, JS-YAML, Browserslist, Go/chi, rgbcolor, OpenPGP, password parsing, A14 imports, business concurrency and release controls out of this slice. No routine authorization request.

Return A34e8 implemented / locally+hosted verified / ChatGPT review pending, not parent closure. Keep denied installation-copy deletions untouched; preserve local review-only material rather than blanket staging or cleanup.
