# A36 backups: build plan (2026-10-15)

Status: **plan, nothing built.** Inputs:
- Research: `docs/plans/2026-10-15-a36-backup-research.md`.
- Owner decisions: `HANDOFF.md` → "Status 2026-10-15" → (e).

Implementer: Sonnet 5.5 (medium). Reviewer tier is given per task (AGENTS.md routing).

## 0. Decisions this plan builds on (owner, 2026-10-15)

- **Neon Launch.**
  - PITR history: 7 days.
  - Daily scheduled snapshots, kept 35 days.
  - A manual snapshot before every deploy that adds a migration.
- **Our own daily `pg_dump`.**
  - Encrypted with `age`.
  - Stored in GCS Jakarta (`asia-southeast2`).
  - Dailies kept 35 days; monthlies kept 24 months under a **retention lock**.
- **RPO.**
  - Normal incidents: ≤ ~20 min.
  - Provider or account loss: ≤ 24 h of server data, accepted.
  - Unsynced tablet sales stay in the outbox either way.
- **UU PDP.** Locked backups cannot honour deletion requests until they age out. This limitation is accepted and must be documented.
- **Not built:** the tablet keep-acked-sales tail (research item 8).

## 1. Facts from the code that shape the design

| Fact | Where | Consequence |
|---|---|---|
| Migrations run when the server boots. | `backend/cmd/server/main.go:43` → `db.Migrate` (`backend/internal/db/db.go:61`) | A `--no-traffic` revision migrates **prod** as soon as it starts. The snapshot must be taken **before** `gcloud run deploy` in `scripts/deploy-backend.sh`, not at promote time. |
| Migrations are embedded `backend/internal/db/migrations/*.sql`, applied in lexical order, and recorded in `schema_migrations(name)`. | `db.go` | "Pending" can be computed from git alone (see P3). No DB access needed at deploy time. |
| Every revision carries the label `commit-sha=<sha>`. | `deploy-backend.sh` `--labels` | The commit of the serving revision tells us which migrations prod already has. |
| `cr_revision_label` only looks revisions up by traffic **tag**. | `scripts/lib/cloudrun.sh` | We need a lookup by revision name, because the serving revision may be untagged. |
| Rollback is traffic-only: `gcloud run services update-traffic --to-revisions $PREV=100`. | `deploy-backend.sh`, `promote-backend.sh` | Rollback never goes through `deploy-backend.sh`, so the snapshot step can never block it. |
| `DATABASE_URL` is Neon's **pooled** endpoint (host contains `-pooler`, PgBouncer in transaction mode). | `RUNBOOK.md:28,179`; `db.go` lock comment | `pg_dump` and `pg_export_snapshot()` need the **direct** endpoint. |
| The backend image is distroless with no shell, and `deploy-backend.sh` ships `git archive … backend`. | `backend/Dockerfile` | The backup job gets its own image under `ops/backup/`, outside `backend/`. |
| Script tests use stubbed seams. | `scripts/lib/require-green-ci.test.sh` | Reuse this pattern. |
| No `*.test.sh` and no shellcheck run in CI today. | `.github/workflows/*` | Add them (P1.6). |
| The CI Postgres gate uses the Docker image `postgres:18.3`. | `scripts/ci/postgres_gate.py:25` | The Neon major is still unknown (P0). The round-trip test uses the Neon major. |
| There is **no stock-movement ledger table.** Stock is current-state only (`outlet_variant_stock`, `warehouse_variant_stock`, `ingredient_outlet_stock`). | migrations grep | "Stock = movements" cannot be reconciled. Instead, stock sums are reconciled against the dump's own snapshot (P4). |
| Every order inserts `processed_keys(idempotency_key, order_id)`. | `backend/internal/service/order.go:569` | Candidate invariant. |
| `point_transactions.balance_after` is a cached running balance. It moves forward only, with no backfill. | `0031_points_ledger.sql` | Candidate invariant, for customers that have ledger rows. |
| `pos_devices.code` is `UNIQUE`. | `0052_pos_devices.sql` | A restore can **re-issue** codes handed out after the restore point. This is a RUNBOOK step, not just a check. |
| `scripts/db-restore.sh` echoes the full target URL, uses `--clean` without `--single-transaction`, and has no target guard. | file | Rewrite it (P4). |
| Local machine has Docker but no `psql`, `pg_dump`, `age` or `shellcheck`. | `which` | Run local tests in Docker containers. |

## 2. Owner actions vs Claude actions (in order)

**Owner (Claude cannot do these):**

1. **O1: upgrade Neon to Launch** (payment).
2. **O2: Neon console, main branch.**
   - Set the restore window (history retention) to **7 days**.
   - Enable **daily scheduled snapshots, 35-day retention**.
   - Claude verifies both read-only afterwards.
3. **O3: create a project-scoped Neon API key** and store it in Secret Manager as `NEON_API_KEY`:
   `printf '%s' '<key>' | gcloud secrets create NEON_API_KEY --data-file=- --project mandalika-pos`
   The key is never pasted into chat.
4. **O4: generate two `age` keypairs offline.**
   - Commands: `age-keygen -o mandalika-backup-primary.key` and `age-keygen -o mandalika-backup-escrow.key`.
   - Keep the primary with you (password manager + USB). Keep the escrow in a separate physical location.
   - Send Claude **only the two public `age1…` lines**.
   - The private keys never go to GCP, the repo, or chat.
5. **O5:** confirm the alert email address for the Monitoring notification channel.
6. **O6:** answer the open questions in §8.
7. **O7: give a go-ahead at execution time** for each step marked ⚑ (anything that writes to GCP or Neon).
8. **O8: decrypt for the drill.**
   - Either run `age -d` yourself, or place the primary key file at a path you give for that session only. It is deleted afterwards (§8 Q2).
9. **O9: confirm the lock** for each bucket, in writing, after the drill passes. This is irreversible.
10. **O10:** add the PDP wording (drafted by Claude in P7) to the real privacy notice, wherever it lives (not in this repo).

**Claude:** all code, tests and docs. Read-only checks (P0). ⚑ steps after O7: provisioning, job deploys, the snapshot step's first live run, drills. Locking happens only after O9.

## 3. Phases

