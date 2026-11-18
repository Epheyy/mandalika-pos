# POS -> staging ERP joint test: stock documents (sale, void, void-and-replace, refund)

Date: 2026-11-18. Status: **Part 1 and Part 2 done. All 6 steps PASS; idempotent re-send PASS.** Owner approved sending exactly these 6 documents (about 10:27 UTC).


- Local backend (this worktree, `prod-hardening` at 18a2f168) on :8080, database `erp_joint` created fresh in the `roletest` Postgres (port 5433), so it holds no opening, backfill or other earlier rows.
- ERP: `https://staging-erp.mandalika.web.id/api/integration/v1`, client `pos_mandalika`, key read at launch from GCP Secret Manager as a process env var only (never written down).
- Relay: `ERP_RELAY_ENABLED` is OFF, so `POST /internal/erp/relay` answers `disabled`. Nothing has been posted to staging; only read-only calls were made (`GET /outlets/BSD/stock` = empty list, catalog pull of outlets and finished goods).
- Local outlet "Joint Test BSD" (`6be4e350-d726-4499-950f-63be742f170b`) is linked to staging outlet code `BSD` by the real catalog pull (outlets.erp_code=BSD, erp_slug=bsd).
- FG-A = `PP100E-24H` (24HOURS 100ml EXTRAIT), FG-B = `PP100E-DAY` (DAY 100ml EXTRAIT); both came from the staging catalog pull (375 FGs). Local price set to Rp100.000 for both (the ERP catalog carries no price).
- Scenario created through the backend's normal paths (POST /shifts, POST /inventory/goods-receipt for local opening stock, then POST /sync/batch items order, void, void with mode replace, refund), as the local admin user.

## Keeping everything else out of the send

The local DB has 7 outbox rows: the 6 scenario documents plus one opening-stock `receipt` (the goods receipt that gave the outlet local stock; it must never be sent, because it would post +10 FG-A and +10 FG-B to staging). All 7 rows are parked with `next_attempt_at = 2100-01-01`, and the relay claim query only takes rows with `next_attempt_at <= now()`, so even with the relay switched on nothing is claimed. In Part 2 each step is released alone with `UPDATE erp_outbox SET next_attempt_at = now() WHERE id = '<id>'` followed by one relay pass. The opening receipt row (`294b80e0`) is never released. Its payload is shown at the end only to prove what it would have sent.

## Plan (in send order) and expected staging BSD balance

| # | Step | Outbox row | Wire kind | ref (type / number) | Lines (fg_code, qty, refund_of_movement_id) | Tenders | Expected BSD after (FG-A / FG-B) |
|---|------|-----------|-----------|----------------------|----------------------------------------------|---------|-----------------------------------|
| 1 | S1 sale (2 x FG-A) | `6f2da565` | `sale` | order / MND-000001 | PP100E-24H -2 | cash 200000 | -2 / 0 |
| 2 | S1 void, no replacement | `25cbe379` | `refund` | void / MND-000001 | PP100E-24H +2 (refund_of d85dbc7d...) | cash -200000 | 0 / 0 |
| 3 | S2 sale (1 x FG-A) | `5df81de5` | `sale` | order / MND-000002 | PP100E-24H -1 | cash 100000 | -1 / 0 |
| 4 | S2 void (part of void-and-replace) | `0cbaebcb` | `refund` | void / MND-000002 | PP100E-24H +1 (refund_of eed7f143...) | cash -100000 | 0 / 0 |
| 5 | S2 replacement sale (1 x FG-B) | `1a9e537c` | `sale` | order / MND-000003 | PP100E-DAY -1 | cash 100000 | 0 / -1 |
| 6 | R refund of the replacement (1 x FG-B) | `e5407373` | `refund` | order / MND-000003 | PP100E-DAY +1 (refund_of 2856089c...) | cash -100000 | 0 / 0 |

Starting point: BSD stock list is empty (read-only check today), so both balances start at 0. A refund must carry a positive qty and a sale a negative qty (ERP rule); each document below satisfies it. Document id = Idempotency-Key. location.code is `BSD` on all; occurred_at is today, well inside the 6-month window.

