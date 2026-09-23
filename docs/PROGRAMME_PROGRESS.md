# Programme progress — A34e1 accepted; A34e2 underway

Status summary only; docs/AUDIT_COVERAGE_TRACKER.md is the sole A01–A44 tracker.
Current packet: A34E2-XCRYPTO-20260923-01. AUTH-MANDALIKA-20260919-01.

CG-A34E1-GO-REMEDIATION-20260922-01-R1 scoped-accepts A34e1 at feb0048.
19 accepted bounded milestones span 11 findings. All 44 remain tracked
(8 P0 / 32 P1 / 3 P2 / 1 P3); A31 alone is resolved; 0/8 P0 parents and
0 release gates close. Full A34/T29 and A38/T33 remain open.

A34e2 implements x/crypto v0.56.0 with eight required module-graph movements.
Capture a deterministic actual pre-upgrade Argon2id hash; prove legacy/new
password verification, rejection, encoding/parameter and malformed-parser
compatibility. No credential migration or rehash. The existing parser's numeric
version and zero-cost-parameter limitations are characterized, not repaired.

Fresh scans reduce blocker records69 ->48:21 blocking x/crypto records and
29 known-fixed advisory records disappear; no new blocker.19 password tests
and510 ordinary Go PASS events complete; six opt-in skips are separately
covered by all six PostgreSQL18.3/race fixtures,142 named PASS/zero skips and
verified cleanup. Hosted same-SHA verification is pending.
GO-2026-5932 is no-fixed OpenPGP and stays visible under unchanged policy.
chi ingress trust and rgbcolor owner/legal approval remain unresolved; no
exceptions. After ChatGPT review of A34e2, return to approved official
SheetJS 0.20.3 vendoring. No unrelated dependency/business/deployment work.
Historical stopped DB/cache cleanup stays untouched.