Legend: **[Opus]** = Opus 5.5 review required. **[Haiku]** = Haiku review is enough. ⚑ = needs owner go-ahead at execution time.

### P0: read-only verification spike (0.5 d) [Opus]

No code is written. Results go in a short "P0 facts" block appended to this plan (uncommitted) and in HANDOFF.

1. ⚑ (read-only) **Neon API**, with `NEON_API_KEY` once O3 is done:
   - `GET /api/v2/projects/{id}` → `region_id`, `pg_version`, `history_retention_seconds` (expect 604800 after O2).
   - `GET …/branches` → the main branch id.
   - `GET …/endpoints` → the read-write endpoint id and host.
2. **Neon docs** (neon.com/docs/guides/backup-restore + API reference). Confirm exact paths and payloads for:
   - create a manual snapshot on a branch;
   - list snapshots;
   - delete a snapshot;
   - poll operations (`GET …/operations/{id}`);
   - backup schedule (read).
   **If manual snapshots aren't in the API:** fall back to a restore-point **branch** (`POST …/branches` with `parent_id=<main>` and name `pre-mig-<tag>-<utc>`). Both variants are written behind one function (P3).
3. ⚑ (read-only) **Postgres version on the direct endpoint.**
   - Build the direct URL by stripping `-pooler` from the host of `DATABASE_URL`.
   - Run `SELECT current_setting('server_version_num')` from a `postgres:<major>` container.
   - Never print the URL.
   - Record the major. This becomes `PG_MAJOR`.
   - Also confirm the direct host answers.
   - Run a read-only `pg_dump --schema-only` and grep it for `EXTENSION|PUBLICATION|ROLE|DEFAULT PRIVILEGES` to predict restore problems in vanilla Postgres (see P4).
4. **GCP checks** (read-only):
   - Artifact Registry repos exist (`cloud-run-source-deploy` is used by `--source` deploys).
   - Secrets `DATABASE_URL` and `NEON_API_KEY` exist.
   - Candidate bucket names are free: `mandalika-pos-backup-daily`, `mandalika-pos-backup-monthly`, `mandalika-pos-backup-test`.
5. **Docs**, confirm each:
   - (a) The **maximum metric-absence duration** for a Cloud Monitoring alert. We need ≥ 25 h; otherwise use only the verifier job (P5).
   - (b) Whether `roles/run.invoker` on a job includes `run.jobs.run` for Cloud Scheduler. Otherwise use a job-scoped custom role.
   - (c) Whether a **locked** retention policy places a **lien on the GCP project** (blocks project deletion).
   - (d) That a JSON API media upload with `ifGenerationMatch=0` needs only `storage.objects.create`.
   - (e) Current Cloud Monitoring alerting price per condition.

Exit: `PG_MAJOR`, Neon IDs, snapshot API shape and the a–e answers are written down. Any surprise goes back to the owner before P1.

### P1: backup job (code, tests, dry-run, CI) (1.5 d) [Opus]

Files to **create**:

**`ops/backup/Dockerfile`**
- `ARG PG_MAJOR` (from P0), then `FROM postgres:${PG_MAJOR}-bookworm`, pinned by digest.
- `apt-get install age curl jq ca-certificates openssl`, then clean up apt lists.
- Copy `backup.sh`, `lib.sh`, `reconcile.sql` and `age-recipients.txt`.
- `USER postgres`, `ENTRYPOINT ["/usr/local/bin/backup.sh"]`.
- No gcloud SDK: uploads go through the GCS JSON API with a metadata-server token. That keeps the image small and needs only `objects.create`.

**`ops/backup/age-recipients.txt`**
- The two public keys from O4, one per line, with a comment header.
- This is public material, safe to commit.
- The job refuses to run with fewer than 2 `age1` lines.

**`ops/backup/lib.sh`** (pure functions, sourced, no side effects at source time):
- `direct_url_from_pooled URL`: strips `-pooler` from the host. Fails if the host has no `-pooler`, unless `BACKUP_DB_URL_IS_DIRECT=1`.
- `mask_url URL` → `scheme://user:***@host/db`.
- `pg_major_of_num SERVER_VERSION_NUM` → major.
- `require_same_major SERVER CLIENT`: fails on **any** mismatch, with a message telling you to rebuild the image with the new `PG_MAJOR`.
- `object_base UTC_STAMP EXECUTION_ID` → `mandalika-YYYYMMDDTHHMMSSZ-EXECID`.
- `daily_prefix WIB_DATE` → `daily/YYYY/MM/DD/`.
- `monthly_prefix WIB_DATE` → `monthly/YYYY/MM/`.
- **All folder dates and the monthly decision use the WIB date** (`TZ=Asia/Jakarta date`). UTC appears only in the timestamp inside the object name. Reason: the 02:00 WIB run on the 1st is 19:00 UTC on the last day of the previous month, so UTC prefixes would file the November monthly under October and break the verifier.
- `is_monthly_run WIB_DAY FORCE_MONTHLY` → true when the day is `01` or `FORCE_MONTHLY=1`.
- `manifest_json ...`: builds the plaintext manifest with `jq -n`.

**`ops/backup/reconcile.sql`**
- One SQL file that prints a single JSON object:
  - `migration_head` = `max(name)` from `schema_migrations`;
  - `row_counts` per user table;
  - `orders_by_status` {count, `sum(total)`};
  - `sum(quantity)` for each stock table (`outlet_variant_stock`, `warehouse_variant_stock`, `ingredient_outlet_stock`; check column names);
  - `sum(points)` from `customers`.
- Used by `backup.sh` and by `db-drill.sh`. Using the same SQL on both sides is what makes exact equality possible.

**`ops/backup/backup.sh`**, the job entrypoint:

1. **Config.**
   - `DATABASE_URL`: injected by Cloud Run from the secret.
   - `BACKUP_SINK=gcs|local`.
   - `BACKUP_LOCAL_DIR` (local sink).
   - `DAILY_BUCKET`, `MONTHLY_BUCKET`.
   - `FORCE_MONTHLY`.
   - `MAX_DUMP_BYTES` (default 600 MB; the job uses in-memory `/tmp`, so this is sized against job memory).
   - `DRY_RUN=1`: resolve config, connect, check the version, print planned object names, then exit 0 without dumping.
   - `set -euo pipefail`, `umask 077`, and `trap` cleanup of the work dir.