## Exact documents (output of the real `BuildDocument` path via `backend/cmd/erp-joint-preview`)

### Step 1: S1 sale (2 x FG-A)

Outbox row `6f2da565-c1d1-4926-9d64-3da2914599a7`, local kind `sale`, wire kind `sale`, document_id (Idempotency-Key) `d2f564ab-1a2c-5032-b65e-8c51a225ff63`

```json
{
  "document_id": "d2f564ab-1a2c-5032-b65e-8c51a225ff63",
  "kind": "sale",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "device_id": "821c84e9-06c6-4a80-b21c-079309e0091b",
    "actor": "0857ad9f-3868-429a-90f8-0f099a55d4af"
  },
  "location": {
    "type": "outlet",
    "code": "BSD",
    "slug": "bsd"
  },
  "occurred_at": "2026-11-18T10:12:07Z",
  "recorded_at": "2026-11-18T10:12:07Z",
  "ref": {
    "type": "order",
    "id": "ddd2e0fc-bf83-492a-98cb-df5f1970d008",
    "number": "MND-000001"
  },
  "lines": [
    {
      "movement_id": "d85dbc7d-2c98-5604-ada9-e258fb29ce93",
      "fg_code": "PP100E-24H",
      "qty": -2,
      "qty_before": 10,
      "qty_after": 8,
      "unit_price": 100000,
      "reason": "sale",
      "flags": []
    }
  ],
  "tenders": [
    {
      "method": "cash",
      "amount": 200000
    }
  ]
}
```

### Step 2: S1 void, no replacement

Outbox row `25cbe379-8600-47e7-9ddc-d36b8b35122f`, local kind `void`, wire kind `refund`, document_id (Idempotency-Key) `f8b2effd-c09e-55bd-a469-e33155b11ce6`

```json
{
  "document_id": "f8b2effd-c09e-55bd-a469-e33155b11ce6",
  "kind": "refund",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "actor": "0857ad9f-3868-429a-90f8-0f099a55d4af"
  },
  "location": {
    "type": "outlet",
    "code": "BSD",
    "slug": "bsd"
  },
  "occurred_at": "2026-11-18T10:12:07Z",
  "recorded_at": "2026-11-18T10:12:07Z",
  "ref": {
    "type": "void",
    "id": "ddd2e0fc-bf83-492a-98cb-df5f1970d008",
    "number": "MND-000001"
  },
  "lines": [
    {
      "movement_id": "b92c6531-b4ef-5123-aa7e-5252872b8785",
      "fg_code": "PP100E-24H",
      "qty": 2,
      "qty_before": 8,
      "qty_after": 10,
      "unit_price": 100000,
      "reason": "refund",
      "flags": [],
      "refund_of_movement_id": "d85dbc7d-2c98-5604-ada9-e258fb29ce93"
    }
  ],
  "tenders": [
    {
      "method": "cash",
      "amount": -200000
    }
  ]
}
```

### Step 3: S2 sale (1 x FG-A)

Outbox row `5df81de5-826c-497c-af50-88693c267124`, local kind `sale`, wire kind `sale`, document_id (Idempotency-Key) `1f183533-4104-57c4-b051-ac7cfd340e85`

```json
{
  "document_id": "1f183533-4104-57c4-b051-ac7cfd340e85",
  "kind": "sale",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "device_id": "821c84e9-06c6-4a80-b21c-079309e0091b",
    "actor": "0857ad9f-3868-429a-90f8-0f099a55d4af"
  },
  "location": {
    "type": "outlet",
    "code": "BSD",
    "slug": "bsd"
  },
  "occurred_at": "2026-11-18T10:12:07Z",
  "recorded_at": "2026-11-18T10:12:07Z",
  "ref": {
    "type": "order",
    "id": "c6d3fe08-c4b3-4e02-a345-d4e09485c938",
    "number": "MND-000002"
  },
  "lines": [
    {
      "movement_id": "eed7f143-109c-5ce3-89af-ac9f24b3942f",
      "fg_code": "PP100E-24H",
      "qty": -1,
      "qty_before": 10,
      "qty_after": 9,
      "unit_price": 100000,
      "reason": "sale",
      "flags": []
    }
  ],
  "tenders": [
    {
      "method": "cash",
      "amount": 100000
    }
  ]
}
```

