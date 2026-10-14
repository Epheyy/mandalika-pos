# A36 backup and DR research: decision document (2026-10-15)

Status: **research, nothing built.** Owner inputs (HANDOFF, Decisions 2026-10-14):
- Production leaves the Neon free tier.
- Backups are kept for 1–2 years.
- Acceptable data loss is "< 3%".

Audit gaps (sweep 2026-10-14, A36):
- No scheduled backup and no off-host copy.
- Restore has no guardrails: it prints the target URL with credentials, uses `--clean` without `-1`, and has no safe-target check.
- The drill checks 4 row counts only and is not reconciled.
- RPO and RTO are undocumented.

Prices were checked on 2026-10-15 (USD). Rp figures use **Rp 17,923/USD** (Bank Indonesia spot via Katadata, 12 Oct 2026 [S16]).

## 1. Best practice (POS / retail transactional DB)

| Practice | What it means here | Source |
|---|---|---|
| **Continuous WAL + base backups (PITR)** | Restore to any second inside a window. This is the main fix for the most common incident: a bad migration, deploy or operator error. | PostgreSQL docs [S1] |
| **Logical dumps (`pg_dump -Fc`)** | Portable across providers and major versions, and can restore a single table. This is the copy you keep for years and the one that survives losing the provider. It is a snapshot, so its RPO equals the dump interval. | [S2] |
| **3-2-1 / off-provider copy** | At least one copy outside the primary provider and account, so an account lock, compromise or vendor failure does not take the backups too. | CISA [S3] |
| **Immutability** | A write-once retention lock, and a backup writer that can create objects but not delete them. This defends against ransomware and fat fingers. | GCS Bucket Lock [S4] |
| **Encryption** | At rest by default. Encrypting client-side before upload means a leaked bucket cannot be read. Plan who holds the key for the full 2 years. | [S4] |
| **Retention ladder (GFS)** | Dailies for about 35 days and monthlies for 12–24 months. Match the storage class minimums: Nearline 30 days, Coldline 90, Archive 365 [S9]. | [S9] |
| **Restore drills with reconciliation** | A backup only counts once it has been restored somewhere disposable. Check business invariants such as money, stock and ledgers, not just row counts. | Google SRE "Data Integrity" [S5]; A36 acceptance |
| **Monitor backup age, not just job status** | Alert when the newest good backup is older than about 26 hours. Silent failure is the classic way backups fail. | [S5] |
| **Migration safety** | Migrations are forward-only (RUNBOOK). Mark a restore point or snapshot immediately before each migrating deploy. | RUNBOOK |

## 2. "< 3%" as RPO/RTO, and what the tablet outbox does and doesn't cover

**Working translation (owner to confirm):** lose at most 3% of one trading day's server writes. For a day of about 12 hours, that is **about 20 minutes of data**.

**Verified repo fact: tablets do not keep sales after they sync.**
- When the server acknowledges a batch, `SyncEngine` calls `outbox.prune()`, which drops every acked row (`packages/sync/src/engine.ts:947`, `packages/sync/src/outbox.ts:473-478`).
- The journal store turns the missing keys into `deletes` (`packages/sync/src/journalOutboxStore.ts:204`).
- The native SQLite journal then deletes those rows (`OutboxJournalPlugin.java` `apply`, the `d.delete("outbox", "idempotency_key = ?")` loop).

So the outbox protects only **unsynced** sales. If the server is restored to a point before a sale was acked, that sale is gone from both the server and the tablet, and nothing will resend it.

**What the outbox never covers**, because these exist only on the server:
- Backoffice edits: products, prices, promos, settings.
- Customers created or edited in the backoffice, and merges.
- The loyalty ledger and manual adjustments.
- Stock receipts, transfers and counts.
- Settlements and review resolutions.
- Device registrations (`pos_devices`, migration 0052).

**Proposed targets, by incident class:**