2. Build the direct URL. Check the version with `require_same_major` (client = `pg_dump --version`, server = `server_version_num`).
3. **Consistent snapshot.**
   - Start a `psql` coprocess (`coproc`) on the direct URL: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();`.
   - Run `reconcile.sql` in that **same** session. Also capture `now()` as `snapshot_at`.
   - Then, while the session stays open, run `pg_dump -Fc --no-owner --no-acl --snapshot=ID -f "$WORK/db.dump" "$DIRECT_URL"`.
   - `COMMIT` and close the coprocess.
4. `pg_restore -l "$WORK/db.dump" >/dev/null`. This is the plaintext integrity check, done **before** encryption.
5. **Encrypt.**
   - `age -R age-recipients.txt -o db.dump.age db.dump`.
   - Encrypt the reconcile JSON the same way → `reconcile.json.age`. It holds money and stock totals, so it is never stored in plaintext.
   - `rm` the plaintext files.
   - Fail if the size exceeds `MAX_DUMP_BYTES`.
6. **Manifest** (plaintext, no PII or money):
   - object names, sha256 and size of each `.age` object;
   - `snapshot_at`;
   - server and client versions, migration head, image `COMMIT_SHA` (build arg), `CLOUD_RUN_EXECUTION`.
7. **Upload** (`gcs` sink): `curl --fail` to the GCS JSON API.
   - Request: `POST https://storage.googleapis.com/upload/storage/v1/b/BUCKET/o?uploadType=media&name=OBJ&ifGenerationMatch=0`.
   - Token: from the metadata server `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` (header `Metadata-Flavor: Google`).
   - Send the body with `-X POST -T FILE` (streams from disk; `--data-binary @FILE` would load the whole file into memory on top of the tmpfs copy).
   - Pass the bearer header to curl via a header file read from stdin or a process-substitution fd (`-H @FILE`), never as an argv string, so it doesn't show in `ps` output.
   - After upload, compare the response's `md5Hash` with a local `openssl md5 -binary | base64`.
   - Order: dump → reconcile → **manifest last**. A present manifest means the backup set is complete.
   - Monthly run: upload the same three files to `MONTHLY_BUCKET` under `monthly_prefix`. This is a direct upload, not a server-side copy, because the writer has no read access.
   - `local` sink: same object names under `BACKUP_LOCAL_DIR`, and refuses to overwrite.
8. **Success log.** Print exactly one structured JSON line to stdout:
   `{"severity":"INFO","event":"BACKUP_OK","bucket":...,"object":...,"bytes":...,"monthly":bool}`.
   Any failure exits non-zero with `{"severity":"ERROR","event":"BACKUP_FAILED","step":...}`.
   No URLs or secrets are ever logged.

**`ops/backup/backup.test.sh`**
- Seam-stub tests in the `require-green-ci.test.sh` style, covering:
  - pooled→direct conversion, including the no-`-pooler` refusal;
  - `mask_url` (no password in output);
  - major mismatch fails (16 vs 17, 18 vs 17), match passes;
  - object naming and prefixes;
  - `is_monthly_run`: day 01, day 02, forced;
  - WIB vs UTC boundary: a run at 2026-11-01T02:00 WIB (2026-10-31T19:00Z) gives `daily/2026/11/01/` and `monthly/2026/11/`, and counts as monthly;
  - fewer than 2 recipients refuses;
  - the upload seam getting an md5 mismatch fails;
  - the upload order puts the manifest last;
  - `DRY_RUN=1` makes no dump or upload calls (stubs record calls).

**`ops/backup/roundtrip.test.sh`**
- Docker-based integration test.
- Steps:
  1. Start `postgres:${PG_MAJOR}`.
  2. Apply the real migrations and seed by running `go run ./cmd/seed` from `backend/` against it.
  3. Generate a throwaway age key.
  4. Run `backup.sh` with `BACKUP_SINK=local` and `BACKUP_DB_URL_IS_DIRECT=1`.
  5. Run `scripts/db-drill.sh` on the output (P4): decrypt, restore into a second empty database, run the invariants and the reconcile diff.
  6. Tear down the containers (labelled `mandalika-backup-test=NONCE`).
- Exit non-zero on any mismatch.

**Files to modify (P1.6, CI):**

- **`.github/workflows/backend.yml`.** Add a step with `working-directory: .` that:
  - runs `shellcheck` on `scripts/deploy-backend.sh`, `scripts/promote-backend.sh`, `scripts/lib/*.sh`, `scripts/db-restore.sh`, `scripts/db-drill.sh` and `ops/backup/*.sh` (shellcheck is preinstalled on `ubuntu-latest`);
  - runs every `scripts/lib/*.test.sh`, `scripts/*.test.sh` and `ops/backup/backup.test.sh` with `bash`, failing on the first non-zero exit.
  - Add `ops/**` and `scripts/**` to the `pull_request.paths` filter. `push` already runs on every path.
  - backend.yml is already one of the four A34 release gates, so the deploy and restore guards become release-gating **without** changing `REQUIRED_CI_WORKFLOWS`.
  - The existing scripts may need small shellcheck fixes, limited to what shellcheck reports. If that turns noisy, start the list with the new and modified files only and note it.
- **New `.github/workflows/backup-roundtrip.yml`** (not a release gate).
  - Triggers: `push` and `pull_request` on paths `ops/backup/**`, `scripts/db-restore.sh`, `scripts/db-drill.sh`, `scripts/lib/restore-guard.sh`, `backend/internal/db/migrations/**`; plus `workflow_dispatch`.
  - Runs `ops/backup/roundtrip.test.sh` with Go set up.
  - Whether it should join the gates is §8 Q6.

**Verify:**
- Stub tests pass locally (`bash`).
- Shellcheck passes via Docker: `docker run --rm -v "$PWD:/w" -w /w koalaman/shellcheck:stable FILES`.
- The round trip passes locally in Docker.
- CI on the pushed branch is green.

### P2: GCP provisioning, test bucket first (0.75 d) [Opus: IAM]

