# Runbook: ERP stand-in (erpstub) for the 2 Nov demo

The real ERP (erp-flamboyan) has no hosted instance and no write endpoint yet. This runbook puts the
contract-faithful stub `backend/cmd/erpstub` on Cloud Run as its own service, `mandalika-erpstub`, and
switches the POS integration on against it in the **test** environment. The relay and the catalog pull
change nothing but `ERP_BASE_URL` and `ERP_API_KEY` when the real ERP is ready.

Related: `erp-catalog-sync.md` (step 4), `erp-relay.md` (step 5), demo script in
`docs/plans/2026-10-22-reorg-and-erp-demo-plan.md` §6.1, checklist in `erp-standin-demo-checklist.md`.

**Every numbered Phase B step is a cloud action that needs the owner's explicit go-ahead, one step at a
time.** §0 and §1 are local only.

Conventions for every command below:
- Bash (Git Bash on Windows), from the repo root unless a step says `backend/`.
- `export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1` first in any shell that reads or writes a secret, so
  values never land in gcloud's log files. Secret values are never pasted into chat, files or flags.
- `P=mandalika-pos; R=asia-southeast2`

## 0. What the stand-in is (and is not)

| Property | Value |
|---|---|
| Contract | `docs/integration/stock-documents.v1.yaml` + the ERP catalog/stock read endpoints |
| Endpoints | `GET /api/integration/v1/catalog/finished-goods`, `.../catalog/outlets`, `.../outlets/{code}/stock`, `POST .../stock-documents` (replay = `replayed`, changed body = 409, validation = 422, max 200 lines) |
| Demo hooks | `GET /_stub/documents`, `GET /_stub/balances`, `POST /_stub/fg`, `POST /_stub/outlet`, `POST /_stub/fault?status=503&count=N` |
| Auth | `Authorization: Bearer <key>` on everything, hooks included. One key: Secret Manager `ERP_API_KEY`, mounted into the stub as `ERP_STUB_KEY` and into mandalika-pos as `ERP_API_KEY` |
| State | **In memory.** Documents, balances, the idempotency map and hook-created FGs/outlets live only as long as the instance. A cold start reloads the baked catalog (`/erpstub-seed.json`) and nothing else |
| Instances | `--max-instances 1` (a second instance would split documents, balances and idempotency). `--min-instances 0` normally, `1` for the demo window (§6) |
| Ingress | Public URL (`--allow-unauthenticated`): the POS sends a bearer key, not a Google IAM token. Trade-off: anyone who finds the URL gets 401s; the key is the only guard, like the real ERP |

### Why the cold start matters for the demo
After a cold start the stub has forgotten every document. "Kirim ulang" on an old delivered document then
answers `applied` (not `replayed`) and the balance moves again, and `/_stub/balances` starts from zero
while the POS ledger does not. So: keep one instance warm from the rehearsal until the end of the demo
(§6), and re-run the rehearsal if the instance restarted (Cloud Run logs show `erpstub listening on`).

### Persistence options (pick one; default = A)
- **A. In-memory + baked catalog + warm instance for the demo window (default, no new resources).**
  The catalog survives restarts because it is baked into the image; documents do not. Enough for a
  2-hour demo.
