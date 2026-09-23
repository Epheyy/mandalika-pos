# A34e3 — SheetJS vendoring and supply-chain coverage

Scope: **A34E3-SHEETJS-20260923-01**. Technical direction was already approved in
Q-A34e-02; this defines its bounded execution, not a new licence/risk waiver.

## Required result

Replace the Backoffice registry `xlsx@0.18.5` dependency with the exact official
**SheetJS CE 0.20.3** tarball, stored in the repository and installed by a relative `file:`
reference. Preserve current workbook exports and keep the artifact fully visible to the
security gate.

Official version-specific artifact:
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`

Preferred layout:
- `vendor/sheetjs/xlsx-0.20.3.tgz`
- a small adjacent provenance document with source, retrieved-at time, byte size, SHA-256,
  lockfile integrity and package/license identity.
- Backoffice dependency `file:../../vendor/sheetjs/xlsx-0.20.3.tgz`, adjusted only if the
  actual workspace layout requires it.

The vendor archive is a deliberate source dependency, unlike review ZIPs. Its exact path
may be explicitly staged after provenance/content checks; do not relax global archive or
secret exclusions or use blanket staging.

## Identity invariant

These must agree:

**declared dependency -> pnpm locked artifact -> local tarball hash -> package.json
name/version -> installed module -> exported workbook -> inventory/SBOM/advisory identity.**

Retain npm ecosystem identity `xlsx` / `0.20.3` for advisory lookup, while separately stating
that distribution comes from the vendor, not an npm-published release. A `file:` locator is
not a semantic package version. Record the digest/distribution source alongside the purl.

## Safe archive handling

Inspect the downloaded archive without executing its contents. Validate one unambiguous
package manifest and the expected name/version; preserve actual LICENSE/NOTICE files.
Verify pinned bytes before install and scan. Resolve the legitimate workspace-relative path
inside the repository vendor root, rejecting escapes, unexpected symlinks, ambiguous package
roots, oversized input and unsafe archive members. Do not extract to arbitrary paths.

A computed checksum pins reviewed bytes; it is not a publisher signature. Record any actual
publisher authentication evidence without inventing a signature or independently published
checksum. Do not bypass TLS or use an unapproved mirror/fork when download fails.

## In scope

Tarball/provenance, precise package/lock updates, file-dependency inventory/SBOM/advisory/
license/PR-delta support, scanner negative tests, current XLSX exporter/reader compatibility,
quality and hosted verification, canonical status updates.

## Out of scope

A14 stock-count imports; broad npm or Go upgrades; chi ingress; rgbcolor approval; OpenPGP
policy exceptions; stored-hash parser redesign; A27/A28 accounting; historical queue/receipt
rewrites; deployment, Android signing, OTA or live-data operations.

## Result standard

Prove removal of the affected registry artifact while retaining the vendor artifact's
coverage. Do not promise an exact blocker reduction: advisory feeds can change or conflict
with vendor-specific affected ranges. Preserve unresolved contradictory evidence for review,
and keep dependency-security red when blockers remain. No silent omission, policy downgrade,
package renaming or automatic exception may manufacture success.
