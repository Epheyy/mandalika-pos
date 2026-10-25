# Runbook: ERP stock-document relay (plan step 5)

The POS backend queues one `erp_outbox` row per stock document part, in the same
transaction as its `stock_movements` rows (migration 0065, `ledger.Record`). The relay
(`backend/internal/integration/erp`) sends queued documents to the ERP
(`POST /api/integration/v1/stock-documents`, contract
`docs/integration/stock-documents.v1.yaml`). A POS write never waits on the ERP: if the
relay is off or the ERP is down, documents accumulate and flow later.

## Configuration (Cloud Run env)

| Variable | Kind | Meaning |
|---|---|---|
| `ERP_RELAY_ENABLED` | plain | `true` to send. Default off: documents accumulate, nothing is sent. |
| `ERP_BASE_URL` | plain | ERP API base **including** `/api/integration/v1` (shared with the step 4 catalog pull; the erpstub URL for the demo). |
| `ERP_API_KEY` | **secret** | Bearer key with scope `integration:stock:write`. |
| `ERP_BRAND` | plain | Default `mandalika`. The ERP idempotency scope is `pos:<brand>`. **Never change it after the first document is sent**: every later document would land in a new scope and replays would not dedupe. |
| `ERP_SCHEDULER_TOKEN` | **secret** | Shared secret Cloud Scheduler sends in `X-Scheduler-Secret` (D15). At least 32 characters. Unset = `/api/v1/internal/erp/relay` answers 503 (off by default). |
| `ERP_RELAY_MAX_ATTEMPTS` | plain | Default 10. After that many failed sends a document goes to `dead`. |

Config rules (invalid config disables the relay and is logged without values):

- `ERP_API_KEY`, `ERP_SCHEDULER_TOKEN` and `ERP_BASE_URL` are trimmed of surrounding
  whitespace on load (Secret Manager values often end in a newline). A key or token that
  still contains a space or control character is rejected.
- `ERP_BASE_URL` must not contain credentials (`user:pass@`), and with `ENV=production`
  it must be `https` unless the host is `localhost`, `127.0.0.1` or `::1`.

Secrets come from Secret Manager, never `--env`:

```bash
gcloud run services update mandalika-pos --region asia-southeast2 --project mandalika-pos --update-secrets ERP_API_KEY=ERP_API_KEY:latest,ERP_SCHEDULER_TOKEN=ERP_SCHEDULER_TOKEN:latest
```

## Triggers

- **Cloud Scheduler** every 2 minutes: `POST /api/v1/internal/erp/relay` with header
  `X-Scheduler-Secret`. One run claims at most 50 due documents and stops after 20 s.
- **Backoffice** "Integrasi ERP" screen, "Kirim sekarang" (admin): `POST /api/v1/admin/erp/relay`.
- **CLI** for manual runs (DSN from `DATABASE_URL`, same env as the server):
  `go run ./cmd/erp-relay` from `backend/` (one run, prints the report as JSON).
  `go run ./cmd/erp-relay -retry <outbox id>` re-queues one dead/held/delivered/replayed
  document first. The CLI does not use or validate `ERP_SCHEDULER_TOKEN`.
- Backoffice per-document "Kirim ulang" does the same re-queue for one row.

Concurrent runs are safe: rows are claimed with `FOR UPDATE SKIP LOCKED` under a per-run
lease token, so two runs never send the same document.

## Scheduler job (deploy day; needs the owner's go-ahead; not created by the code)

Run once, after the new revision serves 100% and `ERP_RELAY_ENABLED=true` is set. The
header value is read from Secret Manager, never pasted. Note that the header value is
visible in the job definition to anyone with `cloudscheduler.jobs.get` on the project.