- **B. Smallest real persistence: Cloud Storage volume.** A new **private** bucket (never the public
  OTA bucket `mandalika-pos-ota`) mounted with `--add-volume name=state,type=cloud-storage,bucket=<b>
  --add-volume-mount volume=state,mount-path=/state` and the stub started with `-state /state/erpstub.json`
  (needs the entrypoint args `--args=-seed,/erpstub-seed.json,-state,/state/erpstub.json`). The stub
  writes the whole state to a temp file and renames it after every mutation; on Cloud Storage FUSE that
  is a copy, fine at demo volume with one instance. Costs a bucket and an IAM grant
  (`roles/storage.objectUser` for the stub's service account): a separate go-ahead. Not needed for the
  demo.

## 1. Local proof first (no cloud)

```bash
scripts/erp-rehearsal-local.sh
```
Builds `cmd/server`, `cmd/erpstub`, `cmd/seed` and `cmd/erp-rehearsal`, creates a throwaway database on
the local Postgres 18 (`erp_rehearsal_<timestamp>`, dropped at exit), starts the stub and the server with
the integration on, and runs every demo step with assertions (see the checklist for the step list).
Must end with every step `PASS` before any Phase B step.

## 2. Build the demo catalog for the stub (local file, then baked into the image)

The stub must not start from its embedded test seed in the test environment: that seed has outlets
`KMG`, `BSD` and a deleted outlet `POP`, and the catalog pull links an ERP outlet to the unlinked POS
outlet with the same code (and deactivates a linked outlet whose ERP twin is deleted). The demo seed holds
exactly one outlet (the test-env outlet used on the tablet), the warehouse slug `gudang-pusat`, and the
demo FGs.

1. Pick the demo outlet and warehouse (backoffice, Outlet & Gudang). Note the outlet **code** (e.g.
   `MDK-01`) and the warehouse id.
2. Generate the seed (local, reads nothing from the cloud):
   ```bash
   cd backend
   go run ./cmd/erp-rehearsal -print-seed -run-id DEMO -outlet-code <OUTLET_CODE> > ../erpstub-seed.demo.json
   ```
   The FG codes and slugs are derived from `-run-id`, so the rehearsal in B6 (run with `-run-id DEMO`)
   and the baked catalog agree. Do not commit this file (it carries the test-env outlet code).
3. **Edit the outlet record in the file**: replace the placeholder `name` and the null `address`/`phone`
   with the outlet's current POS values. Every catalog pull copies the ERP outlet's name, address and phone
   onto the linked POS outlet (`catalog_store.go`), so the placeholders would overwrite the real details
   (receipt header) after any stub restart. The rehearsal itself echoes the POS values when it upserts the
   outlet.

## Phase B (cloud; each step = one owner go-ahead)

### B1. Secrets (go-ahead: Secret Manager writes + IAM)
The stub accepts whatever key we give it, so we generate one.
```bash
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1; P=mandalika-pos; R=asia-southeast2
gcloud secrets create ERP_API_KEY --project $P --replication-policy automatic
gcloud secrets create ERP_SCHEDULER_TOKEN --project $P --replication-policy automatic
openssl rand -hex 32 | tr -d '\r\n' | gcloud secrets versions add ERP_API_KEY --project $P --data-file=-
openssl rand -hex 32 | tr -d '\r\n' | gcloud secrets versions add ERP_SCHEDULER_TOKEN --project $P --data-file=-
# Check: both must print 64. Git Bash's openssl ends lines with \r\n; a stray \r makes the
# stub (which does not trim) reject every call with 401 while the POS (which trims) sends 64 chars.
for s in ERP_API_KEY ERP_SCHEDULER_TOKEN; do v="$(gcloud secrets versions access latest --secret $s --project $P)"; echo "$s ${#v}"; unset v; done
SA=$(gcloud run services describe mandalika-pos --region $R --project $P --format 'value(spec.template.spec.serviceAccountName)')
SA=${SA:-$(gcloud projects describe $P --format 'value(projectNumber)')-compute@developer.gserviceaccount.com}
for s in ERP_API_KEY ERP_SCHEDULER_TOKEN; do
  gcloud secrets add-iam-policy-binding $s --project $P --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
done
```
The stub runs as the same service account (B2 does not pass `--service-account`), so one grant covers both.
When the real ERP arrives: add its key as a new `ERP_API_KEY` version and roll a mandalika-pos revision
(`:latest` is resolved at revision start).

### B2. Deploy the stub service (go-ahead: new Cloud Run service)
Upload a clean export of the committed tree, not the working tree:
```bash
P=mandalika-pos; R=asia-southeast2
TMP=$(mktemp -d); git archive HEAD backend | tar -x -C "$TMP"
cp backend/cmd/erpstub/Dockerfile "$TMP/backend/Dockerfile"
cp erpstub-seed.demo.json "$TMP/backend/erpstub-seed.json"
gcloud run deploy mandalika-erpstub --source "$TMP/backend" --region $R --project $P \
  --allow-unauthenticated --min-instances 0 --max-instances 1 --concurrency 80 \
  --cpu 1 --memory 256Mi --set-secrets ERP_STUB_KEY=ERP_API_KEY:latest --labels app=erpstub,purpose=demo
rm -rf "$TMP"
STUB=$(gcloud run services describe mandalika-erpstub --region $R --project $P --format 'value(status.url)')
echo "$STUB"
```
Smoke (expect 401 then 200 with the demo FGs):
```bash
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1
curl -s -o /dev/null -w '%{http_code}\n' "$STUB/api/integration/v1/catalog/finished-goods"
KEY=$(gcloud secrets versions access latest --secret ERP_API_KEY --project mandalika-pos)
curl -s -H "Authorization: Bearer $KEY" "$STUB/api/integration/v1/catalog/finished-goods?take=5"; unset KEY
```

### B3. Map the demo warehouse (go-ahead: one-row Neon write)
`warehouses.erp_slug` has no API writer (migration 0066: mapped by hand). Without it every transfer
document stays `held`. The outlet is linked and the variants are created by the catalog pull (B6).
```sql
-- DSN from Secret Manager (DATABASE_URL), never pasted. Check first:
SELECT id, name, erp_slug FROM warehouses WHERE id = '<WAREHOUSE_ID>';
UPDATE warehouses SET erp_slug = 'gudang-pusat' WHERE id = '<WAREHOUSE_ID>' AND erp_slug IS NULL;
```

### B4. mandalika-pos revision with the integration on (go-ahead: deploy; then a second go-ahead: promote)
Same image as the serving revision (`00126-seh`); only env and secrets change, so no push or CI run is
needed. Traffic-free tag first, smoke, then promote. All five values in ONE update (with
`ERP_INTEGRATION_ENABLED=true` and no `ERP_BASE_URL`/`ERP_API_KEY` the config is invalid).
```bash
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1; P=mandalika-pos; R=asia-southeast2
source scripts/lib/cloudrun.sh
STUB=$(gcloud run services describe mandalika-erpstub --region $R --project $P --format 'value(status.url)')
PREV=$(cr_field revisionName); echo "rollback target: $PREV"          # expect mandalika-pos-00126-seh
gcloud run services update mandalika-pos --region $R --project $P --no-traffic --tag erpdemo \
  --update-labels deploy-tag=erpdemo \
  --update-env-vars ERP_INTEGRATION_ENABLED=true,ERP_RELAY_ENABLED=true,ERP_BRAND=mandalika,ERP_BASE_URL=$STUB/api/integration/v1 \
  --update-secrets ERP_API_KEY=ERP_API_KEY:latest,ERP_SCHEDULER_TOKEN=ERP_SCHEDULER_TOKEN:latest
TAG_URL=$(cr_field url erpdemo)
curl -s -o /dev/null -w '%{http_code}\n' "$TAG_URL/readyz"                                   # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$TAG_URL/api/v1/internal/erp/relay"         # 401, not 503 (= switched on)
cr_revision_label erpdemo commit-sha                                                         # the 00126-seh commit (a2fddd7...)
```
Promote (the new revision inherits the `commit-sha` label of `00126-seh`, whose CI is green on the mirror):
```bash
GH_REPO=mandalika-ci/mandalika-pos-ci scripts/promote-backend.sh erpdemo
```
If the promote script refuses for any label reason (`commit-sha` empty, `deploy-tag` not `erpdemo` because
`--update-labels` did not reach the revision), promote by hand after the same smoke: `gcloud run services update-traffic mandalika-pos --region $R --project $P --to-tags erpdemo=100`.
**From a newer pushed SHA instead of the serving image** (what was done on 2026-10-23): first
`GH_REPO=mandalika-ci/mandalika-pos-ci scripts/deploy-backend.sh <tag>`, which deploys the new image
traffic-free with the flags still off. Then run the `services update ... --tag erpdemo` above: the new
revision is built on the latest template, so it gets the new image and its `commit-sha` label. Smoke it
and promote `erpdemo` as above.

`ERP_BRAND` is the ERP idempotency scope `pos:mandalika`: never change it after the first document.

What happens at the first relay run: every document queued since the 2026-10-22 backfill (opening
stock of every location, test sales since then) is picked up. Rows whose outlet or variant has no ERP
mapping go to `held` and are re-checked every 5 min without counting attempts. That is expected with a
stand-in that only knows the demo catalog; the "Integrasi ERP" view will list them as held.

### B5. Cloud Scheduler jobs (go-ahead: two jobs)
The relay every 2 min and the incremental catalog pull every 15 min. The daily FULL pull is deliberately
NOT created for the stand-in: a full run deactivates linked variants missing from the ERP catalog (up to
max(5, 20%) per run), and after a stub restart without the demo catalog that would hit real test data.
```bash
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1; P=mandalika-pos; R=asia-southeast2
URL=$(gcloud run services describe mandalika-pos --region $R --project $P --format 'value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret ERP_SCHEDULER_TOKEN --project $P)
gcloud scheduler jobs create http erp-relay --project $P --location $R \
  --schedule "*/2 * * * *" --time-zone "Asia/Jakarta" --uri "$URL/api/v1/internal/erp/relay" \
  --http-method POST --headers "X-Scheduler-Secret=$TOKEN" --attempt-deadline 60s --max-retry-attempts 0
gcloud scheduler jobs create http erp-catalog-pull-incremental --project $P --location $R \
  --schedule "*/15 * * * *" --time-zone "Asia/Jakarta" --uri "$URL/api/v1/internal/erp/catalog-pull?mode=incremental" \
  --http-method POST --headers "X-Scheduler-Secret=$TOKEN" --attempt-deadline 60s
unset TOKEN
```
(If `gcloud scheduler locations list --project $P` does not list `asia-southeast2`, use the nearest listed
region.) The header value is visible to project viewers in the job definition; OIDC replaces it after the
demo (plan D15).

For the live rehearsal (B6) pause both jobs first, so the harness controls every run, and resume after:
`gcloud scheduler jobs pause erp-relay --project $P --location $R` (and `erp-catalog-pull-incremental`),
`... resume ...` afterwards.

### B6. Rehearsal against the live test environment (go-ahead: test-data writes on Neon)
Creates demo products (FG codes from `-run-id`), goods receipts, a sale, a refund, a transfer and one
dead-lettered then fixed document in the test DB. Run from `backend/`:
```bash
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1; P=mandalika-pos
export REHEARSAL_BACKEND_URL=https://mandalika-pos-538849926142.asia-southeast2.run.app
export REHEARSAL_STUB_URL=$(gcloud run services describe mandalika-erpstub --region asia-southeast2 --project $P --format 'value(status.url)')
export REHEARSAL_ADMIN_EMAIL=<admin email>
export REHEARSAL_ADMIN_PASSWORD="$(gcloud secrets versions access latest --secret SEED_ADMIN_PASSWORD --project $P)"
export REHEARSAL_STUB_KEY="$(gcloud secrets versions access latest --secret ERP_API_KEY --project $P)"
export REHEARSAL_SCHEDULER_TOKEN="$(gcloud secrets versions access latest --secret ERP_SCHEDULER_TOKEN --project $P)"
go run ./cmd/erp-rehearsal -live -run-id DEMO -outlet-code <OUTLET_CODE> -warehouse-id <WAREHOUSE_ID>
unset REHEARSAL_ADMIN_PASSWORD REHEARSAL_STUB_KEY REHEARSAL_SCHEDULER_TOKEN
```
`REHEARSAL_DATABASE_URL` (the read-only §2.4 invariant check) is left unset against Neon unless the owner
also approves that read. The login limiter allows 10 logins per 5 min: the harness logs in once.

Harness behaviour that matters on live:
- With `-live` the first pull (step 2) is **incremental**, not full: a full run would deactivate every
  linked POS variant missing from the stub catalog, e.g. the products of an earlier rehearsal. Override
  with `-first-pull full` only on a fresh environment. Note: while no pull has ever completed (no
  watermark, the state of Neon today) the backend runs an incremental request as **full**
  (`resolveMode` in `internal/integration/erp/catalog.go`). On Neon that first run is harmless: the full-run reconcile only deactivates
  variants already linked to an ERP slug, and none are linked until this first pull.
- A `-run-id` can be used **once** per backend (steps 2-3 assert new variants); a reused id is refused in
  preflight. Use `DEMO` for the first live run (it matches the baked catalog, so the demo products survive
  a stub restart), and a fresh id (`DEMO2`, ...) for any later run. FG `D` of a run is created by a hook at
  run time and is not in the baked catalog: after a stub restart, sell only `A`-`C` of the `DEMO` run.
- Drain the backlog first. Documents queued since the 2026-10-22 backfill are claimed 50 per relay run.
  The harness drains at most 6 runs per step, about 300 documents. Before B6, press "Kirim sekarang"
  until a run reports `claimed=0`; most of these documents end `held`.
- It reads `GET /shifts/current` as the admin at the outlet and opens (and closes again) its own shift
  when none is returned. Whether a cashier's open tablet shift counts is not verified against live:
  close the tablet shift before B6 to keep the run's sales out of the cashier's shift report. The ~2 min wait in step 11 is the relay's real 503 backoff.
- It leaves test data behind on purpose (no cleanup API): products in category `Rehearsal` with FG codes
  `RH-<ID>-A..D`, an inactive throwaway product `ERP Rehearsal <ID> guard` (step 13: a product whose
  stock was received and then zeroed by an adjustment cannot be hard-deleted: HTTP 409 naming the stock history; deactivating
  it is the supported path), and two `held` documents
  for that throwaway product.
- Products are scanned through `GET /products` up to 2,000 rows (10 pages of 200).

Local equivalent of exactly this mode: `FROM_SEED=1 FIRST_PULL=incremental RUN_ID=DEMO scripts/erp-rehearsal-local.sh`.

## Live state (done 2026-10-23, owner go-ahead)

- Stub: `mandalika-erpstub` at `https://mandalika-erpstub-538849926142.asia-southeast2.run.app`, revision
  `00002-sxd`, baked catalog `RH-DEMO-A..C` + outlet `bsd`/`BSD` (Mandalika BSD, Jakarta) + `gudang-pusat`.
- Secrets `ERP_API_KEY` v2 and `ERP_SCHEDULER_TOKEN` v2 (v1 of both disabled: it carried a trailing `\r`).
- Neon: warehouse `00049245-…` "Gudang Pusat (contoh)" `erp_slug = gudang-pusat`; outlet BSD linked by the
  pull (`erp_slug bsd`, address kept).
- mandalika-pos: `00128-yic` (tag `erpimg`, image e46e7fb, flags off, 0%) then `00129-sis` (tag `erpdemo`,
  same image, flags on) serving 100%. Rollback: `--to-revisions mandalika-pos-00126-seh=100`.
- Cloud Scheduler API enabled on the project; jobs `erp-relay` (*/2) and `erp-catalog-pull-incremental`
  (*/15) in asia-southeast2, ENABLED; the first forced run of each succeeded.
- Live rehearsal: `-run-id DEMO2` 15/15 PASS including the read-only §2.4 invariant (0 rows). The first
  attempt (`-run-id DEMO`) stopped at step 2 on a stale cached product list (see below); `RH-DEMO-A..C`
  exist in the POS unpriced and not sellable. After a stub restart only `DEMO` FGs come back, so a rerun after a
  restart needs a fresh id (and `DEMO2` documents would 422 after a restart until re-seeded).
- The rehearsal sales went into the Administrator's own open shift at BSD (`e3b4a893…`, open since
  2026-10-10), which the harness reuses rather than opening one.