| Incident | Likelihood | Recovery path | RPO | RTO |
|---|---|---|---|---|
| Bad migration, deploy or operator error | Highest | Provider PITR to just before the event, plus a pre-migration restore point. **Rewinding main also loses every good write made after the restore point.** Neon keeps the pre-restore state as a `<branch>_old_<timestamp>` branch [S7]. During trading hours, prefer restoring into a side branch and fixing forward; otherwise, after a rewind, harvest the later orders, payments and stock movements from `_old`, keyed on idempotency keys. | Restore point: seconds. **Net loss = the detection window, unless harvested.** | **≤ 1 h** |
| Corruption found late (after the PITR window) | Low | Restore a dump into a side DB, then repair selected tables | Last good daily | 1 day (repair job) |
| Provider, account or region loss | Rare | Restore the newest off-host dump onto a new host | **24 h with daily dumps. This breaks 3%.** | **≤ 4 h**, hard cap of one trading day |

RTO can be generous because tablets keep selling offline. The A33 default is a full trading day with no degradation.

**The gap in the last row is structural.** Neither Neon nor Cloud SQL lets you ship WAL to another provider, so more frequent dumps cannot get you near 20 minutes. Two ways to close it:
- **(a) Accept it.** Provider loss is rare, and backoffice edits are low-volume and can be re-entered.
- **(b) Keep a tail of acked sales on each tablet** (3–7 days), and re-push it after a restore ("re-sync since T").
  - Server idempotency (`processed_keys` / `operation_receipts`) should make the replay safe, but A36 notes replay-after-restore is untested.
  - This touches the **offline outbox**, so it needs Opus review and an APK release.
  - It makes sales RPO effectively zero in every scenario, **including a PITR rewind of main after a bad deploy** (the most likely incident). Server-only state still has the 24 h RPO in a provider loss.

## 3. Options and pricing (checked 2026-10-15)

**Managed Postgres.** Cloud Run runs in Jakarta (asia-southeast2).

| Option | Region near Jakarta | PITR / backups | Est. monthly for this scale* |
|---|---|---|---|
| **Neon Launch** [S6][S7] | Singapore `aws-ap-southeast-1`. No Jakarta region [S8]. | PITR ("instant restore") default 1 day, **max 7 days**, history billed at $0.20/GB-mo. Scheduled snapshots: daily, weekly or monthly, kept ≤ 35 days, $0.09/GB-mo. 100 manual snapshots that never expire. No SLA. | Compute $0.106/CU-h. Always-on, averaging about 0.33 CU, ≈ 240 CU-h ≈ $26. Storage $0.35/GB-mo. **≈ $30–45 (Rp 0.55–0.8 jt)** |
| **Neon Scale** [S6][S7] | Same | PITR **up to 30 days**, uptime SLA, IP Allow, PrivateLink | $0.222/CU-h ⇒ **≈ $60–90 (Rp 1.1–1.6 jt)** |
| **Cloud SQL PG Enterprise** [S10][S11][S12] | **Jakarta**, the same region as Cloud Run | PITR logs **up to 7 days** (Enterprise Plus: 35). Automated backup retention up to 365 standard; "enhanced backups" go up to 10 years with an enforced retention lock (Backup and DR vault). | Official us-central1 rates: $0.0413/vCPU-h + $0.007/GiB-h, so 1 vCPU / 3.75 GB = **$49.3/mo**. That matches Bytebase's Iowa figure of $49, which makes Bytebase's **Jakarta $64** credible [S13]. Add SSD at $0.17/GB-mo (us-central1; Jakarta higher) and backups at $0.08/GB-mo. **≈ $70 single-zone, ≈ $135 HA.** Shared-core `db-f1-micro` / `g1-small` are not covered by the SLA and have 0.6–1.7 GB RAM, so they are not production options. |
| **AlloyDB** | Jakarta | — | Out of scale for this workload (built for much larger OLTP and analytics). Not priced. |
| **Supabase Pro** [S14] | Singapore (no Jakarta) | Daily backups for 7 days. PITR is an add-on: **$100/mo for 7 days** ($200 for 14, $400 for 28), needs at least Small compute, worst-case RPO 2 min. | $25 + Small compute (net about $5) + PITR $100 ≈ **$130** |
| **Crunchy Bridge** [S15] | Asia regions not listed on the pricing page (unverified) | Daily + WAL backups and PITR included. Retention not stated. | Hobby-2 $35, Standard-4 $70, storage $0.10/GB. The page footer points to Snowflake's privacy policy (the product is now Snowflake-owned), which is a direction risk. |

