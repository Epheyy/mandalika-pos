# ERP catalog sync runbook (plan step 4)

The ERP (erp-flamboyan) is the catalog master. The POS pulls finished goods (one ERP FG = one POS product
variant) and outlets from the ERP Integration API v1 and keys them on the ERP's stable `slug`. Code:
`backend/internal/integration/erp` (`catalog.go`, `catalog_store.go`, `mapping.go`, `client.go`).

Nothing in this runbook runs by itself. Every step below is an owner action on deploy day.

## 1. What the pull does (mapping v3, 2026-10-26)

Rules from the sandbox pull against the production ERP: `docs/integration/2026-10-26-erp-sandbox-pull-report.md`
§6 and §8, and the owner decisions of 2026-10-26. The pure naming rules are in `erpmap`.

| ERP field | POS effect |
|---|---|
| FG `slug` | `product_variants.erp_slug` (the key) |
| FG `code` | `product_variants.sku` (immutable in the ERP); also the barcode of a NEW variant. The fragrance part of the code (`PP120E-NO1` → `NO1`) groups sizes into one product |
| FG `is_others` | true (display, tester, paper, box, packaging): its **own product**, `erp:<code>`, named `<ERP name> (<code>)`, label `Satuan`, `sellable=false`, price 0, category `ERP: bukan untuk dijual` (owner decision b). The owner may sell one; the pull never flips it back |
| FG `name` | name of a NEW product only: ERP name minus the ` - <n>ML <line>` suffix; a taken name gets ` (<fragrance code>)` and a run note |
| FG `category` | the product LINE in the label of a NEW variant: `<size>ml <LINE>` via the 7-row table (EXT → EXTRAIT DE PARFUM, PERFUME INTENSE → PARFUM INTENSE, ATOMIZER, GLASS WOMAN, GLASS MAN, LEATHER, GLITTER; an unknown category passes through upper-cased and is noted). Stored on the variant (`erp_category`), never a POS category |
| FG `gender` | category of a NEW fragrance product only: majority gender of the page's group → MAN / WOMAN / UNISEX, matched to an existing POS category (never created; none → no category) |
| FG `size` + `unit` | size part of the label, set ONCE at creation. `unit` is the ERP stock unit (Pcs): 110 + Pcs = `110ml` |
| FG `status` DISCONTINUE, or `deleted_at` | variant `is_active = false` (never deleted) |
| outlet `slug` / `code` | link only: `outlets.erp_slug` / `erp_code` of the one unlinked POS outlet whose code equals the ERP code or slug. Never creates an outlet; never links `type = ONLINE`; unlinked ERP outlets are a run note |
| outlet name / address / phone | **never written** (POS-owned) |
| outlet `deleted_at` | outlet `is_active = false` |

Never touched by the pull on an existing row: product name, category, brand, sellable, images; variant
size, price, barcode, images; outlet name, address, phone, code; bundles, recipes, loyalty, stock. The POS
owns these and they are editable in the backoffice even on linked rows (only a linked variant's size and SKU,
removing a linked variant and deleting a linked product stay locked). What the ERP says about each size is
kept on the variant (`erp_name`, `erp_category`) as the drift record.

- A new sellable FG joins the product whose `erp_group_key` is `erp:<fragrance code>`; else the one product
  (key NULL or `pos:...`) that already holds a linked variant of that fragrance code; else it creates a new
  product, **not sellable** until priced (D20). Two such products is an item error (give one the key). A code
  without a fragrance part falls back to `pos:<name minus size>`. Existing POS products get their key from the
  SKU-mapping CSV (§2).
- A new FG whose label already exists in the target product is an item error, never a duplicate (for
  example an unmapped wrong POS SKU holding `120ml EXTRAIT DE PARFUM`).
- An ERP variant whose resolved outlet price is 0 never reaches a tablet.
- `products.is_active` is only ever switched OFF by the pull (all its variants inactive); an admin switches
  it back on.