### Step 4: S2 void (part of void-and-replace)

Outbox row `0cbaebcb-3de9-4f0b-bf97-90f551be8d9c`, local kind `void`, wire kind `refund`, document_id (Idempotency-Key) `2b541481-7b24-5be4-8f73-a696ac2e36f0`

```json
{
  "document_id": "2b541481-7b24-5be4-8f73-a696ac2e36f0",
  "kind": "refund",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "actor": "0857ad9f-3868-429a-90f8-0f099a55d4af"
  },
  "location": {
    "type": "outlet",
    "code": "BSD",
    "slug": "bsd"
  },
  "occurred_at": "2026-11-18T10:12:07Z",
  "recorded_at": "2026-11-18T10:12:07Z",
  "ref": {
    "type": "void",
    "id": "c6d3fe08-c4b3-4e02-a345-d4e09485c938",
    "number": "MND-000002"
  },
  "lines": [
    {
      "movement_id": "efcbe725-2ca9-5ed1-9f8c-db52305b4271",
      "fg_code": "PP100E-24H",
      "qty": 1,
      "qty_before": 9,
      "qty_after": 10,
      "unit_price": 100000,
      "reason": "refund",
      "flags": [],
      "refund_of_movement_id": "eed7f143-109c-5ce3-89af-ac9f24b3942f"
    }
  ],
  "tenders": [
    {
      "method": "cash",
      "amount": -100000
    }
  ]
}
```

### Step 5: S2 replacement sale (1 x FG-B)

Outbox row `1a9e537c-7508-4f43-9827-129ee48b88f3`, local kind `sale`, wire kind `sale`, document_id (Idempotency-Key) `4346bcdd-5c6c-532b-886b-e9ca3ab24ce1`

```json
{
  "document_id": "4346bcdd-5c6c-532b-886b-e9ca3ab24ce1",
  "kind": "sale",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "device_id": "821c84e9-06c6-4a80-b21c-079309e0091b",
    "actor": "0857ad9f-3868-429a-90f8-0f099a55d4af"
  },
  "location": {
    "type": "outlet",
    "code": "BSD",
    "slug": "bsd"
  },
  "occurred_at": "2026-11-18T10:12:08Z",
  "recorded_at": "2026-11-18T10:12:07Z",
  "ref": {
    "type": "order",
    "id": "80aa900d-19c3-4d9d-b6e5-acefdcb7cded",
    "number": "MND-000003"
  },
  "lines": [
    {
      "movement_id": "2856089c-52a0-53dd-abe6-6558b8ebfc99",
      "fg_code": "PP100E-DAY",
      "qty": -1,
      "qty_before": 10,
      "qty_after": 9,
      "unit_price": 100000,
      "reason": "sale",
      "flags": []
    }
  ],
  "tenders": [
    {
      "method": "cash",
      "amount": 100000
    }
  ]
}
```

### Step 6: R refund of the replacement (1 x FG-B)

Outbox row `e5407373-0f69-478c-b832-3900f8f9d0f2`, local kind `refund`, wire kind `refund`, document_id (Idempotency-Key) `5fd89fa1-625f-5a0e-8729-cca18e9b7f85`

```json
{
  "document_id": "5fd89fa1-625f-5a0e-8729-cca18e9b7f85",
  "kind": "refund",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "actor": "0857ad9f-3868-429a-90f8-0f099a55d4af"
  },
  "location": {
    "type": "outlet",
    "code": "BSD",
    "slug": "bsd"
  },
  "occurred_at": "2026-11-18T10:12:08Z",
  "recorded_at": "2026-11-18T10:12:08Z",
  "ref": {
    "type": "order",
    "id": "80aa900d-19c3-4d9d-b6e5-acefdcb7cded",
    "number": "MND-000003"
  },
  "lines": [
    {
      "movement_id": "563f76ca-d906-5b2d-bcf0-946e065b58da",
      "fg_code": "PP100E-DAY",
      "qty": 1,
      "qty_before": 9,
      "qty_after": 10,
      "unit_price": 100000,
      "reason": "refund",
      "flags": [],
      "refund_of_movement_id": "2856089c-52a0-53dd-abe6-6558b8ebfc99"
    }
  ],
  "tenders": [
    {
      "method": "cash",
      "amount": -100000
    }
  ]
}
```