**Create `ops/backup/provision.sh`** (idempotent, `--dry-run` prints every gcloud command without running it):
- Arguments: `--target test|prod`. Project `mandalika-pos`, region `asia-southeast2` (reuse the constants from `scripts/lib/cloudrun.sh`). It **never** locks anything.
- **Service accounts:**
  - `backup-writer@`: no project roles at all.
  - `backup-verifier@`: no project roles.
  - `backup-scheduler@`.
- **Buckets** (all in `asia-southeast2`, uniform bucket-level access, public-access prevention enforced):

  | Target | Bucket | Class | Retention (unlocked) | Lifecycle delete |
  |---|---|---|---|---|
  | test | `mandalika-pos-backup-test` | STANDARD | 1 d | age 2 d |
  | prod | `mandalika-pos-backup-daily` | NEARLINE | 35 d | age 36 d |
  | prod | `mandalika-pos-backup-monthly` | ARCHIVE | 730 d | age 731 d |

  Soft delete stays at the default (7 d).
- **IAM, at resource level only:**
  - `backup-writer` gets `roles/storage.objectCreator` on each bucket of the target, and `roles/secretmanager.secretAccessor` on the **`DATABASE_URL` secret only** (`gcloud secrets add-iam-policy-binding DATABASE_URL ...`).
  - `backup-verifier` gets a custom role `backupLister` (`storage.objects.list` only) on the buckets.
  - `backup-scheduler` gets `roles/run.invoker`, or the P0 custom role, on the two jobs only.
  - Nothing is granted to the default compute SA. Its `roles/editor` gap stays a separate finding: note it in HANDOFF and don't change it here.

**Create `ops/backup/deploy-job.sh JOB TARGET`**, following `deploy-backend.sh`:
- `require_green_ci`, then `git archive "$RELEASE_SHA" ops/backup` into a temp dir.
- `gcloud run jobs deploy mandalika-backup --source TMP/ops/backup --region asia-southeast2 --service-account backup-writer@... --set-secrets DATABASE_URL=DATABASE_URL:latest --set-env-vars DAILY_BUCKET=...,MONTHLY_BUCKET=...,BACKUP_SINK=gcs --memory 2Gi --cpu 1 --task-timeout 30m --max-retries 1 --labels commit-sha=$RELEASE_SHA`.
- `PG_MAJOR` and `COMMIT_SHA` are passed as build args. If source deploys can't take build args, bake `PG_MAJOR` into the Dockerfile default and pass `COMMIT_SHA` as an env var.
- **Scheduler:** `gcloud scheduler jobs create http mandalika-backup-daily --location asia-southeast2 --schedule "0 2 * * *" --time-zone Asia/Jakarta --uri https://run.googleapis.com/v2/projects/mandalika-pos/locations/asia-southeast2/jobs/mandalika-backup:run --http-method POST --oauth-service-account-email backup-scheduler@...`.

**Execution:**
1. ⚑ Run `provision.sh --target test`. Both `DAILY_BUCKET` and `MONTHLY_BUCKET` point to the test bucket.
2. ⚑ Run `deploy-job.sh`, then `gcloud run jobs execute mandalika-backup --wait` manually, once normally and once with `FORCE_MONTHLY=1`.

**Verify:**
- **Positive:** the manifest, dump and reconcile objects exist; the md5 matched; the `BACKUP_OK` log line is present.
- `gcloud run jobs describe` shows `serviceAccount: backup-writer@...`.
- **Negative IAM tests**, run as `backup-writer` with a short-lived impersonated token. This needs the owner to grant Claude's account `roles/iam.serviceAccountTokenCreator` on that SA for the test only, then revoke it. If not granted, review `get-iam-policy` output instead. Each must be **denied**:
  - overwriting an object with `ifGenerationMatch=0` again;
  - deleting an object;
  - listing the bucket;
  - reading the dump;
  - accessing a different secret, e.g. `JWT_ACCESS_SECRET`.

### P3: pre-migration Neon snapshot in `deploy-backend.sh` (0.75 d) [Opus]

**Create `scripts/lib/pending-migrations.sh`.** Sourced. Seams:
- `_pm_ls SHA`: `git ls-tree --name-only SHA backend/internal/db/migrations/`, basenames, `*.sql`, sorted.
- `_pm_have SHA`: `git cat-file -e SHA^{commit}`.

Behaviour of `pending_migrations SERVING_SHA RELEASE_SHA`:
- Prints the set difference: names at release **minus** names at serving (`comm -13` on the two sorted lists).
- Redeploying an older commit or the same commit prints nothing, so it needs no snapshot.
- **Fail closed.** If the serving sha is empty, not 40-hex, or not present locally after `require_green_ci`'s fetch, it prints `UNKNOWN` and returns 2. The caller treats that as pending.
- `PREV` may be a tagged-but-unpromoted revision that already migrated. That only causes an extra snapshot, which is the safe direction.

**Create `scripts/lib/neon.sh`.** Sourced.
- Constants filled from P0: `NEON_PROJECT_ID`, `NEON_MAIN_BRANCH_ID`, `NEON_PROD_ENDPOINT_ID`. These are identifiers, not credentials.
- `_neon_key`: `gcloud secrets versions access latest --secret=NEON_API_KEY --project "$PROJECT"`, held in a local variable and never echoed.
- `_neon_api METHOD PATH [JSON]`: curl with `--fail-with-body --max-time 30`. The `Authorization` header is passed as a header file (`-H @FILE` from a `mktemp` file with `umask 077`, removed by trap), never as argv.
- `neon_create_restore_point NAME`: snapshot, or branch if P0 decided so. Polls the returned operations every 5 s (max 5 min) until all are `finished`. Prints the id. Non-zero on timeout or error.
- `neon_list_restore_points`, and `neon_prune_restore_points --keep-days N [--apply]` (dry-run by default). Manual snapshots never expire and are capped at 100.

**Modify `scripts/lib/cloudrun.sh`.** Add `cr_label_of_revision REVISION LABEL`. Refactor `cr_revision_label` to call it; behaviour stays the same.

**Modify `scripts/deploy-backend.sh`.** Between the existing `PREV=$(cr_field revisionName)` and `gcloud run deploy`, add the step below (pseudocode; capture the return code without tripping `set -e`):