Found live: the backend's Redis read cache (15 s, key = path + query) is not dropped by the ERP catalog pull
(the pull handlers never call `h.invalidate`), so for up to 15 s after a pull `GET /products` can miss the
new variants. The harness now adds a unique `_=` parameter to every backend GET. Fixed since: every pull
entry path (scheduler, admin, `cmd/erp-catalog-pull`) now drops the read cache; the harness keeps the `_=`
parameter because the relay still does not invalidate.

## 6. Demo day

1. Morning: `gcloud run services update mandalika-erpstub --region $R --project $P --min-instances 1`
   (keeps one instance warm; also set back to 0 after the demo).
2. Re-run B6 with a fresh `-run-id` (e.g. `DEMO2`) only if the stub restarted since the last run
   (`/_stub/documents` empty) or to refresh the evidence. Then follow `erp-standin-demo-checklist.md`.
3. After the demo: `--min-instances 0`.

## Cutover to the real ERP (erp-flamboyan)

Source: the ERP developer's reply of 2026-10-24 ("Integrasi Stok ERP–POS", answer to the 2026-10-21
handoff) and the owner's decisions of 2026-10-25. The relay accepts the ERP's `status: "success"` envelope
and its array `details[].path` (both stub forms still work). Each step needs its own owner go-ahead; do
them per outlet, in this order.

