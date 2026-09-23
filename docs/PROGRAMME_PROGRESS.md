# Programme progress — A34e2 accepted; A34e3 locally verified

Authority: AUTH-MANDALIKA-20260919-01. Current packet: A34E3-SHEETJS-20260923-01.
The canonical docs/AUDIT_COVERAGE_TRACKER.md remains the only finding tracker.

CG-A34E2-XCRYPTO-20260923-01-R1 accepts A34e2 at 76cc02b. There are now 20
accepted bounded milestones across the same 11 findings. All 44 findings remain;
A31 alone is resolved. Zero of eight P0 parents and zero release gates close.
Full A34/T29, A38/T33 and A14 remain open.

A34e3 vendors official SheetJS 0.20.3 with pinned bytes and Apache-2.0 evidence,
retains actual xlsx identity in inventory/SBOM/advisories, hashes vendor inputs,
and checks dependency/distribution deltas. Eight old exclusive transitive package
nodes disappear because the new manifest declares no consumer dependencies;
this is a graph change, not proof about all embedded code or vulnerabilities.

Local clean frozen install and quality pass; 22 vendor safety/coverage tests and
26 required browser scenarios pass. Real XLSX downloads preserve 51/201/1000
rows, filters/totals, Unicode, identifiers/date/number types, formula-like text,
single/empty behavior and later-page failure disablement. Hosted proof pending.

Fresh baseline and after scans both report 48 blockers. The two SheetJS advisories
still match vendor 0.20.3 through open-ended OSV ranges; raw evidence and publisher
fixed-version claims are retained for applicability review. No exception or policy
change. chi ingress, rgbcolor legal choice, OpenPGP policy and password-parser
hardening remain separate. Historical stopped cleanup is untouched.
