# ERP catalog sync runbook (plan step 4)

The ERP (erp-flamboyan) is the catalog master. The POS pulls finished goods (one ERP FG = one POS product
variant) and outlets from the ERP Integration API v1 and keys them on the ERP's stable `slug`. Code:
`backend/internal/integration/erp` (`catalog.go`, `catalog_store.go`, `mapping.go`, `client.go`).

Nothing in this runbook runs by itself. Every step below is an owner action on deploy day.

## 1. What the pull does

| ERP field | POS effect |
|---|---|
| FG `slug` | `product_variants.erp_slug` (the key) |
| FG `code` | `product_variants.sku` (immutable in the ERP); also the barcode of a NEW variant |
| FG `name` | product name, size token removed ("Oud 50ml" → "Oud"); written by the product's owner FG only (below) |
| FG `category` | category, matched by name (case-insensitive), created if missing; written by the owner FG only |
| FG `size` + `unit` | size label `"<n>ml"` (`"Satuan"` when size is null), set ONCE at creation, never renamed. `unit` is the ERP stock unit (Pcs, Botol): it never becomes the suffix (110 + Pcs = `"110ml"`). Only a measurement unit (ml, l, g, gr, kg) replaces `ml` |
| FG `status` DISCONTINUE, or `deleted_at` | variant `is_active = false` (never deleted) |
| outlet `slug` / `code` | `outlets.erp_slug` / `outlets.erp_code`. `outlets.code` (receipt numbers) is NEVER written |
| outlet name / address / phone | copied |
| outlet `deleted_at` | outlet `is_active = false` |

Never touched by the pull: price, images, barcode of an existing variant, bundles, recipes, loyalty, stock.

- A new FG joins the product with the same `erp_group_key` = `pos:<name minus size>` (normalised), whatever
  its ERP category: the ERP may file sizes of one fragrance under different categories (local pull of
  2026-10-23). Category only breaks a tie: when that product is filed under another category, the FG goes to
  the `pos:<name minus size>|<category>` product if one exists, or to a new one if the name product already
  has the FG's size label (for example an EDP and a body mist both called "Dune 100ml"). Otherwise it creates
  a new product that is **not sellable** until priced (D20). An ERP variant whose resolved outlet price is 0
  never reaches a tablet.
- Grouping depends on arrival order and is permanent: two product lines with one name ("Dune" EDP and
  "Dune" body mist) share the name product until a size collides, and only later FGs go to the tie product.
  Rename such lines in the ERP if they must stay apart.
- The product's name and category follow its **owner FG**: among its linked FGs, active ones first, then
  the smallest `code` (byte order). A discontinued or deleted owner hands over to the next live sibling.
  Siblings that disagree never flip them, so a rerun full pull bumps no content version. A non-owner only
  fills a missing category.
- Existing keys and labels are never rewritten. Products created by a pull before this rule was deployed
  keep `pos:<category>|<name>` keys and any `"<n>pcs"` labels (the stand-in demo on the test environment
  has some), and a new sibling FG of such a product creates a new product. List them first:
  `SELECT id, name, erp_group_key FROM products WHERE erp_group_key LIKE 'pos:%|%';` (new tie keys match
  too: `pos:<name>|<category>`) and
  `SELECT product_id, size, sku FROM product_variants WHERE erp_slug IS NOT NULL AND size ~ '[0-9]pcs$';`.
  Re-key through the SKU-mapping CSV `erp_group_key` column (new format) only BEFORE the first pull on the
  new rule (afterwards the new key is taken and the CSV answers `group_key_in_use`). A size label has no
  supported fix path (the CSV never changes size, the backoffice answers 409): it needs a reviewed SQL change
  that also renames `outlet_variant_stock.variant_size`, so prefer deleting demo rows before cutover.
- `products.is_active` is only ever switched OFF by the pull (all its variants inactive); an admin switches
  it back on.
- A new ERP outlet is linked to the one unlinked POS outlet with the same code (case-insensitive), else
  created inactive with no POS code, for an admin to finish.
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
3. **Fill** `fg_code` and `fg_slug` from the ERP catalog (the ERP developer can export them; FG codes never
   change, so this is done once). Leave both empty for a variant that has no ERP FG yet. `erp_group_key`
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