### NOT sent: opening-stock receipt (parked forever)

```json
{
  "document_id": "cf7daec3-57e4-5b92-8dee-ed35825de033",
  "kind": "receipt",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "actor": "0857ad9f-3868-429a-90f8-0f099a55d4af"
  },
  "location": {
    "type": "outlet",
    "code": "BSD",
    "slug": "bsd"
  },
  "occurred_at": "2026-11-18T10:12:07Z",
  "recorded_at": "2026-11-18T10:12:07Z",
  "ref": {
    "type": "goods_receipt",
    "id": "e90df880-d083-4ee4-8ce5-ca81221d7ba2"
  },
  "lines": [
    {
      "movement_id": "20ab8ce1-3c88-5837-9527-7ffbf2ae122a",
      "fg_code": "PP100E-DAY",
      "qty": 10,
      "qty_before": 0,
      "qty_after": 10,
      "reason": "receipt",
      "flags": []
    },
    {
      "movement_id": "07b4ddab-c375-504c-bc67-5fa93cf5b2a0",
      "fg_code": "PP100E-24H",
      "qty": 10,
      "qty_before": 0,
      "qty_after": 10,
      "reason": "receipt",
      "flags": []
    }
  ]
}
```

---

# Part 2 results (sent 2026-11-18 about 10:27 UTC, local relay one row per pass)

Each row was released alone (`next_attempt_at = now()`), one `POST /internal/erp/relay` pass, then `GET /outlets/BSD/stock`. The staging stock list omits FGs at 0 (shown as `[]`).

| # | Step | Document id (Idempotency-Key) | ERP answer | Outbox status | BSD after, FG-A / FG-B (got = expected) | Result |
|---|------|-------------------------------|-----------|---------------|------------------------------------------|--------|
| 1 | S1 sale, 2 x PP100E-24H | d2f564ab-1a2c-5032-b65e-8c51a225ff63 | 200 `applied` | delivered | -2 / 0 | PASS |
| 2 | S1 void (kind refund, ref.type void), +2 | f8b2effd-c09e-55bd-a469-e33155b11ce6 | 200 `applied` | delivered | 0 / 0 | PASS |
| 3 | S2 sale, 1 x PP100E-24H | 1f183533-4104-57c4-b051-ac7cfd340e85 | 200 `applied` | delivered | -1 / 0 | PASS |
| 4 | S2 void (kind refund, ref.type void), +1 | 2b541481-7b24-5be4-8f73-a696ac2e36f0 | 200 `applied` | delivered | 0 / 0 | PASS |
| 5 | S2 replacement sale, 1 x PP100E-DAY | 4346bcdd-5c6c-532b-886b-e9ca3ab24ce1 | 200 `applied` | delivered | 0 / -1 | PASS |
| 6 | R refund of the replacement, +1 x PP100E-DAY | 5fd89fa1-625f-5a0e-8729-cca18e9b7f85 | 200 `applied` | delivered | 0 / 0 | PASS |

No 4xx or 5xx answer on any step. Every relay pass reported claimed 1, delivered 1, held 0, dead 0.

## Idempotency

- A relay pass with nothing due: claimed 0, nothing sent.
- Re-send of step 1 (row reset to pending, same document_id): ERP answered 200 `replayed` with the same movement_id; outbox status `replayed`, attempts 2; BSD stock unchanged (`[]`, no double posting).
- The opening receipt row `294b80e0` stayed parked and was never sent.

## Left behind on staging (the ERP has no delete)

Six applied stock documents at BSD (listed above), net effect zero on both FGs. Staging holds stock-movement history for PP100E-24H and PP100E-DAY at BSD from these documents. The step 1 sale was also presented a second time and answered `replayed`.