```bash
PREV_SHA=$(cr_label_of_revision "$PREV" commit-sha || true)
PM_RC=0; PENDING=$(pending_migrations "$PREV_SHA" "$RELEASE_SHA") || PM_RC=$?
if [ -n "$PENDING" ] || [ "$PM_RC" -ne 0 ]; then
  echo "migrations pending vs serving ${PREV_SHA:0:7}:"; echo "$PENDING"
  RP=$(neon_create_restore_point "pre-mig-${PREV_SHA:0:7}-$TAG-$(date -u +%Y%m%dT%H%M%SZ)") || {
    echo "deploy refused: pending migrations and the Neon restore point failed (nothing deployed)" >&2; exit 1; }
  echo "Neon restore point: $RP"
else
  RP=""; echo "no pending migrations: no Neon restore point needed"
fi
```

- **Restore points are named after the serving sha** (`pre-mig-SERVINGSHA7-TAG-UTC`; `unknown` when the sha can't be read).
  - Why: if a migrating tag is deployed, fails smoke and is redeployed under a new tag, the migration already ran when the first revision booted. The serving sha is unchanged, so the second deploy correctly sees the migration as pending, but its snapshot already contains it.
  - The correct undo point is therefore the **earliest** `pre-mig-SERVINGSHA7-*` point. The "Next" block says so, and the RUNBOOK repeats it.
- In the final "Next" block, print the restore point when `RP` is set. The rollback line stays traffic-only. Add one sentence: schema rollback = Neon restore to `RP`, see RUNBOOK.
- **Bypass.** No bypass flag, following the A34 style. The only alternative is `--restore-point ID` for a snapshot the owner made in the console; the script verifies it exists through the API. Whether an emergency bypass is wanted is §8 Q4.
- **When it does not run:** if nothing is pending, there is no Neon call at all, so a Neon outage cannot block a code-only deploy. `promote-backend.sh` and the traffic-rollback command are untouched; rollback never runs this code.

**Tests:**
- **`scripts/lib/pending-migrations.test.sh`:**
  - same commit → none;
  - release adds `0053_x.sql` → `0053_x.sql`;
  - older release (subset) → none;
  - a renamed file → pending, the safe direction;
  - empty, malformed or unknown serving sha → rc 2.
- **`scripts/lib/neon.test.sh`** (stub `_neon_api` and `_neon_key`):
  - op finished → id printed;
  - op failed → rc≠0;
  - poll timeout → rc≠0 (inject a fake clock/sleep seam);
  - API 401 → rc≠0, and the output does not contain the key.
- **`scripts/deploy-backend.test.sh`.** To make the script sourceable for the test, wrap its body in a `main` function behind a `[[ "${BASH_SOURCE[0]}" == "$0" ]]` guard. Stub `require_green_ci`, `cr_*`, `gcloud` and `neon_create_restore_point` as functions. Cases:
  - pending + snapshot ok → deploy called **after** the snapshot (the call log shows the order), and the name contains the serving sha;
  - pending + snapshot fails → deploy **not** called, rc 1;
  - none pending + a Neon stub that would fail → deploy called, Neon never called;
  - unknown serving sha → snapshot attempted.

**Verify:**
- Tests pass and shellcheck is clean.
- ⚑ The first live use is the next real release that carries a migration. The A12/A43 quick-win batch with migration 0053 is a natural candidate.
- Confirm in the output and in Neon that the restore point finished before the revision was created (compare timestamps with the Cloud Run revision's creation time).

### P4: restore guardrails, drill and reconciliation (1.5 d) [Opus]

**Rewrite `scripts/db-restore.sh`.** Put the logic in a new `scripts/lib/restore-guard.sh` so it can be tested, and source `ops/backup/lib.sh` for `mask_url` rather than duplicating it.
- Usage: `db-restore.sh [--identity AGE_KEY] [--manifest FILE] DUMP(.age|.dump)`. The target comes from `TARGET_DATABASE_URL` (env, as today).
- **Safe-target rule.** Allowed only when:
  - the host is `localhost`, `127.0.0.1` or `::1`; **or**
  - it is a Neon host whose endpoint id (after stripping `-pooler`) ≠ `NEON_PROD_ENDPOINT_ID` **and** equals `RESTORE_ALLOW_NEON_ENDPOINT`.
  - Anything else is refused. No `--force`.
- **Disaster-recovery mode** for restoring onto a new primary after provider loss: `--dr-new-primary HOST`.
  - The operator must type the host back to confirm.
  - It still refuses `NEON_PROD_ENDPOINT_ID`.
  - It still requires an empty target.
  - It is the only way to restore to a host that isn't localhost or an allowlisted Neon endpoint.
- **Empty-target rule.** Refuse if `SELECT to_regclass('public.schema_migrations')` is non-null. The `--clean` path is gone: you always restore into a fresh database.
- **Integrity.** With `--manifest`, verify the sha256 of the `.age` file against the manifest before decrypting.
- **Decrypt.** `age -d -i IDENTITY` into a `mktemp` file with `umask 077` and trap cleanup. The identity path is never logged.
- **Restore.** `pg_restore --single-transaction --exit-on-error --no-owner --no-acl -d "$TARGET_DATABASE_URL" FILE`.
- All output uses `mask_url`.
- Plaintext `.dump` files (the old `scripts/db-backup.sh` output) are still accepted, for local use.

**Create `ops/backup/invariants.sql`.** Each query returns `name | violations` and expects 0.

**Gate:** a query goes in only after it returns 0 on the local seed **and** ⚑ on prod read-only. If it fails on prod data, it's a data finding: report it to the owner and don't loosen the query.

Candidates:
1. `orders_missing_processed_key`: orders with no `processed_keys` row for `orders.idempotency_key`. First confirm that every order-writing path inserts one (`service/order.go:569`, plus any import or legacy path such as `internal/fsmigrate`).
2. `orders_without_items`.
3. `order_item_line_math`: `subtotal <> price*quantity`. First derive the rule for `is_bundle` and reward lines from `service/order.go`. If no clean rule exists, drop this one.
4. `order_total_formula`: derive from `CreateOrder`, which has subtotal, discount, surcharge, tax, total and `quoted_total` (`order.go` ~262–430). Include it only if a closed formula holds for 100% of rows.
5. `points_balance_drift`: customers (not merged: `merged_into IS NULL`) whose latest `point_transactions.balance_after` ≠ `customers.points`.
6. `pos_devices_code_dupes`: `count(*) - count(DISTINCT code)`. A belt check; the `UNIQUE` constraint already exists.
7. `processed_keys_orphans`: keys whose `order_id` is NULL although an order with that `idempotency_key` exists.
8. Stock-table duplicates by each table's natural key.

**Reconciliation:**
- Run `ops/backup/reconcile.sql` on the restored DB and diff its JSON against the decrypted `reconcile.json` from the backup.
- **Equality is required for every key.** Both come from the same exported snapshot, so there is no tolerance.

**Create `scripts/db-drill.sh`.**
- Inputs: `--manifest FILE --dump FILE.age --reconcile FILE.age --identity KEY`. For prod backups, the operator downloads these with `gcloud storage cp` using their own account; the writer SA can't read.
- Steps:
  1. Start `postgres:${PG_MAJOR}` in Docker on a random port, with a nonce label.
  2. Run `db-restore.sh`.
  3. Run the invariants and the reconcile diff.
  4. Print a report with **no PII and no money values**: only key names and ok/fail, row-count equality, migration head and the time it took.
  5. Remove the container (trap).
- Optional `--neon-endpoint ID` uses a throwaway Neon branch instead of Docker. Same guard. A branch already has data, so first create an **empty database** on that branch and restore into it, to satisfy the empty-target rule.
- **Neon-specific objects.** The round trip restores a locally seeded DB, so it never sees Neon-only objects (extensions, `neon_superuser` default privileges, publications). Drill 1 is the first real proof that a prod dump restores into vanilla `postgres:N` under `--single-transaction --exit-on-error`. If an object aborts the restore, filter it with a `pg_restore -l` / `-L` list kept in `ops/backup/`, and document why.

**PITR drill** (quarterly, manual, written up in the RUNBOOK; no new script):
1. Create a Neon branch from main at timestamp T (console or `neon.sh`).
2. Run `invariants.sql` against it.
3. Practise the "harvest after a rewind" query: list the orders on main created after T, by `idempotency_key`.
4. Delete the branch.

**Tests:**
- **`scripts/db-restore.test.sh`:**
  - localhost allowed;
  - prod endpoint refused, both pooled and direct host forms;
  - Neon non-prod refused without the allow variable, allowed with it;
  - a random host refused;
  - non-empty target refused;
  - sha mismatch refused;
  - masked output contains no password;
  - `--dr-new-primary`: allowed with a matching typed confirmation, refused on a mismatch, refused for the prod endpoint, refused for a non-empty target.
- The P1 round trip now covers restore + invariants + reconcile end to end.

**Execution:**
1. ⚑ + O8: drill 1 against a **test-bucket** backup of prod.
2. ⚑ + O8: drill 2 against the first **prod-bucket** daily (P6).
3. Record both sanitized reports in HANDOFF.

### P5: backup-age alert (0.5 d) [Opus: IAM]

Cheapest reliable combination, all inside GCP (≈ $0–1/mo; confirm alerting price in P0e):

1. **Job-failure alert.**
   - Built-in metric `run.googleapis.com/job/completed_execution_count`, filtered to `result="failed"` and `job_name` in {`mandalika-backup`, `mandalika-backup-verify`}.
   - Alert if > 0. Notify by email (O5).
2. **Verifier job `mandalika-backup-verify`**, the "newest backup age" check.
   - Same image, `MODE=verify`, SA `backup-verifier` (list only), scheduled `0 8 * * *` Asia/Jakarta.
   - Lists `daily/` for today and yesterday (WIB) and finds the newest `*.manifest.json` by object `timeCreated`.
   - Fails if:
     - the newest is older than **26 h**;
     - the manifest is missing its dump or reconcile sibling;
     - the dump is smaller than 50% of the previous one (shrink check).
   - On the 1st–3rd of each month it also checks that a monthly object exists for the current month.
   - Its failure trips alert 1.
3. **Dead-man alert.**
   - Log-based metric on `jsonPayload.event="BACKUP_OK"` for job `mandalika-backup`.
   - Metric-absence condition with the longest window P0a allows (target 25–26 h).
   - Catches the case where Scheduler or both jobs stop running entirely.
   - If the product caps the window below 25 h, use 24 h only if a week of test runs shows no flapping; otherwise drop it and rely on 1 + 2.

**Code:**
- Add `MODE=verify` to `ops/backup/backup.sh`, or a separate `ops/backup/verify.sh` in the same image.
- Extend `provision.sh` with:
  - the verifier job and its scheduler;
  - the log-based metric and the email notification channel;
  - the two alert policies, defined in `ops/backup/alerts/*.json` and created with `gcloud monitoring policies create --policy-from-file`.

**Tests:** stub-based tests of `verify` (fresh, stale, missing sibling, shrink, monthly missing).

**Verify:**
- ⚑ Point verify at an empty prefix to force a failure → the email arrives.
- ⚑ If an absence alert is configured, pause the test scheduler for a day to exercise it.

### P6: trial, prod buckets, lock (0.5 d effort, ≥ 14 days elapsed) [Opus]

1. ⚑ Run `provision.sh --target prod`. The buckets get retention policies but stay **unlocked**.
2. ⚑ Redeploy the job pointing at the prod buckets; enable both schedulers. Remove the test scheduler.
3. Let it run at least **14 days**. Expected: every day has a `BACKUP_OK`, the verifier is green, no alerts, and at least one monthly upload.
   - If the trial doesn't span the 1st of a month, run once with `FORCE_MONTHLY=1` using `gcloud run jobs execute --update-env-vars`.
4. ⚑ + O8: drill 2 (P4) on a prod-bucket daily **and** on the monthly object.
5. ⚑ Delete the test bucket once its objects are past the 1-day retention.
6. **Lock**, only after drill 2 passes **and** O9.
   - Script `ops/backup/lock-retention.sh BUCKET`. It:
     - re-reads the bucket's retention policy and metageneration and prints them;
     - prints the P0c consequence (project lien, if any) and that the lock can never be undone;
     - requires typing the bucket name and the retention period exactly;
     - then runs `gcloud storage buckets update gs://BUCKET --lock-retention-period --if-metageneration-match=M`.
   - It never runs from `provision.sh`. Run it once per bucket, each on its own O9 confirmation. Daily (35 d) and monthly (730 d) are confirmed separately (§8 Q1).
   - Verify with `gcloud storage buckets describe gs://BUCKET`, which should show the retention policy as locked.

### P7: RUNBOOK, PDP note, HANDOFF (0.5 d) [Haiku; the RUNBOOK restore steps get an Opus read]

**`RUNBOOK.md`.** Replace the "DB restore" section, the "Migration" bullet under "Rollback", and the Neon "Backups" line under the Cloud Run setup. Coordinate with the pending A40 RUNBOOK refresh: do A40 first, or merge both into one edit (§8 Q5). Add:
- **Incident matrix:** RPO/RTO per class (research §2, owner numbers).
- **Neon PITR:**
  - restore into a **side branch** first;
  - during trading, fix forward;
  - after a rewind of main, harvest from `BRANCH_old_TIMESTAMP` by `idempotency_key` / `operation_receipts`.
- **Undoing a migration.**
  - **Preferred: PITR.** Restore to `min(applied_at)` of the new files in `schema_migrations`, minus 1 s. That timestamp is exact and inside the 7-day window. Restore into a side branch first.
  - **Fallback: the pre-migration restore point.** Use the **earliest** `pre-mig-SERVINGSHA7-*` point for the serving sha; a later one may already contain the migration. `deploy-backend.sh` prints the point's id.
- **Dump restore:**
  - download → `db-drill.sh` to check, or `db-restore.sh` into a new host;
  - then point Cloud Run's `DATABASE_URL` secret at the new host.
- **After any restore:**
  - `pos_devices` codes issued after the restore point may be re-issued. Re-register the tablets registered since T, or hold registrations until reconciled.
  - Redis refresh tokens may outlive a DB rewind. Flush the refresh-token keys.
  - Tablets with pending outbox rows re-push them, and idempotency makes that safe. Acked sales after T are lost unless harvested.
- **Backup ops:**
  - manual run: `gcloud run jobs execute mandalika-backup --wait`;
  - `FORCE_MONTHLY=1`;
  - reading the alerts;
  - rebuilding with a new `PG_MAJOR` when Neon upgrades (the job fails loudly on a mismatch);
  - pruning snapshots: `neon_prune_restore_points`.
- **Key custody:**
  - two age recipients;
  - what to do if one key is lost: re-key with a new recipients file; older backups still open with the surviving key;
  - a yearly check that the escrow key decrypts.
- **Drill cadence:** dump drill quarterly, or monthly per §8 Q2; PITR drill quarterly.
- **Remove** the statements that no longer hold: "Neon free keeps automated history" and "Schedule `db-backup.sh` daily".

**Other files:**
- **`docs/privacy/a36-backup-retention-pdp.md`** (new):
  - what is kept, where (GCS Jakarta + Neon Singapore), for how long and why;
  - that deletion and correction requests apply to the live DB immediately, and to backups when they age out (≤ 35 d dailies, ≤ 24 months monthlies);
  - that a restore can bring deleted personal data back, so deletions must be re-applied after any restore (a deletion log is an open follow-up);
  - draft Indonesian wording for the privacy notice (O10).
- **`HANDOFF.md`** progress board: A36 status per phase.
- **`docs/audits/2026-10-14-audit-status-sweep.md`**: A36 row → done once P6 has locked and drill 2 has passed.

## 4. Task list (for the implementer)

| # | Task | Files | Verify | Review |
|---|---|---|---|---|
| T0 | P0 spike | none (notes) | facts recorded | Opus |
| T1 | `lib.sh` + `backup.test.sh` | `ops/backup/lib.sh`, `ops/backup/backup.test.sh` | tests pass, shellcheck | Opus |
| T2 | `backup.sh` + Dockerfile + recipients + `reconcile.sql` | `ops/backup/*` | `DRY_RUN=1` and local sink in Docker; stub tests | Opus |
| T3 | Restore guard + `db-restore.sh` rewrite + tests | `scripts/lib/restore-guard.sh`, `scripts/db-restore.sh`, `scripts/db-restore.test.sh` | tests | Opus |
| T4 | Invariants + `db-drill.sh` + round trip | `ops/backup/invariants.sql`, `scripts/db-drill.sh`, `ops/backup/roundtrip.test.sh` | round trip green locally; invariants 0 on seed | Opus |
| T5 | CI wiring | `.github/workflows/backend.yml`, `.github/workflows/backup-roundtrip.yml` | CI green on the branch | Opus (release gate) |
| T6 | Pending-migration detection + Neon lib + deploy step + tests | `scripts/lib/pending-migrations.sh` (+test), `scripts/lib/neon.sh` (+test), `scripts/lib/cloudrun.sh`, `scripts/deploy-backend.sh` (+`scripts/deploy-backend.test.sh`) | tests; review of the diff | Opus |
| T7 | Provisioning + job deploy scripts | `ops/backup/provision.sh`, `ops/backup/deploy-job.sh` | `--dry-run` output reviewed | Opus |
| T8 | ⚑ Provision test + first runs + negative IAM checks | none | P2 verify list | Opus |
| T9 | Verify mode + alert policies | `ops/backup/backup.sh` or `verify.sh`, `ops/backup/alerts/*.json`, `provision.sh` | stub tests; ⚑ forced-failure email | Opus |
| T10 | ⚑ Invariants on prod read-only + drill 1 (test bucket) | `invariants.sql` adjustments only | sanitized report | Opus |
| T11 | ⚑ Prod buckets + 14-day trial + drill 2 | none | P6 steps 1–4 | Opus |
| T12 | Lock script; ⚑ + O9 lock | `ops/backup/lock-retention.sh` | bucket describe shows the lock | Opus |
| T13 | RUNBOOK + PDP note + HANDOFF | `RUNBOOK.md`, `docs/privacy/a36-backup-retention-pdp.md`, `HANDOFF.md` | read-through | Haiku (+ Opus on the restore steps) |

**Order:**
1. Owner O1–O4 can start at once.
2. T0 needs O1–O3.
3. T1–T5 need no GCP access. Work on one branch off `prod-hardening` (e.g. `feat/a36-backups`); `PG_MAJOR` from T0 is needed only for T2/T4.
4. T6 and T7 can run in parallel.
5. Then T8 → T9 → T10.
6. Then T11 (elapsed time) → T12. T13 can be drafted any time and finalized last.
- **Push and green CI happen before any ⚑ deploy step.** `deploy-job.sh` is CI-gated like the backend; the first live T6 use rides the next migrating release.
- Pushes to `prod-hardening` follow the usual owner go-ahead (AGENTS.md).
- Prefix commits that touch only `ops/`, `scripts/` or `docs/` with `[CF-Pages-Skip]`.

**Estimate:** ≈ **6.5 working days** of effort (P0 0.5, P1 1.5, P2 0.75, P3 0.75, P4 1.5, P5 0.5, P6 0.5, P7 0.5), plus **≥ 14 calendar days** of trial before the lock.

## 5. Dry-run modes (summary)

- `backup.sh`: `DRY_RUN=1` (no dump or upload) and `BACKUP_SINK=local` (full run to a directory).
- `provision.sh`: `--dry-run`. `neon_prune_restore_points`: dry by default.
- `deploy-backend.sh`: its test harness stubs every external call. There is no live dry-run flag; the A34 gate stays the same.
- `lock-retention.sh`: no dry-run is needed, because it prints the policy and acts only after typed confirmation.

## 6. Risks and rollback

| Risk | Mitigation / rollback |
|---|---|
| **Lock is irreversible.** It can't be shortened or removed, the bucket can't be deleted until objects expire, and there may be a project lien (P0c). | Test bucket first. Prod buckets run unlocked through a 14-day trial and drill 2. Locking is a separate script with typed confirmation and O9 per bucket. Retention can only be **increased** later, so start at the owner's number, not higher. |
| Lost `age` private key = unreadable backups for 2 years. | Two recipients (primary + escrow) in separate places. The drill proves the primary decrypts. A yearly escrow check (RUNBOOK). |
| `pg_dump`/server major mismatch after a Neon upgrade. | Hard fail on mismatch → failure alert → rebuild with the new `PG_MAJOR` (RUNBOOK). |
| Direct-endpoint derivation is wrong, or the direct endpoint is unavailable. | P0 verifies it. Fallback: a new secret `BACKUP_DATABASE_URL` (direct, ideally a read-only role, §8 Q3) bound to the writer SA instead. |
| Long-running `pg_dump` holds back vacuum on Neon. | The dump runs at 02:00 WIB and is small. Duration is logged; investigate if it exceeds 10 min. |
| Dump outgrows in-memory `/tmp` (2 GiB job). | `MAX_DUMP_BYTES` fails loudly. Raise job memory or switch to a resumable streamed upload. Size is tracked in the manifest. |
| Neon API down during a migrating deploy. | Deploy refused; nothing changed, prod unaffected. Retry, or use a console snapshot with `--restore-point`. Code-only deploys are never affected. |
| Snapshot step wrongly skipped (false "no pending"). | Set difference against the **serving** revision's sha; unknown → pending. Covered by unit tests. |
| Restore pointed at prod by mistake. | Guard refuses the prod endpoint and any non-allowlisted host, refuses non-empty targets, and has no `--force`. |
| Over-privileged writer. | Dedicated SA, resource-level bindings only, negative IAM tests in P2. Default compute SA unchanged (separate finding). |
| Writer compromised. | It can only add objects. Under the lock nothing is deleted before retention. It can't read old backups, and they're encrypted anyway. |
| Neon manual snapshots pile up (cap of 100). | `neon_prune_restore_points` with a keep window (§8 Q7), run monthly per the RUNBOOK. |
| Cost drift. | Expected about 32–50 USD/month in total (research §4). Check the GCS and Neon bills after the first month. |

**Rolling back the build itself:**
- Pause or delete the schedulers and jobs.
- Revert the P3 commits (`scripts/deploy-backend.sh`, `scripts/lib/neon.sh`, `scripts/lib/pending-migrations.sh`, `scripts/lib/cloudrun.sh`).
- Buckets stay. Unlocked buckets can be deleted once objects pass retention; locked ones cannot.

## 7. Out of scope

- The tablet acked-sales tail (not chosen).
- Re-scoping the Cloud Run default compute SA's `roles/editor` (separate finding; note it in HANDOFF).
- Moving to Cloud SQL Jakarta.
- A deletion log so restores can re-apply PDP deletions (follow-up, flagged in the PDP note).
- Changes to `scripts/db-backup.sh` (kept for ad-hoc local dumps; the RUNBOOK points to the new job instead).

## 8. Open questions for the owner

1. **Lock scope.** Lock **both** buckets (dailies 35 d, monthlies 730 d), or only the monthly one? The decision text says "locked bucket" plus a monthly 24-month lock. Recommendation: lock both.
2. **Drill key custody.**
   - (a) You decrypt for each drill (manual drills, quarterly); or
   - (b) a third, drill-only `age` recipient whose private key sits in Secret Manager, readable only by a `backup-drill` SA, so drills can be automated monthly. This weakens "nothing in GCP can decrypt".
   - Recommendation: (a), quarterly, plus a drill after any change to the backup code.
3. **DB credential for the job.** Derive the direct URL from `DATABASE_URL` (default; meets "accessor on DATABASE_URL only"), or create a dedicated **read-only Postgres role** and a `BACKUP_DATABASE_URL` secret? The second is better least-privilege but needs a role created on Neon (⚑ DB write).
4. **Emergency bypass.** If Neon's API is down and an urgent fix carries a migration, may `deploy-backend.sh` proceed without a restore point (e.g. a typed confirmation flag)? Recommendation: no bypass; use a console snapshot plus `--restore-point`.
5. **RUNBOOK sequencing with A40:** A40's refresh first and then A36, or one combined edit?
6. **Release gate.** Should `backup-roundtrip.yml` join the four required release gates? It would change A34 gating. Recommendation: not now.
7. **Manual pre-migration restore points:** how long to keep them? Recommendation: 35 days, matching the daily snapshots.
8. **Alert recipients:** one email or several (O5)?
9. **Privacy notice:** where does it live, so the PDP wording can go there?
10. **Negative IAM test:** OK to grant Claude's account temporary `roles/iam.serviceAccountTokenCreator` on `backup-writer` for the P2 denial tests (revoked right after)?