- Watermark: the first page's `server_time` of the last completed run; incremental runs ask
  `updated_since = watermark - 5 min`. A partial or failed run never moves it.
- Full run reconcile: linked variants missing from a complete full run are deactivated, at most
  max(5, 20%) per run (more is refused and reported in `last_error`). **Outlets are report-only**: a missing
  outlet is never deactivated by reconcile (open owner decision, see §6).
- Single flight: one run at a time (Postgres advisory lock); a second call answers `skipped_locked`.

Status: `SELECT * FROM integration_watermarks;` and
`SELECT * FROM erp_sync_runs ORDER BY started_at DESC LIMIT 20;`

## 2. One-time SKU mapping (plan §4.2) — before the first pull

Existing POS variants must be linked to their ERP FG first, or the first pull creates duplicates (it never
links variants by SKU on its own; an unlinked variant whose SKU equals an FG code is reported as a conflict).

1. **Read-only duplicate count on Neon** (owner OK needed; DSN from Secret Manager, never pasted):
   ```sql
   SELECT sku, count(*) FROM product_variants GROUP BY sku HAVING count(*) > 1;
   SELECT count(*) FROM product_variants WHERE sku LIKE 'SKU-%';
   ```
2. **Export**: Backoffice admin, or `GET /api/v1/admin/erp/sku-mapping/export` (admin role) → CSV with
   `variant_id, product, size, sku, has_stock, barcode, fg_code, fg_slug, erp_group_key`.
3. **Fill** `fg_code` and `fg_slug` from the ERP catalog (for the 2026-10-26 cutover the file is ready:
   `docs/integration/2026-10-26-sku-mapping-cutover.csv`, commands in `erp-standin-demo.md` "Cutover" step 4).
   Set `erp_group_key` to `erp:<fragrance code>` on every row of a fragrance product so sibling sizes join it;
   optional context columns `fg_name`, `fg_category`, `fg_size`, `fg_is_others` make the dry run warn on name
   and label conflicts. The ERP developer can export codes and slugs; FG codes never
   change, so this is done once. Leave both empty for a variant that has no ERP FG yet. `erp_group_key`
   is optional (all rows of one product must agree).
4. **Dry run, then apply**: `POST /api/v1/admin/erp/sku-mapping/import` with the CSV, `dryRun: true` first,
   then the commit with an `Idempotency-Key` and the preview's hash (same contract as the product CSV import).
   It sets `sku = fg_code`, `erp_slug = fg_slug` and the group key; barcodes stay as they are (printed
   labels stay valid); size and stock are never touched. Duplicates, unknown variant ids and codes or
   slugs already used elsewhere are row errors and nothing is written.
5. Re-run step 1. When it returns 0 duplicates, schedule migration 0067 (§5).

## 3. Enable the pull (deploy day)

gcloud writes command arguments into its log files (`%APPDATA%\gcloud\logs` on Windows,
`~/.config/gcloud/logs` elsewhere). Run every command in §3–§4 that carries a secret with file logging off:
`export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1` (PowerShell: `$env:CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1`).

Secrets (create once; values never pasted into chat or files; values come in on stdin):
```bash
gcloud secrets create ERP_API_KEY --project mandalika-pos --replication-policy automatic
gcloud secrets create ERP_SCHEDULER_TOKEN --project mandalika-pos --replication-policy automatic
openssl rand -hex 32 | gcloud secrets versions add ERP_SCHEDULER_TOKEN --project mandalika-pos --data-file=-
gcloud secrets versions add ERP_API_KEY --project mandalika-pos --data-file=-   # paste the ERP-issued key, then Ctrl-D
```
The server trims the trailing newline. The Cloud Run service account needs `roles/secretmanager.secretAccessor`
on both secrets (same as the existing secrets; check with
`gcloud secrets get-iam-policy ERP_API_KEY --project mandalika-pos`).

