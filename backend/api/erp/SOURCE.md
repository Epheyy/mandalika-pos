# ERP Integration API v1 spec snapshot

| | |
|---|---|
| Source repo | erp-flamboyan (separate developer) |
| Source file | `docs/integration/openapi.v1.json` |
| Source commit | `main` @ `1c1d08f5` |
| Git blob | `e4e8829f09d6712b478c65661d342d3c3501966e` (identical bytes) |
| Snapshot date | 2026-10-21 |
| OpenAPI version | 3.1.0 |

`openapi.v1.json` is a byte-for-byte copy. Do not edit it by hand. To refresh, copy the file from a newer ERP
commit, update this table, and regenerate `internal/integration/erp/erpapi/erp.gen.go`.

The ERP generates this file from `@erp/shared/integration/*`. It covers the read API only
(`/catalog/finished-goods`, `/catalog/outlets`, `/outlets/{code}/stock`). The POS-to-ERP write endpoint
`POST /stock-documents` is not in it yet; its proposed contract is `docs/integration/stock-documents.v1.yaml`.