\*Sizing assumptions: 30k–500k customers and tens of outlets give a DB of about 2–10 GB within 2 years. Production compute is assumed always-on (scale-to-zero off), consistent with the Neon stale-connection notes.

**Off-host target: GCS.** Neon runs on AWS, so GCS is off-host **and** off-provider. If the DB moved to Cloud SQL, use a separate GCP project and billing account plus a lock, or accept a same-provider copy.

- **Storage in Jakarta**, per GB-month: Standard $0.023, Nearline $0.016, Coldline $0.006, Archive $0.0025. These came from a search snippet [S9b] and match the 2022 archived page. Confirm them in the pricing calculator, because the live page only rendered default-region rates.
- **Minimum storage duration:** Nearline 30 days, Coldline 90, Archive 365.
- **Retrieval fees:** Nearline $0.01/GB, Coldline $0.02, Archive $0.05 [S9].
- **Ladder at about 2 GB per compressed dump:**
  - 35 dailies in Standard or Nearline ≈ $1.1–1.6.
  - 24 monthlies in Archive ≈ $0.12.
  - Don't put dailies in Coldline: the 90-day minimum means early-delete charges on every one.
- **Bucket Lock covers the whole bucket** [S4]. Use two buckets, `…-daily` (35 days) and `…-monthly` (730 days), or Object Retention Lock per object. Locking is **irreversible**.
- **UU PDP:** a locked 2-year copy cannot honour a deletion request until it ages out. Document that in the privacy policy.
- **Dump job:** a Cloud Run Job running 1 vCPU × about 10 min/day ≈ 18k vCPU-s/mo, inside the 240k vCPU-s jobs free tier [S12b], so about $0. Cloud Scheduler gives 3 free jobs per billing account, then $0.10/job/mo [S12c].
- **Check before relying on it:** Neon's public network transfer allowance for about 60 GB/mo of dump reads.

## 4. Recommendation (best value)

**Stay on Neon, move to Launch, and add our own locked off-provider dumps on GCP.** Upgrade to Scale only if the owner wants a PITR window longer than 7 days or a contractual SLA. Move to Cloud SQL Jakarta only if data residency requires it (open question 1).

- **Neon Launch:** PITR history set to **7 days** (this covers a bad change found after a weekend), daily scheduled snapshots kept 35 days, and a manual snapshot before every migrating deploy.
- **Daily encrypted `pg_dump`** to a GCS Jakarta bucket with a lock, plus a monthly copy kept 24 months in Archive.
- **Estimated cost:** about **$32–50/mo ≈ Rp 0.6–0.9 jt** (Neon $30–45, GCS < $2, job and scheduler about $0). On Scale: about $65–95.

**What gets built in the repo:**

