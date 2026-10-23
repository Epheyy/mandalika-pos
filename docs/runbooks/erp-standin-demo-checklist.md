# Demo checklist: POS ↔ ERP stand-in (2 Nov)

Follows the demo script in `docs/plans/2026-10-22-reorg-and-erp-demo-plan.md` §6.1. Setup and rollback are
in `erp-standin-demo.md`. Each row: what to do, what must happen, and where to show it.

## Before the audience arrives (T-60 min)

- [ ] Stub warm: `mandalika-erpstub` at `--min-instances 1` (runbook §6).
- [ ] Rehearsal run green against the live test env today (`go run ./cmd/erp-rehearsal -live -run-id <id> ...`,
      runbook B6). Keep its output open: it is the evidence table.
- [ ] Scheduler jobs `erp-relay` and `erp-catalog-pull-incremental` **paused** during the demo, so every
      relay run and pull happens on screen ("Kirim sekarang" / "Tarik katalog sekarang"). Resume after.
- [ ] Tablet (APK 2.1 / OTA 2.1.5) logged in at the demo outlet, shift open, "Sinkron" done.
- [ ] Backoffice open on **Integrasi ERP** (dead-letter/outbox view + sync runs) and on the product list.
- [ ] A terminal with the stub hooks ready (key from Secret Manager, never on screen):
      ```bash
      export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1
      STUB=$(gcloud run services describe mandalika-erpstub --region asia-southeast2 --project mandalika-pos --format 'value(status.url)')
      KEY=$(gcloud secrets versions access latest --secret ERP_API_KEY --project mandalika-pos)
      h() { curl -s -H "Authorization: Bearer $KEY" "$@"; }
      # h "$STUB/_stub/documents" | python -m json.tool
      # h "$STUB/_stub/balances"  | python -m json.tool
      ```
- [ ] Optional: a read-only psql session for the §2.4 invariant query (owner OK for the Neon read).

## Demo steps

| # | Action | Expected | Show in backoffice | Show in stub |
|---|---|---|---|---|
| 1 | Open the product list | Demo products carry the "Dari ERP" badge; SKU = FG code; name/size/category/SKU read-only | Product list → a demo product → variant fields greyed | `h "$STUB/api/integration/v1/catalog/finished-goods?take=50"` lists the same FG codes |
| 2 | Create an FG live: `h -X POST "$STUB/_stub/fg" -d '{"slug":"fg-demo-live","code":"<NEW CODE>","name":"Demo Live 50ml","category":"Eau de Parfum","size":50,"unit":"PCS"}'`, then **Tarik katalog sekarang** (incremental) | Sync run `completed`; new variant under the matching product (or a new product), price 0, **not sellable**; set a price → tablet "Sinkron" → item appears | Integrasi ERP → sync runs (newest row); product list | the FG is in the catalog read |
| 3 | Sell 2 items on the tablet, one line more than its stock | `/sync/batch` ok; 2 `sale` movements, one flagged shortage; outbox document `pending` → **Kirim sekarang** → `delivered` | Integrasi ERP → outbox: the sale document `delivered`; sale stock exceptions show the shortage | `_stub/documents`: kind `sale`, lines with the FG codes; `_stub/balances`: outlet −qty |
| 4 | Replay: on the delivered sale document click **Kirim ulang**, then **Kirim sekarang** | ERP answers `replayed`; balance unchanged. (The tablet replaying its own batch item is covered by the rehearsal: 0 new movements) | Document status `replayed` | `_stub/balances` unchanged; still one sale document |
| 5 | Refund the sale on the tablet, then **Kirim sekarang** | `refund` movements +qty; document `delivered` | Outbox: refund document `delivered` | `_stub/balances` back to the pre-sale value |
| 6 | Transfer gudang → outlet, 10 units: **Kirim** (double-click), then receive 9 on the tablet; **Kirim sekarang** | One `transfer_out` (−10 warehouse) despite the double click; `transfer_in` +9 with a variance; two documents with the same `ref.id` | Transfer detail (one transfer, variance 1); outbox: two transfer documents `delivered` | `_stub/documents`: `transfer_out` at `warehouse/gudang-pusat`, `transfer_in` at the outlet, same `ref.id`; balances −10 / +9 |
| 7 | Goods receipt at the outlet, submitted twice with the same key (the rehearsal does the double submit) | One receipt, one `receipt` document | Outbox: one receipt document | One `receipt` document |
| 8 | Fault: `h -X POST "$STUB/_stub/fault?status=503&count=1"`, sell 1, **Kirim sekarang** | Document `pending`, attempts 1, last error 503; next run after the backoff (≈2 min) → `delivered` | Outbox row: attempts and error, then `delivered` | Document appears only after the retry |
| 9 | Dead-letter: tombstone one demo FG `h -X POST "$STUB/_stub/fg" -d '{...same FG..., "deleted_at":"2026-11-02T00:00:00Z"}'`, sell it, **Kirim sekarang**; then restore the FG (same body without `deleted_at`) and **Kirim ulang** + **Kirim sekarang** | 422 → `dead`, list shows `VALIDATION_ERROR: validation failed` (the detail view holds the ERP body: `fg_code` unknown finished good); after the fix → `delivered`. Do NOT pull the catalog between tombstone and restore (the pull would deactivate the variant) | Integrasi ERP → dead-letter list shows the reason; then `delivered` | Document present only after the fix |
| 10 | Try to delete a demo variant that has stock | 409 "varian masih punya stok di <lokasi>; nolkan lewat penyesuaian dulu" | Product edit → delete variant → error toast | — |
| 11 | Agreement | POS stock per location = stub balance per FG; §2.4 invariant query returns 0 rows | Warehouse stock / outlet stock screens | `_stub/balances` side by side; `h "$STUB/api/integration/v1/outlets/<CODE>/stock?fg_codes=<codes>"` |

