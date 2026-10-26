# Production ERP (erp.mandalika.web.id) — what the POS will meet at cutover

Date: 2026-10-26. Source: the ERP web UI (owner logged in; read only), the ERP repo `main`, and read-only queries on
the POS test database (Neon). No API call was made with the POS key yet.

## 1. Integration client `pos_mandalika`

| Item | Value |
|---|---|
| Base URL | `https://erp.mandalika.web.id/api/integration/v1` |
| Scopes | `integration:catalog:read`, `integration:outlet-stock:read` (no write scope exists in the ERP yet) |
| Keys | 1 of 2 active: prefix `erp_vi0036w3_…`, label `test`, no expiry, never used; created 2026-10-26 |
| Domain field | `mandalika-pos.pages.dev` — a LABEL only; the ERP code does not enforce origins (`client.schema.ts`), so the Cloud Run backend can call it |
| Rate limit | 600 requests/min per client (ERP env default) |
| Other clients | `ecom_mandalika` (same two read scopes, 2 keys, last used minutes ago: the e-commerce side already pulls the catalog); `test` (catalog read only) |

The ERP developer's plan 1 adds the write scope (`stok outlet (tulis)` / stock-documents); until then the POS relay must stay
pointed at the stand-in stub or stay off.

## 2. Outlets

ERP has **29 outlets**: RETAIL (SENTUL, ALSUT, BOTANI, KARAWACI, TSM-CBB, KOKAS, KUNCIT, DELTAMAS, PASKAL, PVJ, QUEEN, SMS,
BSD, BXC, CCM, MKG, LMK, …) and ONLINE marketplace channels (`MP-SBY`, `MP-KWC`, `MP-KMG`, `MP-DPK`, …). Every outlet has a
"PEMASOK (FG)" (supplying warehouse: Cibubur, Bandung, Pusat SBY).

POS test database has 4 outlets: `BSD` (already linked to the stand-in as `bsd`), `LWB`, `PMS`, `MKS`. ERP `BSD` exists
(MANDALIKA AEON BSD), so the code-match auto-link works for it; the other three must be matched by slug at cutover (or
exist only as test data). The ONLINE `MP-*` outlets must never be mapped to POS outlets (ERP developer's rule: e-commerce
and POS outlets are disjoint).

## 3. Finished goods: the real shape

**374 FGs.** Code pattern `<FORM><SIZE><LINE>-<FRAGRANCE>`, examples:

| Code | Name (ERP) | Category | Size | UOM | Gender |
|---|---|---|---|---|---|
| `PP120E-24H` | 24HOURS | EXT | 120 ml | PCS | MEN |
| `PP120P-24H` | 24HOURS - 120ML PARFUM INTENSE | PERFUME INTENSE | 120 ml | PCS | MEN |
| `V2E-24H` | 24HOURS | EXT | 2 ml | PCS | MEN |
| `A10M-24H` | 24HOURS | ATOMIZER | 10 ml | PCS | MEN |
| `15GM-24H` | 24HOURS | GLASS MAN | 15 ml | PCS | MEN |
| `PW110E-FEE` | FEELING GOOD | EXT | 110 ml | PCS | WOMEN |

So: `unit` is always the stock unit (PCS), `size` is ml, `category` is the product LINE (EXT, PERFUME INTENSE, ATOMIZER,
GLASS MAN), and `name` is the fragrance, **sometimes with a " - <size> <line>" suffix** (the PERFUME INTENSE rows), which is
inconsistent data on the ERP side.

**The POS convention (55 real variants, test DB):** one product per fragrance, variant `size` text = `<size>ml <LINE>`:

```
GORGEOUS TUBEROSE: 10ml ATOMIZER [A10M-GOR]; 110ml EXTRAIT DE PARFUM [PW110E-GOR]; 110ml PARFUM INTENSE [PW110P-GOR];
                   2ml EXTRAIT DE PARFUM [V2E-GOR]; 2ml PARFUM INTENSE [V2P-GOR]
CANVAS BAG: Satuan [KEM-CAN]      KARTU GARANSI: Satuan [KEM-KAR]
```