1. **ERP:** the ERP admin creates client `pos_<brand>` with scopes "Katalog (baca)", "Stok outlet (baca)"
   and "Dokumen stok (tulis)"; the key comes over a secret channel and becomes a new `ERP_API_KEY`
   version. Point `ERP_BASE_URL` at `https://<erp-host>/api/integration/v1`. Keep `ERP_RELAY_ENABLED=false`
   until step 6. Pause the `erp-relay` job and the pull job while switching (§7).
2. **POS, clear the demo mapping:** unset the demo warehouse slug. The ERP refuses warehouse documents
   with 422 this phase; with the slug empty they stay `held` in the outbox and burn no attempts.
   ```sql
   SELECT id, name, erp_slug FROM warehouses WHERE erp_slug IS NOT NULL;
   UPDATE warehouses SET erp_slug = NULL WHERE erp_slug = 'gudang-pusat';  -- "Gudang Pusat (contoh)"
   ```
   Also unlink or delete the demo variants and the demo outlet mapping (§7, data left behind).
3. **POS, map outlets by slug before the first pull.** The pull links an existing outlet only when its
   code equals the ERP outlet code exactly; otherwise it creates a duplicate inactive outlet and the real
   outlet's documents stay `held` for ever. There is no UI for `outlets.erp_slug`: make the codes equal in
   the ERP, or set the slug once by SQL (check first, one row):
   ```sql
   SELECT id, name, code, erp_slug FROM outlets WHERE id = '<OUTLET_ID>';
   UPDATE outlets SET erp_slug = '<erp-outlet-slug>' WHERE id = '<OUTLET_ID>' AND erp_slug IS NULL;
   ```