## Rehearsal output (what a green run prints, per harness step)

Local reference run 2026-10-23 (`scripts/erp-rehearsal-local.sh`, 15/15 PASS, ~2.5 min):

| Step | Demo row | Expected evidence lines |
|---|---|---|
| 0 preflight | — | admin login ok; relay enabled; stub key accepted; outlet + warehouse found; run id fresh |
| 1 seed stub | 1 | 3 FGs + outlet upserted |
| 2 first pull | 1 | sync-run `completed`; variants sku = FG code, price 0; outlet linked (`erpSlug`) |
| 3 new FG + incremental | 2 | FG D created by hook; incremental run `completed`; variant D price 0 |
| 4 price | 2 | 4 variants priced 100000 and visible at the outlet |
| 5 opening stock | 7 | outlet receipt twice, same key → 200 then 200 (replay); 1 `receipt` document per FG; stub balances = receipts |
| 6 sale | 3, 4 | 2 sale movements, 1 shortage; batch replay → `duplicate`, still 1 outbox document |
| 7 relay | 3 | sale document `delivered`; stub balances A 8, B −2 (B oversold) |
| 8 retry | 4 | `replayed=1`; balances unchanged |
| 9 refund | 5 | refund document `delivered`; balances back to A 10, B 1 |
| 10 transfer | 6 | send twice, same key → one transfer; `transfer_out@gudang-pusat` + `transfer_in@<outlet>` share `ref.id`; `qty=9 expected_qty=10 flags=[variance]` |
| 11 fault | 8 | `pending attempts=1 lastHttpStatus=503`; `delivered` after ~2 min, attempts 2 |
| 12 dead-letter | 9 | `dead http=422`, visible in `/admin/erp/outbox?status=dead`; after restore + retry `delivered` |
| 13 delete guard | 10 | PUT and DELETE → 409 "varian masih punya stok di outlet …; nolkan lewat penyesuaian dulu" |
| 14 agreement | 11 | per FG: outlet/warehouse POS stock = stub balance = stub stock API; all run documents on the stub; with a DSN: invariant 0 rows, ledger sums = stub |

## Talking points / known stand-in behaviour

- "Held" rows in the outbox are documents for outlets/variants that are not mapped to the ERP yet (the
  stand-in only knows the demo catalog). They are re-checked every 5 minutes and flow once mapped.
- The stand-in keeps its ledger in memory; it is a contract test double, not the ERP. Switching to
  erp-flamboyan is `ERP_BASE_URL` + a new `ERP_API_KEY` version, nothing else.
- Out of scope (handoff §8): daily reconciliation report, ERP-to-POS corrections, ingredients, ERP movement
  reports.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `Kirim ulang` gives `delivered` instead of `replayed`; stub balances look reset | Stub cold-started (state lost) | Explain; re-run the rehearsal with a new `-run-id` after the demo, check `--min-instances 1` |
| Every document `held` | Outlet/variant/warehouse has no `erp_slug` | Pull the catalog; warehouse needs runbook B3 |
| Relay or pull answers 503 | Integration flags off on the serving revision | Check the env of the 100% revision (runbook B4) |
| Documents stay `pending` with a 401 error | Stub and POS keys differ | Both read `ERP_API_KEY:latest`; roll the stub (`gcloud run services update mandalika-erpstub ... --update-secrets ERP_STUB_KEY=ERP_API_KEY:latest`) |
