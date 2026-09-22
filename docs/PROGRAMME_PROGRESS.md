# Programme progress — A34e accepted / A34e1 underway

Status summary only. docs/AUDIT_COVERAGE_TRACKER.md is the sole A01–A44 tracker.
Current packet: A34E1-GO-REMEDIATION-20260922-01. AUTH-MANDALIKA-20260919-01.

44 findings remain (8 P0, 32 P1, 3 P2, 1 P3); A31 is the only resolved parent.
18 scoped accepted milestones span 11 findings. No P0 parent or release gate closes.
E40 records CG-A34E-DEPENDENCY-SECURITY-20260922-01-R1 acceptance of A34e as an
implemented, hosted-exercised BLOCKED gate and scoped A38 reachability progress.
The accepted df70dc2 baseline has 76 policy records, not a clean scan. A34/T29 and
A38/T33 remain open. All prior scoped acceptances and business decisions persist.

A34e1 implements pgx 5.9.2 and x/text 0.39.0 with six proven MVS support changes.
Local Go checks and all six isolated PostgreSQL 18.3/race gates pass (142 named
parent/subtests, zero skips, cleanup verified). Fresh policy records fall 76 -> 69;
no new blocker appears. Both target called IDs disappear; two chi called IDs remain.
Same-SHA hosted application workflows and fresh dependency scan are pending.
The dependency job may stay red for unrelated baseline findings; no exception
will be manufactured. Final evidence belongs to the current packet.

chi ingress trust remains unresolved; no version-only fix. Official SheetJS 0.20.3
vendoring direction is approved for a later separate slice. rgbcolor owner/legal
approval remains pending; license/exception state stays unchanged. A37 history
scanning, A13/A42 concurrency, A35 provenance and branch protection remain separate.
Historical stopped DB/cache cleanup is untouched. No deployment/live-data work.