| # | Item | Size |
|---|---|---|
| 1 | **Backup job.** Container with a `pg_dump` client pinned to at least the server's major version (Neon's version is unknown; local is PG 16). Steps: `-Fc` dump → `age` encrypt to the owner's public key → upload → manifest (sha256, size, migration version, key table counts). Exits non-zero on any failure. Runs as a Cloud Run Job from Cloud Scheduler at 02:00 WIB. Its service account has **objectCreator only**, no delete. | 1.5 d |
| 2 | **Buckets.** Script (gcloud, in `scripts/`) for the daily and monthly buckets: retention policy, lifecycle delete, soft-delete (versioning is not needed once the lock is on). The lock is applied only after a trial month, with the owner's OK. | 0.5 d |
| 3 | **Pre-migration restore point.** `deploy-backend.sh` creates a Neon snapshot (API) or records the timestamp when a release adds migrations. | 0.5 d |
| 4 | **Fix `db-restore.sh` guardrails.** Refuse non-disposable targets unless explicitly confirmed, mask credentials, `-1 --exit-on-error`, decrypt step. | 0.5 d |
| 5 | **Restore drill and reconciliation.** Restore into a throwaway Neon branch or local PG, then check:<br>• order totals = payments<br>• stock = movements<br>• points ledger = balances<br>• `operation_receipts` / `processed_keys` coherent<br>• `pos_devices` codes unique (a restored device table could re-issue an existing tablet's code and duplicate receipt numbers)<br>• refresh tokens in Redis outliving a DB rollback<br>• stock overstated by pruned sales lost after the restore point<br>Monthly automated run; quarterly manual PITR drill that includes the "harvest post-restore-point writes from `_old`" step. | 2 d |
| 6 | **Backup-age alert.** Cloud Monitoring alert on job failure, plus "newest object older than 26 h", emailed to the owner. | 0.5 d |
| 7 | **RUNBOOK rewrite.** Incident matrix, Neon PITR steps (side branch first; harvest from `_old` after a rewind), dump restore, tablet handling, RPO/RTO. | 0.5 d |
| **Core** | Items 1–7 | **≈ 6 d** |
| 8 | *Optional (needed if 3% must hold after a rewind or a provider loss):* tablet acked-sales tail of 3–7 days, a backoffice "re-sync since T" command, and a server replay-after-restore test. Touches the outbox: Opus review and APK. | +2.5–3 d |

## 5. Open questions for the owner (only the ones that change the choice)

1. **Must customer and sales data stay in Indonesia?**
   - If yes: Cloud SQL Jakarta, about $70–135/mo, plus a migration.
   - If Singapore is acceptable: Neon.
2. **After a restore (a rewind after a bad deploy, or a provider loss), how many hours of synced sales can staff re-enter by hand?**
   - If "none" or "under about 20 minutes": build item 8.
   - Otherwise: PITR, the `_old` harvest and daily dumps are enough.
3. **Is 7 days of PITR enough** (Launch), or do you want up to 30 days plus an SLA (Scale, about +$30–45/mo)? The deciding question is whether bad data would always be noticed within a week.
4. **Encryption key holder and lock.** OK to encrypt dumps with a key that you hold (with an offline copy) for 2 years? OK to lock retention irreversibly at **24 months** (or 12)?

Also needed (read-only, not a decision): confirm the Neon project's region and Postgres major version.

## Sources (all accessed 2026-10-15)
- [S1] PostgreSQL, Continuous archiving and PITR: https://www.postgresql.org/docs/current/continuous-archiving.html
- [S2] PostgreSQL, SQL dump: https://www.postgresql.org/docs/current/backup-dump.html
- [S3] CISA, Data backup options (3-2-1): https://www.cisa.gov/sites/default/files/publications/data_backup_options.pdf
- [S4] GCS Bucket Lock / retention policies: https://cloud.google.com/storage/docs/bucket-lock
- [S5] Google SRE book, "Data Integrity": https://sre.google/sre-book/data-integrity/
- [S6] Neon pricing: https://neon.com/pricing
- [S7] Neon plans; Neon backup & restore (snapshots, schedules, 35-day max): https://neon.com/docs/introduction/plans , https://neon.com/docs/guides/backup-restore
- [S8] Neon regions: https://neon.com/docs/introduction/regions
- [S9] GCS pricing (storage-class minimums, retrieval fees): https://cloud.google.com/storage/pricing ; [S9b] Jakarta per-class rates via search snippet of the same page (matches archive https://web.archive.org/web/20221229152713/https://cloud.google.com/storage/pricing)
- [S10] Cloud SQL pricing (us-central1 rates rendered): https://cloud.google.com/sql/pricing
- [S11] Cloud SQL editions (PITR 7 vs 35 days): https://cloud.google.com/sql/docs/postgres/editions-intro ; backup options (1 yr standard / 10 yr enhanced, retention lock): https://cloud.google.com/sql/docs/postgres/backup-recovery/backup-options
- [S12b] Cloud Run pricing (jobs free tier): https://cloud.google.com/run/pricing ; [S12c] Cloud Scheduler pricing: https://cloud.google.com/scheduler/pricing
- [S13] Bytebase dbcost, Cloud SQL db-standard-1 by region (third-party): https://www.bytebase.com/dbcost/cloudsql/instance/db-standard-1.md
- [S14] Supabase pricing and backups/PITR: https://supabase.com/pricing , https://supabase.com/docs/guides/platform/backups , regions https://supabase.com/docs/guides/platform/regions
- [S15] Crunchy Bridge pricing: https://www.crunchydata.com/pricing
- [S16] Katadata databoks, Rupiah 12 Oct 2026: https://databoks.katadata.co.id/en/market/statistics/32ec67c22c32882/rupiah-exchange-rate-weakens-to-idr-179228-per-us-dollar-monday-12-october-2026
