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

## `openapi.v1.as30.json`: the codegen input (OpenAPI 3.0 down-conversion)

The pinned `go tool oapi-codegen` (v2.7.2, go.mod `tool` directive) cannot read 3.1 type arrays. It fails on
`type: ["string","null"]` and then on `anyOf: [X, {type: "null"}]`. So the client is generated from a mechanical
3.0 down-conversion of the snapshot (spike option (b); no go.mod change).

Rules, applied in this order and nothing else:

| Rule | 3.1 construct | 3.0 output | Count |
|---|---|---|---|
| R1 | `type: [X, "null"]` | `type: X, nullable: true` | 9 |
| R2 | `anyOf: [{...X}, {type: "null"}]` | `{...X}, nullable: true` (siblings such as `description` kept) | 6 |
| R4 | `openapi: 3.1.0` | `openapi: 3.0.3` | 1 |

R2 is the same nullable construct as R1 in its other 3.1 spelling; R1 alone still fails. R4 only makes the file a
valid 3.0 document (`nullable` does not exist in 3.1); the generated Go types are identical with or without it.
`const` (`status: "success"`, `success: false`) is left as is: v2.7.2 accepts it and generates `interface{}`.

Regenerate after a snapshot refresh (Python 3, from `backend/`; the script lives outside the repo):

```
python -I down30.py api/erp/openapi.v1.json api/erp/openapi.v1.as30.json --anyof --header
make gen-erp
```

`down30.py`:

```python
"""Mechanical OpenAPI 3.1 -> 3.0 down-conversion for the ERP spec snapshot.
Rules (applied in order, nothing else):
  R1  type: [X, "null"]                     -> type: X, nullable: true
  R2  anyOf: [{...X}, {type: "null"}]       -> {...X}, nullable: true   (only with --anyof)
  R3  const: V                              -> enum: [V]                 (only with --const)
  R4  openapi: 3.1.x                        -> 3.0.3                     (only with --header)
"""
import json, sys
src, dst, *flags = sys.argv[1:]
counts = {"R1": 0, "R2": 0, "R3": 0, "R4": 0}
def walk(n):
    if isinstance(n, list):
        return [walk(x) for x in n]
    if not isinstance(n, dict):
        return n
    n = {k: walk(v) for k, v in n.items()}
    t = n.get("type")
    if isinstance(t, list) and len(t) == 2 and "null" in t:
        n["type"] = [x for x in t if x != "null"][0]
        n["nullable"] = True
        counts["R1"] += 1
    a = n.get("anyOf")
    if "--anyof" in flags and isinstance(a, list) and len(a) == 2 and {"type": "null"} in a:
        other = [x for x in a if x != {"type": "null"}][0]
        rest = {k: v for k, v in n.items() if k != "anyOf"}
        n = {**other, **rest, "nullable": True}
        counts["R2"] += 1
    if "--const" in flags and "const" in n:
        n["enum"] = [n.pop("const")]
        counts["R3"] += 1
    return n
with open(src, encoding="utf-8") as f:
    raw = f.read()
indent = 2 if raw.startswith("{\n  \"") else None
d = walk(json.loads(raw))
if "--header" in flags and str(d.get("openapi", "")).startswith("3.1"):
    d["openapi"] = "3.0.3"
    counts["R4"] += 1
with open(dst, "w", encoding="utf-8", newline="\n") as f:
    json.dump(d, f, indent=indent, ensure_ascii=False)
    f.write("\n")
print(counts, file=sys.stderr)
```
