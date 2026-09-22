# A34e initial dependency/security gate policy

Policy ID: **DEPSEC-INITIAL-20260922**

This is the technical baseline for A34e. It is deliberately conservative on exploitable
security issues and deliberately non-prescriptive on legal license-family compatibility.

## 1. Security blockers

A finding blocks CI/release promotion unless it has a checked-in, unexpired reviewed
exception when any of the following is true:

1. The dependency is identified as malicious, compromised, or known-exploited in a
   runtime/build path, regardless of nominal severity.
2. A **Critical** or **High** vulnerability affects a dependency installed for runtime,
   build, packaging, or CI execution.
3. `govulncheck` identifies a vulnerable Go symbol as actually called/reachable by the
   source being built. Because `govulncheck` JSON output can exit zero even with findings,
   the policy wrapper must parse its result rather than trust JSON-mode process status.
4. A production/runtime vulnerability has no usable severity or reachability classification:
   it remains blocking until classified or explicitly excepted.

Moderate/Low findings are initially report-only unless evidence shows known exploitation,
malicious package compromise, or a direct high-impact reachable path; in that case they
are promoted to blocker by evidence, not by label alone.

## 2. Scope treatment

- `runtime`: shipped/executed application dependency.
- `build`: dependency executed during install/build/codegen/packaging/CI.
- `development-only`: tooling not executed to produce or validate release artifacts.

Build dependencies are not automatically considered harmless: a compromised build tool can
alter the produced artifact.

## 3. JavaScript / workspace baseline

Use a pinned, machine-readable advisory source for the complete pnpm lockfile and preserve
runtime vs development scope. GitHub dependency review may enforce PR deltas, but it does
not replace the full baseline scan of the current lockfile.

Initial PR delta policy:
- fail on **High** or **Critical** vulnerability introductions in runtime/development/unknown
  scopes;
- fail on known malicious/compromised packages independent of severity;
- do not silently allow an advisory because it existed in the baseline.

## 4. Go baseline

Pin `govulncheck` and scan the backend source with the same Go version family used by CI.
Retain machine-readable findings and call stacks/reachability classification.

Do not treat module-present-but-unreachable and symbol-called findings as equivalent.
Called/reachable findings block until fixed or excepted.

## 5. License policy

Normalize license evidence to SPDX identifiers/expressions when possible.

The **initial automated license blocker is classification completeness**, not a guessed
copyleft policy:

Block until reviewed/excepted when a shipped/runtime or executed-build dependency has:
- missing license evidence;
- `NOASSERTION` / unknown / unparseable expression;
- a custom `LicenseRef-*` or equivalent whose actual terms have not been reviewed;
- a referenced license file that is missing from the package evidence;
- an explicitly proprietary/unlicensed term with no existing project approval.

Do **not** automatically deny GPL/LGPL/AGPL/MPL/CDDL or any other named license family just
because of its name. Whether those licenses are acceptable for this application's use and
distribution is an organizational/legal policy decision. Report them with the exact SPDX
expression and package scope for review.

The checked-in policy may later contain an explicit `deny_licenses` list after that policy
exists. Start with no invented deny family.

## 6. Exceptions

Never silently grandfather a blocker.

A vulnerability exception must contain at least:
- advisory/finding ID;
- ecosystem/package and affected version/range;
- dependency scope;
- reachability classification;
- reason and compensating control;
- accountable owner/reviewer;
- created date;
- explicit expiry date;
- remediation target/reference.

Expired exceptions fail the gate. Permanent security exceptions are not valid.

A license review/exception must contain:
- package/version;
- exact SPDX expression or captured custom terms identifier;
- scope/distribution context;
- reviewer/decision;
- review date;
- review-by date when continued review is required.

Do not invent an approval for a license merely to make CI green.

## 7. Baseline evidence

A34e must produce, tied to the exact Git SHA:
- complete direct/transitive Node dependency inventory from the pnpm lockfile;
- complete Go module inventory;
- standard SBOM(s) in SPDX or CycloneDX format;
- vulnerability/advisory results with source/date;
- Go reachability results;
- license inventory with exact expressions and unknowns;
- runtime/build/development classification;
- an exceptions register, even if empty;
- deterministic policy result.

Do not put credentials, registry tokens, or private source contents into uploaded scan
artifacts.

## 8. Enforcement boundary

If the baseline contains blockers:
- do not auto-add exceptions;
- fix a clearly safe dependency update when it is routine and all accepted gates remain
  green;
- if remediation requires a major behavioral/dependency architecture change, return the
  exact evidence and continue independent non-dependent work.

A34e does not close A37 secret-scanning/history policy, A13/A42 business concurrency,
or A35 signed-artifact provenance.
