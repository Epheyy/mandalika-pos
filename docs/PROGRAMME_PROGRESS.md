# Programme progress — 2026-09-22

Status summary only; AUDIT_COVERAGE_TRACKER.md is the sole A01–A44 tracker.
Current packet: **A34E-DEPENDENCY-SECURITY-20260922-01**.
Authority: AUTH-MANDALIKA-20260919-01.

44 findings remain: 8 P0, 32 P1, 3 P2, 1 P3. A31/T26 remains the only resolved
parent; 0/8 P0 parents and 0 release gates are closed. There are 17 scoped
ChatGPT-accepted milestones across 10 findings. E38 records A34d acceptance by
CG-A34D-HOSTED-PROOF-20260922-01-R1. A34a quality, A34b Docker/race and A34c
Chromium are hosted-verified at e782c5dfbf3eedefb5d655f6726590dfbea5bf87.

A34e/A38 now has a fresh exact-base inventory, CycloneDX SBOMs, license/advisory
and Go reachability evidence, pinned fail-closed workflow, supplemental npm PR
delta, exact expiring exceptions validator and disposable negative proofs.
The baseline is blocked; no exceptions were created. Narrow JWT/Redis patch
remediation is included. Final commands, same-SHA hosted statuses and residual
choices are recorded in the current review packet; an all-five-green checkpoint
cannot be claimed while dependency findings remain blocking.

Full A34/T29 and A38/T33 stay open. A37 continuous/history scanning, A13/A42
business concurrency, branch protection and A35 APK/OTA provenance remain open.
Earlier business decisions and all prior scoped acceptances remain. Historical
stopped DB/cache cleanup remains recorded and untouched. No deployment, Android
release dispatch, provider/credential or live-data operation belongs to this slice.