Wire them into Cloud Run (a new revision):
```bash
gcloud run services update mandalika-pos --region asia-southeast2 --project mandalika-pos \
  --update-secrets ERP_API_KEY=ERP_API_KEY:latest,ERP_SCHEDULER_TOKEN=ERP_SCHEDULER_TOKEN:latest \
  --update-env-vars ERP_INTEGRATION_ENABLED=true,ERP_BASE_URL=https://<erp-host>/api/integration/v1
```

First full run: use the CLI from a trusted machine, from `backend/`, with a long budget (an HTTP-triggered
run is capped at 20 s). The CLI never runs migrations. Inject the Neon DSN from Secret Manager explicitly:
`config.Load` also reads `backend/.env`, which points at the LOCAL database.
```bash
DATABASE_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL --project mandalika-pos)" \
ERP_BASE_URL="https://<erp-host>/api/integration/v1" \
ERP_API_KEY="$(gcloud secrets versions access latest --secret=ERP_API_KEY --project mandalika-pos)" \
go run ./cmd/erp-catalog-pull -mode full -budget 5m
```
Exit 0 = completed, partial or skipped_locked; 1 = failed. Later manual runs can use the admin endpoint
`POST /api/v1/admin/erp/catalog-pull?mode=full` (admin JWT; default mode full) and
`GET /api/v1/admin/erp/sync-runs` to read the run rows.

## 4. Cloud Scheduler jobs (deploy day; not created by any code)

Incremental every 15 min and full daily at 02:07 WIB. The full job must NOT share a minute with the
incremental one: whichever takes the lock first wins and the other answers 200 `skipped_locked`, which
Cloud Scheduler does not retry, so a 02:00 full run could be skipped every night. First confirm the region:
`gcloud scheduler locations list --project mandalika-pos` (it must list `asia-southeast2`; otherwise use the
nearest listed region; the job region does not have to match Cloud Run).
```bash
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1   # the token below must not land in gcloud's log files
TOKEN="$(gcloud secrets versions access latest --secret=ERP_SCHEDULER_TOKEN --project mandalika-pos)"
gcloud scheduler jobs create http erp-catalog-pull-incremental \
  --project mandalika-pos --location asia-southeast2 \
  --schedule "*/15 * * * *" --time-zone "Asia/Jakarta" \
  --uri "https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/internal/erp/catalog-pull?mode=incremental" \
  --http-method POST --headers "X-Scheduler-Secret=${TOKEN}" --attempt-deadline 60s
gcloud scheduler jobs create http erp-catalog-pull-full \
  --project mandalika-pos --location asia-southeast2 \
  --schedule "7 2 * * *" --time-zone "Asia/Jakarta" \
  --uri "https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/internal/erp/catalog-pull?mode=full" \
  --http-method POST --headers "X-Scheduler-Secret=${TOKEN}" --attempt-deadline 60s
unset TOKEN
```
The header value is stored in the job definition (visible to project viewers); OIDC replaces it after the
demo (plan D15). Rotating the token = new secret version, a Cloud Run revision, and
`gcloud scheduler jobs update http <job> --update-headers X-Scheduler-Secret=...` for both jobs (again with
`CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1`; the value is also briefly visible in the process list).

## 5. Migration 0067 (global SKU uniqueness) — a separate, later deploy

Only after §2 step 1 returns 0 duplicates on Neon (migrations run at boot; a duplicate would crash-loop
the revision). Add `backend/internal/db/migrations/0067_variant_sku_global_unique.sql`:
```sql
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX product_variants_sku_global ON product_variants (sku);
```
The per-product index stays. Product create/update already answers 409 for a SKU used by another product.

## 6. Rollback and open decisions

- Stop all pulls: `ERP_INTEGRATION_ENABLED=false` (new revision), or pause the jobs:
  `gcloud scheduler jobs pause erp-catalog-pull-incremental --location asia-southeast2 --project mandalika-pos`
  (and `erp-catalog-pull-full`).
- 0066 is additive; leave it in place. The read filter and gating are code-only.
- Open: should a full-run reconcile ever deactivate an outlet (today report-only)? Should the ERP
  re-activating a variant also switch its product back on (today an admin does it)?