**Finding 1 — SKUs already equal ERP codes.** All 55 real POS variants carry the ERP code as SKU (0 auto-generated
`SKU-…` left). The one-time SKU mapping is therefore an identity map (sku → code = sku) generated from a full catalog pull;
no hand mapping.

**Finding 2 — the current pull mapping does not reproduce the POS convention.** Today (`mapping.go`): product = name
minus size, label = `<size>ml`, category only as a tie-breaker. Against the real catalog that yields, for NO1: product
"NO1" with labels `120ml`, `2ml`, `10ml`, `15ml` (EXT, ATOMIZER and GLASS MAN collapse onto bare ml labels and EXT/INTENSE
of the same size collide), plus a second product "NO1 - PARFUM INTENSE" from the suffixed names. The POS wants one product
"NO1" with `120ml EXTRAIT DE PARFUM`, `120ml PARFUM INTENSE`, `10ml ATOMIZER`, `15ml GLASS MAN`, …

Required mapping v3 (to validate in the sandbox before cutover):
- group key = fragrance = ERP `name` with any ` - <size> <line>` suffix stripped (regex on " - \d+ML .*$"), normalised;
- size label = `<size>ml <LINE>` where LINE maps the ERP category: `EXT` → `EXTRAIT DE PARFUM`, `PERFUME INTENSE` →
  `PARFUM INTENSE`, `ATOMIZER` → `ATOMIZER`, `GLASS MAN` → `GLASS MAN` (table in config, unknown categories pass through);
- existing linked variants are never relabelled (step 2 guard); labels matter only for FGs the POS does not have.

**Finding 3 — POS test data has label/code mismatches** (e.g. `PW110E-NO1` labelled `120ml`, `PW110E-ONL` labelled
`120ml` while PW110 means 110 ml). The mapping import must report these as conflicts, not silently accept them; the owner
decides per row.

**Finding 4 — scale.** 374 FGs vs 26 active POS products / 55 variants. A full pull creates every missing FG as an ERP
product with price 0, `sellable=false`, hidden from tablets until the owner prices and enables it (step 4 decision D20,
`catalog_store.go:584,638`). Expect ~320 new unpriced variants on the first pull; that is by design, but the backoffice
product list will grow accordingly (filter by "ERP, belum diberi harga" is a follow-up).

**Finding 5 — packaging items.** `CANVAS BAG [KEM-CAN]` and `KARTU GARANSI [KEM-KAR]` exist in the POS with size
`Satuan`. Whether the ERP holds `KEM-*` as FGs is not visible on page 1 of 15; the sandbox pull will tell. If they are not
in the ERP, the giveaway movements for canvas bags will be `held` by the relay (variant unmapped) — acceptable, or ask the
ERP developer to register packaging as FGs.

## 4. Sandbox plan (read side, today)

A local POS backend (throwaway Postgres via `scripts/erp-rehearsal-local.sh` machinery) with `ERP_INTEGRATION_ENABLED=true`,
`ERP_RELAY_ENABLED=false`, `ERP_BASE_URL=https://erp.mandalika.web.id/api/integration/v1` and the `pos_mandalika` key
from a local env var (never in chat or in the repo), seeded with a copy of the test catalog, running one full catalog pull
and producing: counts (created / linked / conflicts), the label and grouping output for a sample of fragrances, and the
list of mapping conflicts. The write side stays on the stub until the ERP's plan 1 lands; their branch
`feature/pos-stock-documents` currently holds design documents only.

## 5. Questions back to the ERP developer (new)

- Names with a " - <size> <line>" suffix (PERFUME INTENSE rows): can the ERP normalise FG names to the fragrance only, since
  category already carries the line? If not, the POS strips the suffix (mapping v3).
- Are packaging items (`KEM-CAN`, `KEM-KAR`) FGs in the ERP?
- The e-commerce client already pulls the catalog; confirm the ONLINE outlets are reserved for it.