```bash
gcloud scheduler jobs create http erp-relay --project mandalika-pos --location asia-southeast2 --schedule "*/2 * * * *" --time-zone "Asia/Jakarta" --uri "$(gcloud run services describe mandalika-pos --region asia-southeast2 --project mandalika-pos --format 'value(status.url)')/api/v1/internal/erp/relay" --http-method POST --headers "X-Scheduler-Secret=$(gcloud secrets versions access latest --secret=ERP_SCHEDULER_TOKEN --project mandalika-pos)" --attempt-deadline 60s --max-retry-attempts 0
```

`--max-retry-attempts 0`: the relay itself retries with backoff; a failed scheduler hit
is simply followed by the next one two minutes later.

Pause / resume / remove:

```bash
gcloud scheduler jobs pause erp-relay --project mandalika-pos --location asia-southeast2
```

```bash
gcloud scheduler jobs delete erp-relay --project mandalika-pos --location asia-southeast2
```

## Document states

| Status | Meaning | What to do |
|---|---|---|
| `pending` | Due (or waiting for its backoff time). | Nothing. |
| `held` | A variant or the location has no ERP mapping (`erp_slug` empty). Re-checked every 5 minutes without counting an attempt. | Apply the SKU/outlet mapping (step 4); held documents then flow on their own. |
| `sending` | Claimed by a run (60 s lease). An expired lease is reclaimed. | Nothing. |
| `delivered` / `replayed` | ERP answered 200 `applied` / `replayed`. | Nothing. |
| `dead` | Needs a human: 400/409/422 from the ERP, or the attempt limit. The ERP's error body is stored and shown in the backoffice. | Fix the cause, then "Kirim ulang". |

Response handling:

- A 2xx counts as delivered/replayed only when the body carries a success marker, the ERP's
  `status: "success"` or the stub's legacy `success: true` (no contrary one: `success: false` or
  another `status`), with `data.document_id` = this document's id and `data.status` =
  applied|replayed. Any other 2xx body is retried and counts an attempt.
- 400/409/422 → dead at once. `last_error` is `<code>: <message>` plus up to three
  `details` as `[<path>: <message>; ...]`; the ERP's array path `["lines", 2, "fg_code"]` reads
  `lines.2.fg_code`. A 409 always ends with the frozen `payload_sha256`.
- Warehouse documents: the ERP refuses them with 422 this phase. Keep `warehouses.erp_slug` empty
  for the real ERP so they stay `held` instead of dead.
- 401/403 → the run stops and the document stays pending (5 min back-off, no attempt
  counted: a bad key would otherwise dead-letter everything).
- 429 → no attempt counted; the document waits `max(Retry-After, 1 min)` and the run stops.
- 5xx, other statuses and network errors → retry with backoff
  `min(2^attempts min, 60 min)` (at least `Retry-After`), counting an attempt.
- When the run budget expires mid-send, the unfinished rows are released back to pending
  without an attempt.

"Kirim ulang" (retry) rebuilds the payload only when the last answer was 400 or 422 (the
ERP wrote nothing, so a fixed mapping must produce a new body). After a 409, 5xx or a
timeout the frozen payload is resent byte for byte: the ERP may already hold it, and a
changed body would get 409.

## Deploy-day order

1. Deploy the release that carries migrations 0064 + 0065 (traffic-free tag), smoke, promote.
2. Wait for the old revision to drain (no instance of it serving).
3. `cmd/ledger-backfill -dry-run`, then the real run (owner OK, D13), then the §2.4
   invariant query must return 0 rows. Opening documents are queued automatically.
4. Set `ERP_BASE_URL`, `ERP_API_KEY`, `ERP_SCHEDULER_TOKEN`, then `ERP_RELAY_ENABLED=true`.
5. Trigger one run from the backoffice, check the stub/ERP shows the documents.
6. Create the Scheduler job (above).

## Rollback

- `ERP_RELAY_ENABLED=false` (or pause the job): nothing is sent; rows stay queued.
- 0065 is additive; outbox rows are inert when the relay is off.
- Delete the Scheduler job.
