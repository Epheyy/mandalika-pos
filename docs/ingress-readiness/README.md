# Bounded readiness evidence

This folder supports A34E15C-READINESS-20260929-01. It is not a parallel audit tracker,
an applying cloud plan, an installed-device inventory, or activation approval.
Canonical programme status remains in ../AUDIT_COVERAGE_TRACKER.md.

- READINESS_EVIDENCE.json: dated source/artifact conclusions, 13 existing route IDs,
  four distinct readiness phases and six exact external acquisition requests.
- RD_MATRIX.json: RD01–RD14 task coverage; completion does not mean operational readiness.
- EVIDENCE_INDEX.json: packaged selected evidence hashes, dates, classes and gates.
- inspect_apk.py: bounded non-executing selected APK inspection; unknown flags stay unknown.
- test_inspect_apk.py: fourteen synthetic methods, including malformed/duplicate/unsafe
  inputs and non-disclosure at the actual CLI boundary.

Run only these new local checks from the repository root:

    python -B docs/ingress-readiness/test_inspect_apk.py -v

A trusted owned APK can be inspected with `python -B docs/ingress-readiness/inspect_apk.py
<path>`. This only selects configuration and URL-origin candidates; it does not establish
binary plugin version, current updater state, installation or exhaustive API call paths.
The review bundle contains selected metadata only. APKs, original build-source archive,
partial download and raw developer-network origin stay in the private local evidence
folder; no secret/configuration dump or binary is included. No cleanup denial is retried.

The evidence pass is complete. Resume dependent ingress work with the named external
inputs or materially new evidence, not another architecture/model-only iteration.