4. **POS, SKU mapping from a full catalog sync.** Take `code` and `slug` of every FG from a full
   `GET /catalog/finished-goods` (ERP answer Q6) and import the SKU-mapping CSV (`fg_code`, `fg_slug`,
   optional `erp_group_key` in the `pos:<name minus size>` form) before the first pull, so existing
   variants link instead of being duplicated (runbook `erp-catalog-sync.md` §2). Then run a full pull.
   The ERP demo seed holds only 24 FGs: documents for any other product stay `held` (unmapped) until the
   full FG master is imported in the ERP.
5. **POS, every outlet movement has an outbox row**, including those recorded before the outbox existed
   (migrations 0064 → 0065). The `opening` line is live stock minus all earlier ledger movements, so one
   missing movement leaves the ERP balance off by exactly that movement.
   ```sql
   SELECT count(*) FROM stock_movements m WHERE m.location_type = 'outlet' AND m.location_id = '<OUTLET_ID>'
      AND NOT EXISTS (SELECT 1 FROM erp_outbox o WHERE o.document_id = m.document_id);  -- must be 0
   ```
6. **ERP:** imports FG stock QTY 0 for that outlet in the current month, and from then on stops its own
   import, adjust and reject of FG stock at that outlet (single writer; plan 1 relies on this rule only).
7. **POS:** `ERP_RELAY_ENABLED=true`, resume the `erp-relay` job. The backlog (`opening` and every
   document) may arrive in any order: the ERP posts each line as a delta, so the sum is the POS live stock.
8. **Verify** once the backlog is drained (no `pending`/`sending` rows for the outlet): the ERP's
   `GET /outlets/{code}/stock` equals POS live stock (`outlet_variant_stock`) per FG. A difference means a
   missing or dead document: check `dead` rows first (`last_error` names the field, e.g. `lines.2.fg_code`).

Not rewritten by the pull: size labels and `erp_group_key` of products created by pulls before the
2026-10-25 mapping rule was deployed (the stand-in demo products here). Those pulls labelled sizes from the
stock unit (`"50pcs"`) and keyed products `pos:<category>|<name>`; a new sibling FG of such a product creates
a new product. Delete or unlink the demo products in step 2; see `erp-catalog-sync.md` §1 for the queries.

## 7. Rollback (each line is independent)

- Stop sending at once: `gcloud scheduler jobs pause erp-relay --project $P --location $R` (and the pull).
- Switch the integration off: traffic back to the previous revision
  `gcloud run services update-traffic mandalika-pos --region $R --project $P --to-revisions <PREV>=100`
  (fastest), or a new revision with `--update-env-vars ERP_RELAY_ENABLED=false,ERP_INTEGRATION_ENABLED=false`.
  Both endpoints then answer 503; outbox rows stay queued and inert.
- Remove the jobs: `gcloud scheduler jobs delete erp-relay --project $P --location $R --quiet` and
  `... delete erp-catalog-pull-incremental ...`.
- Remove the stub: `gcloud run services delete mandalika-erpstub --region $R --project $P --quiet`.
- The secrets can stay (the real ERP key becomes a new `ERP_API_KEY` version); delete them only if the
  integration is abandoned.
- Data left behind: demo products/variants (linked to FG slugs that exist only in the stub), the demo
  outlet's `erp_slug`/`erp_code` (and its name/address/phone, which every pull copies from the stub), the
  warehouse `erp_slug`, and outbox rows marked `delivered`/`replayed`
  that went only to the stub. **Before switching to erp-flamboyan:** those rows will never reach the real
  ERP (it would hold no opening stock for the demo FGs); either accept that (test data) or re-queue them
  (`cmd/erp-relay -retry <id>`), and unlink or delete the demo variants and the demo outlet mapping so the
  real ERP catalog links cleanly. Never change `ERP_BRAND` to work around it.
