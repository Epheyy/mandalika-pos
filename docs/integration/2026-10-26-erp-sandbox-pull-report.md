# ERP sandbox pull: production catalog into a throwaway POS database

Date: 2026-10-26. Code: `prod-hardening` at `e0ff77d` (no product code changed). Follows
`2026-10-26-erp-production-analysis.md` §4.

**Verdict.** Today's pull mapping must not run against the production ERP or against the test Neon database.
Mapping v3 below is required first. The mechanics work: paging, watermark, idempotent upserts, 0 item errors, about
6 s for the whole catalog. The results do not. Half of what the pull creates is non-sellable ERP stock: displays,
tester strips, boxes and stickers. Every sellable fragrance is split across 2–5 POS products. Linked POS products and
outlets also have their categories, names, addresses and phones overwritten.

**Update (same day):** mapping v3 (§6 plus the owner decisions of 2026-10-26) is implemented and the pull was re-run on
the same data: zero POS-owned fields overwritten, zero outlets created, one product per fragrance, every label in the
POS convention, others as separate not-for-sale products, the 4 SKUs mapped. See **§8**.

## 1. Setup (read-only for the ERP and for Neon)

| Item | Value |
|---|---|
| Database | throwaway `postgres:18.3` container on a random loopback port, migrated to 0068 by `cmd/seed`; removed at the end |
| Backend | `cmd/server` from this worktree, `ENV=development`, `ERP_INTEGRATION_ENABLED=true`, `ERP_RELAY_ENABLED=false`, `ERP_BRAND=mandalika`, `ERP_BASE_URL=https://erp.mandalika.web.id/api/integration/v1`, key from `backend/.env.erp-sandbox` (process env only) |
| Seed data | read-only `pg_dump --data-only` of TEST Neon `products`, `product_variants`, `categories`, `outlets` (docker `postgres:18.3`, DSN from Secret Manager via env). The 4 local tables were truncated after migrating, then the snapshot was loaded |
| Snapshot | 4 outlets, 32 products, 55 variants, 7 categories. **Only 29 of the 55 variants are real**: 26 are `RH-*` rehearsal rows, 22 of them linked to stand-in slugs (`rh-demo*`). The "55 real variants" figure in the analysis doc counted rehearsal rows |
| Pull | `cmd/erp-catalog-pull -mode full -budget 5m`, run from an empty directory (so `backend/.env` is not read) |
| ERP calls | 4 FG pages + 1 outlet page for a raw reference copy (curl), plus the CLI run. Read only, well under 600/min |
| Secrets | `grep -F` for the key and the Neon DSN over the scratch dir, task logs, server/CLI logs and the worktree: **0 hits**. Neon dump deleted at teardown |

Order of operations (this is also the cutover order): migrate → SKU-mapping export → identity CSV → **dry run** →
**commit** the mapping → full pull. The commit is required: the pull never links by SKU. An unlinked variant whose
SKU equals an FG code is an item error (`catalog_store.go:527-532`). Without the commit, "variants linked" would be 0.

## 2. SKU-mapping dry run (identity map, sku → code = sku)

The CSV was built from `GET /admin/erp/sku-mapping/export`, with `fg_slug` taken from the ERP by exact code match and
`erp_group_key = pos:<lower(product name)>`, which is what an operator would set under today's code. Without a
group key, `groupProduct` cannot find the existing product and opens a second one for every unmapped sibling FG.

**Planner result: 25 rows, update 25, error 0, warning 0.** It was then committed (runId `2936fec7…`). The planner
checks only ids, slugs and group keys. The per-row size and name checks below were computed separately against the
ERP data, using the v3 label rule from §6.

| Result | Count | Rows |
|---|---|---|
| linked, clean | 22 | GORGEOUS TUBEROSE ×5, HOLY SWEET ×5, UNSTOPPABLE ×5, NO1 ×3 (A10M, V2E, V2P), ONLY THE BRAVE ×3 (A10M, V2E, V2P), KEM-KAR |
| linked, **conflict** | 3 | see below |
| unmatched (SKU not in ERP) | 4 real + 26 rehearsal | `PW110E-NO1`, `PW110P-NO1`, `PW110E-ONL`, `PW110P-ONL`; all `RH-*` |

Conflicts:

| SKU | POS product / label | ERP name / category / size | Conflict |
|---|---|---|---|
| `KEM-CAN` | CANVAS BAG / Satuan | CANVAS BAG MANDALIKA / CANVAS BAG / 1 | name |
| `HAME-THE` | THE ONLY ONE / EXTRAIT DE PARFUM | HAMPERS THE ONLY ONE / HAMPERS EXT / 110 | name + label (a hamper, not the fragrance) |
| `HAMP-THE` | THE ONLY ONE / PARFUM INTENSE | HAMPERS THE ONLY ONE / HAMPERS PERFUME / 110 | name + label (a hamper, not the fragrance) |

The 4 unmatched real SKUs are **wrong codes in the POS**, not missing ERP goods. The POS labels say 120ml and the
ERP holds `PP120E-NO1`, `PP120P-NO1`, `PP120E-ONL`, `PP120P-ONL` (120 ml, same fragrances). `PW110*` codes for NO1
and ONL do not exist. Owner action: correct these 4 SKUs (or map them by hand to the PP120 codes) before cutover;
otherwise the pull creates the PP120 FGs as separate Rp0 variants next to the priced ones (seen in §4).

## 3. Full pull: counts

| Measure | Value |
|---|---|
| FGs fetched | **374** (1 page at take=500; 365 ACTIVE, 9 NEW_LAUNCHING, 0 tombstones, all unit `Pcs`) |
| Outlets fetched | **29** (25 RETAIL, 4 ONLINE) |
| Run status | completed / completed, **0 item errors**, ≈6 s |
| Products | 32 → 278: **+246 created**, all `sellable=false`, `is_active=true`, price 0 |
| Variants | 55 → 404: **+349 created**, **25 linked** (from the mapping), 374 = 349 + 25 |
| Created variants that are `is_others=true` | **179 of 349** (165 of the 246 new products contain only such items) |
| Categories | 7 → 37: **+30 created** (one per ERP category) |
| Outlets | 4 → 29: **4 linked** (BSD already linked; PMS, LWB, MKS linked by code), **25 created** (inactive, code NULL) |
| Reconcile | **18 deactivated**: all `RH-DEMO*` rehearsal variants still linked to stand-in slugs. On test Neon this would happen at the first real pull |
| Watermarks saved | outlets `2026-10-26T05:07:22.117Z`, finished_goods `2026-10-26T05:07:22.428Z` (`server_time` of page 1, both `last_full_sync_at` set) |

## 4. Samples: what the backoffice would list

The product list shows `products.name` and each variant's `size` as stored (checked against `GET /api/v1/products`).
✗ marks a departure from the POS convention (one product per fragrance, label `<size>ml <LINE>`).

**Existing products after the pull (prices and labels untouched; ✗ = changed by the pull):**

| POS product (category before → after) | Variants now (label · code) |
|---|---|
| NO1 (MAN → **LEATHER** ✗) | 10ml ATOMIZER · A10M-NO1; 120ml EXTRAIT DE PARFUM · PW110E-NO1 (unlinked); 120ml PARFUM INTENSE · PW110P-NO1 (unlinked); **120ml ✗ · PP120E-NO1 (Rp0, duplicate of the unlinked row)**; **15ml ✗ · 15GL-NO1**; 2ml EXTRAIT DE PARFUM · V2E-NO1; 2ml PARFUM INTENSE · V2P-NO1 |
| GORGEOUS TUBEROSE (WOMAN → **GLITTER** ✗) | the 5 priced rows; plus **110ml ✗ · DW110E-GOR (a DISPLAY item)**; **15ml ✗ · 15GL-GOR** |
| HOLY SWEET (WOMAN → **GLITTER** ✗) | the 5 priced rows; plus **110ml ✗ · DW110E-HOL (DISPLAY)**; **15ml ✗ · 15GL-HOL** |
| UNSTOPPABLE (UNISEX → **ATOMIZER** ✗) | the 5 priced rows; plus **110ml ✗ · DW110E-UNS (DISPLAY)** |
| ONLY THE BRAVE (MAN → **LEATHER** ✗) | same pattern as NO1 (PP120E-ONL at Rp0 next to the unlinked PW110*-ONL rows, 15GL-ONL) |
| THE ONLY ONE (HAMPERS → **LEATHER** ✗) | the 2 hamper rows, plus the fragrance's **2ml ✗ · V2E-THE**, **15ml ✗ · 15GL-THE**, **110ml ✗ · DW110P-THE (DISPLAY)**: hampers and fragrance merged |
| CANVAS BAG → renamed **CANVAS BAG MANDALIKA** ✗ (KEMASAN → CANVAS BAG ✗) | Satuan · KEM-CAN |
| KARTU GARANSI (KEMASAN → KARTU GARANSI ✗) | Satuan · KEM-KAR |

**New products for the sample fragrances (all Rp0, not sellable):**

| New POS product | Label · code | ERP name · category · size | Departures |
|---|---|---|---|
| 24HOURS | 10ml · A10M-24H; 120ml · PP120E-24H; 15ml · 15GM-24H; 2ml · V2E-24H | 24HOURS · ATOMIZER/EXT/GLASS MAN/EXT | ✗ bare `<n>ml` labels |
| 24HOURS - EXTRAIT | 100ml · PP100E-24H | 24HOURS - 100ML EXTRAIT · EXT · 100 | ✗ second product (suffix kept) |
| 24HOURS - PARFUM INTENSE | 100ml · PP100P-24H; 120ml · PP120P-24H; 2ml · V2P-24H | "… - <n>ML PARFUM INTENSE" · PERFUME INTENSE | ✗ third product |
| 24HOURS (cat DISPLAY EXT) | 120ml · DP120E-24H | 24HOURS · DISPLAY EXT · 120 | ✗ display item as a product with a bare fragrance name |
| DISPLAY EXTRAIT - 24HOURS / DISPLAY PARFUM INTENSE - 24HOURS | 100ml · DP100E-24H; 100ml · DP100P-24H, 120ml · DP120P-24H | DISPLAY … | ✗ display items |
| KERTAS TESTER LANDSCAPE/POTRAIT 24HOURS @150 | **1ml** · KTL-24H / KTP-24H | paper strips · size 1 | ✗ "1ml" on paper |
| CHAMPION ×5 products | (ATOMIZER/EXT) 10ml, 120ml, 2ml; (PERFUME INTENSE) 120ml, 2ml; (DISPLAY EXT) 120ml; (DISPLAY TESTER EXT) 120ml; (DISPLAY PARFUM) 120ml | names all "CHAMPION" | ✗ five products all named CHAMPION, told apart only by category |
| DAY, DAY - EXTRAIT, DAY - PARFUM INTENSE, DAY (DISPLAY EXT), DISPLAY … - DAY | same shape as 24HOURS | | ✗ same splits |
| NO1 (PERFUME INTENSE) · NO1 (GLASS MAN) · NO1 (DISPLAY EXT) · NO1 (DISPLAY PARFUM) · NO1 - EXTRAIT · NO1 - PARFUM INTENSE · NO1 TESTER · DISPLAY … NO1 | 120ml · PP120P-NO1; 15ml · 15GM-NO1; 120ml · DP120E-NO1; 120ml · DP120P-NO1; 100ml · PP100E-NO1; 100ml · PP100P-NO1; … | | ✗ NO1 spread over the existing product + 8 new ones |
| GORGEOUS TUBEROSE (GLASS WOMAN) / (DISPLAY PARFUM) / GORGEOUS TUBEROSE TESTER ×2 | 15ml · 15GW-GOR; 110ml · DW110P-GOR; 110ml · DW110E-GOR-T / DW110P-GOR-T | | ✗ |
| HOLY SWEET (GLASS WOMAN) / (DISPLAY PARFUM) / HOLY SWEET TESTER / DISPLAY EXTRAIT - HOLY SWEET TESTER | 15ml · 15GW-HOL; 110ml · DW110P-HOL; … | | ✗ |
| HOLY SWEET ELIXIR (+ 2 display products) | 10ml · A10M-HOL-EX; 110ml · PW110E-HOL-EX; 2ml · V2E-HOL-EX | PW110E-HOL-EX is filed under PERFUME INTENSE although its code says E | ✗ labels; ERP data inconsistency |

**KEM-\* packaging (all six exist in the ERP, all `is_others=true`):**

| Code | ERP name · category | POS result |
|---|---|---|
| KEM-CAN | CANVAS BAG MANDALIKA · CANVAS BAG | linked to the POS CANVAS BAG; product **renamed** and re-categorised ✗ |
| KEM-KAR | KARTU GARANSI · KARTU GARANSI | linked; re-categorised ✗ |
| KEM-GIF | GIFT CARD · GIFT CARD | new product, label **1ml** ✗ (should be Satuan) |
| KEM-PAP | PAPERBAG CREAM · PAPERBAG | new, **1ml** ✗ |
| KEM-MRF, KEM-THE | STICKER GARANSI … · STICKER | new, **1ml** ✗ |

So canvas-bag giveaway movements will **not** be held by the relay for an unmapped variant. Finding 5 of the
analysis doc is answered: packaging is in the ERP.

Whole-catalog figures:
- All 170 created sellable variants have a bare `<n>ml` label: **0 follow the convention**.
- 26 of the 31 sellable fragrances are split across 2–5 POS products.
- 5 POS products mix sellable and display items.
- 78 product names still contain " - ".

## 5. Outlets

| ERP code (slug) | Type | Result |
|---|---|---|
| BSD (`bsd`) | RETAIL | already linked; **name, address and phone overwritten** with ERP values ("Mandalika BSD"/Jakarta → "MANDALIKA AEON BSD"/NULL) |
| PMS, LWB, MKS | RETAIL | linked by exact code; **name, address and phone overwritten with NULL-bearing ERP data**: PMS lost its SURABAYA address and phone number, LWB lost "Bali", MKS lost "Makassar"; names became upper-case ERP names |
| ALSUT, BOTANI, BXC, CCM, DELTAMAS, DMB, DPM, KARAWACI, KOKAS, KUNCIT, LMK, MKG, PASKAL, PMB, PMJ, PVJ, QUEEN, SENTUL, SMB, SMS, TSM-CBB (21) | RETAIL | **created** as POS outlets (inactive, code NULL) |
| **MP-DPK, MP-KMG, MP-KWC, MP-SBY** (slug `mp-surabaya-pusat`) | **ONLINE** | **created** as POS outlets ✗. These are e-commerce channels; per the ERP developer's rule they must never be POS outlets |

All 29 ERP outlets have NULL address and phone. Every ERP outlet carries `type` (RETAIL/ONLINE). The generated
client already has the field (`erpapi.IntegrationOutlet.Type`), but `applyOutletItem` ignores it today. A code prefix test (`MP-`) agrees with `type` on all 4.

## 6. Mapping v3: specification from the real data

### 6.1 What is in scope (new rule, required)

- **Sellable FG** = `is_others = false`. That is 191 FGs, all in the line categories below.
- **Packaging allow-list**: an `is_others = true` FG is in scope only if its code starts with `KEM-`. That is 6 FGs;
  the POS needs KEM-CAN and KEM-KAR as giveaways. Make it a config list (codes or categories), not a hard-coded rule.
- **Everything else is skipped, not created**: 177 FGs in DISPLAY*, KERTAS TESTER*, BOX*, BOTOL, GIFT SET BOX,
  HAMPER(S)*, DISPLAY DUMMY. Count and report them per run, without item errors.
  - A skipped FG that is *linked* (an existing POS variant mapped to it, e.g. `HAME-THE`, `HAMP-THE`) is still
    upserted, so mapped hampers keep working.
  - `PP120P-ONL-R` is coded like a product but filed as DISPLAY PARFUM / `is_others` in the ERP, so it is skipped.
    Ask the ERP.

### 6.2 Grouping key = fragrance

- **Use the code's fragrance suffix, not the name.** Group by the text after the first `-` of a code shaped
  `^(?:[A-Z]+\d+[A-Z]*|\d+[A-Z]+)-(.+)$`. Examples: `PP120E-24H` → `24H`, `15GM-NO1` → `NO1`,
  `A10M-HOL-EX` → `HOL-EX`, `PP120E-ONL-R` → `ONL-R`.
  - Measured on the 191 sellable FGs: 31 groups, **0 label collisions**, and every group maps to exactly one
    stripped name.
- **The name rule is worse.** Strip ` - <n>ML …` with `\s+-\s+\d+\s*ML\b.*$` (case-insensitive). That gives 30
  groups and **1 collision**: ONLY THE BRAVE `PP120E-ONL` vs `PP120E-ONL-R` "… - 120ML EXTRAIT REWORK", both
  `120ml EXTRAIT DE PARFUM`.
  - The suffix variants actually observed on sellable FGs are `2ML PARFUM INTENSE`, `100ML EXTRAIT`,
    `100ML PARFUM INTENSE`, `120ML PARFUM INTENSE`, `110ML M PARFUM INTENSE`, `120ML EXTRAIT`, `10ML ATOMIZER`,
    `2ML EXTRAIT`, `100ML M EXTRAIT`, `100ML M PARFUM INTENSE`, `120ML EXTRAIT REWORK` and `110ML M EXTRAIT`.
  - The analysis doc's `" - \d+ML .*$"` is right in shape but must allow `ML` to be followed by any line text,
    including "M …".
- **Product display name** = the stripped ERP name. It is the same for every member of a code group.
- **Group key** = `erp:<fragrance code>` (e.g. `erp:NO1`), or `pos:<lower(stripped name)>` if the owner prefers
  names. On the existing products, the mapping import must set the key to the same value (`pos:no1` today), so
  sibling FGs join the existing product.
- **Rework (`-R`)**: treat as its own fragrance (`ONL-R` → product "ONLY THE BRAVE REWORK"), or label
  `120ml EXTRAIT DE PARFUM REWORK` inside ONLY THE BRAVE. **Owner decision.**
- **Packaging**: one product per FG, named by the ERP name. Group key = `erp:<code>`.

### 6.3 Variant label = `<size>ml <LINE>`

Category-to-line table. These are the exact category strings observed on in-scope FGs; an unknown category passes
through upper-cased and is reported.

| ERP `category` | LINE | FGs |
|---|---|---|
| `EXT` | `EXTRAIT DE PARFUM` | 72 |
| `PERFUME INTENSE` | `PARFUM INTENSE` | 64 |
| `ATOMIZER` | `ATOMIZER` | 27 |
| `GLASS WOMAN` | `GLASS WOMAN` | 10 |
| `GLASS MAN` | `GLASS MAN` | 7 |
| `LEATHER` | `LEATHER` | 7 |
| `GLITTER` | `GLITTER` | 4 |

Rules:
- **Sizes**: integers as given (2, 10, 15, 100, 110, 120). 100 ml and 110/120 ml lines coexist in one fragrance
  (e.g. SENSUAL OBSESSION, VANILLA MANGO), so the size must stay in the label.
- **Packaging** (`KEM-*`, size 1, unit Pcs): label `Satuan`, never `1ml`. More generally, an FG whose category is not
  in the line table gets `Satuan`.
- **Labels are written only on create.** A linked variant is never relabelled (existing guard).
- **Trust the category over the code letter.** Three FGs disagree: `PW110E-HOL-EX` is coded E but filed PERFUME
  INTENSE; `V2E-MRF` is filed PERFUME INTENSE and `V2P-MRF` is filed EXT, so the MR. FANTASTIC 2 ml pair looks
  swapped. Report these to the ERP.

### 6.4 Product fields owned by the POS (new rule, required)

- **Stop re-deriving the product category from the ERP.** Today `syncProduct` sets the category from the
  lowest-SKU linked variant. That moved NO1 from MAN to LEATHER, UNSTOPPABLE from UNISEX to ATOMIZER and THE ONLY
  ONE from HAMPERS to LEATHER, because `15GL-…` sorts first. The ERP category is a *line*, the POS category is a
  *gender/collection*, so they are different dimensions.
  - Set a category only on a product the pull creates. Map it from the majority ERP `gender` of the group
    (MEN→MAN, WOMEN→WOMAN, UNISEX→UNISEX); packaging goes to KEMASAN.
  - Caveat: ERP gender is not consistent. UNSTOPPABLE is WOMEN in the ERP but UNISEX in the POS. GORGEOUS TUBEROSE
    mixes 5 WOMEN and 2 UNISEX. THE fragrance is 2 WOMEN and 1 MEN. Treat gender as a default for new products
    only; the owner can override it.
  - Do not create one POS category per ERP category. That added 30 categories.
- **Stop renaming linked products.** CANVAS BAG became "CANVAS BAG MANDALIKA". Name only on create; afterwards
  report drift, don't write it.

### 6.5 Outlets

- **Link only.** Match by `erp_slug`, then by exact case-insensitive code or slug equal to the POS code. **Never
  create** an outlet. Report every unmatched ERP outlet with its code, name and type.
- **Never link or create `type = ONLINE`.** Today that is MP-DPK, MP-KMG, MP-KWC and MP-SBY. Use the `type` field,
  not the code prefix.
- **On link and on later pulls, write only `erp_slug` and `erp_code`.** POS name, address and phone are POS-owned.
  The ERP has NULLs for all 29 outlets, and today the pull wipes them.

### 6.6 Expected v3 result on this data

- **Products**: 31 fragrance groups, including ONL-R. 5 already exist: GOR, HOL, UNS, NO1, ONL. THE ONLY ONE stays
  the hamper product, so the fragrance THE is new. There are also 6 packaging products; CANVAS BAG and KARTU GARANSI
  already exist.
- **New variants**: 197 FGs in scope − 23 in-scope FGs linked by the mapping − 4 reached via the corrected NO1/ONL
  SKUs = **≈ 170**, instead of 349.
- **New products**: 26 fragrance + 4 packaging = **≈ 30**, instead of 246.
- **Display/tester/paper items created**: 0, with 177 FGs skipped and reported.
- **Outlets**: 0 created, 4 linked, 25 reported (4 of them ONLINE).

### 6.7 Other findings for the plan

- **Fix the 4 POS SKUs before cutover**: `PW110E-NO1` → `PP120E-NO1`, `PW110P-NO1` → `PP120P-NO1`,
  `PW110E-ONL` → `PP120E-ONL`, `PW110P-ONL` → `PP120P-ONL`.
  - The current mapping import needs the variant's SKU to equal the code. These four need a hand-written mapping row
    (`fg_code` = PP120…), which the import already allows.
- **THE ONLY ONE**: the POS product is a hamper set (HAME-THE/HAMP-THE). The ERP fragrance THE ONLY ONE exists
  separately (V2E-THE, V2P-THE, 15GL-THE). Under v3 its group key (`erp:THE`) must not collide with the hamper
  product. Give the hamper product its own key, e.g. `erp:HAM-THE`, at mapping time.
- **Rehearsal rows on test Neon**: the first real pull deactivates the 18 still-active `rh-demo*` variants
  (reconcile; within the 20% cap because 374 slugs are now linked). This is harmless but visible. Delete or relink
  them before the first pull.
- **Speed**: the whole catalog is 1 FG page at take=500 plus 1 outlet page. A full pull with about 370 item upserts
  took about 6 s, well inside the 25 s HTTP budget.
- **ERP-side data issues to report**:
  - names with " - <size> <line>" suffixes (107 FGs);
  - `PP120P-ONL-R` filed as DISPLAY;
  - the 3 code/category mismatches;
  - "M" in `110ML M PARFUM INTENSE` (meaning unknown);
  - `KTB-NO1` uses its code as its name.

## 7. Teardown

Backend killed, the container was stopped (`--rm`, nothing left). The scratch Neon dump, the sandbox env file (DB
password, admin password, JWT secrets) and the token were deleted. The ERP key and Neon DSN appear in no file (0 hits).
No push, deploy, Neon write or ERP write was made.

## 8. Addendum: re-run with mapping v3 (2026-10-26, afternoon)

Code: branch `claude/agitated-lewin-761935` at `703675a9` (v3 guards `fad4fadc`, grouping `9d0ffbc5`, SKU-mapping
warnings `703675a9`). The outlet-note wording was shortened after the run (`df4d5e22`); nothing else changed.
Same machinery as §1: a throwaway `postgres:18.3` container, migrated by `cmd/seed`, `cmd/server` for the import, and
`cmd/erp-catalog-pull -mode full -budget 5m` run from an empty directory. Read-only for the ERP and for Neon.

**Verdict.** Every v3 target is met. The pull overwrote no POS-owned field and created no outlet. It made one
product per fragrance, with every label in the POS convention. The 179 others items became separate not-for-sale
products, and the 4 corrected SKUs are mapped. A second full pull changed nothing.

Owner decision (b) replaces the §6.1 "skip others" rule and the §6.6 product and variant counts. Others are now
created, but each one as its own product with key `erp:<code>`, `sellable=false`, price 0 and the category
**`ERP: bukan untuk dijual`**. Each product name carries the code, for example `24HOURS (DP120E-24H)`.

### 8.1 Inputs

| Item | Value |
|---|---|
| Test-catalog copy | A fresh read-only `pg_dump --data-only` of TEST Neon `categories`, `products`, `product_variants` and `outlets`. It holds **4 outlets, 37 products, 61 variants and 7 categories**. Report §1 counted 32 products and 55 variants; the new products and variants are 6 more `RH-*` rehearsal rows, and the 29 real variants are unchanged. Categories: GIFT-SET, HAMPERS, KEMASAN, MAN, Rehearsal, UNISEX, WOMAN |
| ERP | 374 FGs (191 sellable, 183 others) and 29 outlets (25 RETAIL, 4 ONLINE), unchanged since the morning |
| Mapping file | [`2026-10-26-sku-mapping-cutover.csv`](2026-10-26-sku-mapping-cutover.csv): the 29 real variants with test-Neon variant ids. It holds the ERP `fg_code`/`fg_slug` and the v3 keys (`erp:GOR`, `erp:HOL`, `erp:UNS`, `erp:NO1`, `erp:ONL`, `erp:HAMPERS-THE`, `erp:KEM-CAN`, `erp:KEM-KAR`), plus the ERP context columns. The sandbox imported this exact file |

### 8.2 SKU-mapping dry run, then commit

**29 updates, 0 errors, 9 warnings.** The dry run and the commit had the same summary.

| Warning | Rows |
|---|---|
| `name_conflict` | KEM-CAN ("CANVAS BAG" vs "CANVAS BAG MANDALIKA"), HAME-THE and HAMP-THE ("THE ONLY ONE" vs "HAMPERS THE ONLY ONE") |
| `label_conflict` | HAME-THE ("EXTRAIT DE PARFUM" vs "Satuan"), HAMP-THE ("PARFUM INTENSE" vs "Satuan") |
| `sku_changed` | PW110E-NO1 → PP120E-NO1, PW110P-NO1 → PP120P-NO1, PW110E-ONL → PP120E-ONL, PW110P-ONL → PP120P-ONL (the barcode keeps the old SKU) |

The other 22 rows matched the ERP name and the v3 label exactly.

### 8.3 Full pull: counts against §3

| Measure | Morning (§3) | v3 | Expected |
|---|---|---|---|
| Run | completed, 0 item errors, ≈6 s | completed, **0 item errors**: outlets 0.67 s, FGs 6.31 s | ✓ |
| POS-owned fields changed on existing rows | category of NO1, UNSTOPPABLE, THE ONLY ONE, GOR, HOL, CANVAS BAG, KARTU GARANSI; CANVAS BAG renamed; 4 outlets' name/address/phone | **0 of 102 rows**: 37 products (name, category, brand, sellable, images, image_url, description), 61 variants (size, price, barcode), 4 outlets (name, address, phone, code, active) compared before and after | 0 ✓ |
| Outlets | 4 linked, **25 created** (4 ONLINE) | 4 linked (BSD by slug; PMS, LWB, MKS by code), **0 created**, 25 reported as unlinked in the run note (21 RETAIL with no POS outlet code; MP-DPK, MP-KMG, MP-KWC, MP-SBY as ONLINE). Addresses kept (PMS SURABAYA + phone, LWB Bali, MKS Makassar, BSD Jakarta) | ✓ |
| Products | +246 | **+205** = 26 fragrance products + 179 others products | |
| Variants | +349 created, 25 linked | **+345** created, 29 linked (374 = 345 + 29) | |
| Categories | +30 (one per ERP category) | **+1** (`ERP: bukan untuk dijual`) | ✓ |
| Sellable fragrance FGs | spread over 2-5 products each | the 191 sit in **31 products**, one per fragrance code (5 existing + 26 new) | ✓ |
| Labels in `<size>ml <LINE>` | 0 of 170 | **191 of 191** | ✓ |
| Products mixing sellable and others | 5 | **0** | ✓ |
| Others items | 179 inside priced products | **179 products**: all not sellable, 1 variant `Satuan` at Rp0, category `ERP: bukan untuk dijual`. The 4 linked others keep their POS products: KEM-CAN, KEM-KAR, HAME-THE, HAMP-THE | ✓ |
| Product names with " - " (others excluded) | 78 | **0** | ✓ |
| Category of the 26 new fragrance products | ERP line category | from the majority ERP gender, matched to existing POS categories: 11 MAN, 14 WOMAN, 1 UNISEX; none created | ✓ |
| 4 corrected SKUs | 4 unlinked + 4 Rp0 PP120 duplicates | PP120E/P-NO1 and PP120E/P-ONL linked into NO1 and ONLY THE BRAVE, keeping their labels and prices (Rp575000 / Rp675000) | ✓ |
| Reconcile | 18 `RH-DEMO*` deactivated | 22 `RH-DEMO*` deactivated: the extra rehearsal rows on Neon, still linked to stand-in slugs | as §6.7 |
| Run notes | none | 2 names disambiguated (below), 25 unlinked outlets | |

### 8.4 Samples: what the backoffice lists

| Product (category, sellable) | Variants (label · code · price when set) |
|---|---|
| NO1 (MAN, yes; existing) | 100ml EXTRAIT DE PARFUM · PP100E-NO1; 100ml PARFUM INTENSE · PP100P-NO1; 10ml ATOMIZER · A10M-NO1 · Rp225000; 120ml EXTRAIT DE PARFUM · PP120E-NO1 · Rp575000; 120ml PARFUM INTENSE · PP120P-NO1 · Rp675000; 15ml GLASS MAN · 15GM-NO1; 15ml LEATHER · 15GL-NO1; 2ml EXTRAIT DE PARFUM · V2E-NO1 · Rp1; 2ml PARFUM INTENSE · V2P-NO1 · Rp1 |
| ONLY THE BRAVE (MAN, yes; existing) | the same shape as NO1 (PP120E/P-ONL linked, priced) |
| GORGEOUS TUBEROSE (WOMAN, yes; existing) | the 5 priced rows + 15ml GLASS WOMAN · 15GW-GOR; 15ml GLITTER · 15GL-GOR |
| HOLY SWEET (WOMAN, yes; existing) | the 5 priced rows + 15ml GLASS WOMAN · 15GW-HOL; 15ml GLITTER · 15GL-HOL |
| UNSTOPPABLE (UNISEX, yes; existing) | the 5 priced rows (the ERP has no other sellable UNS size; its displays and tester papers are others products) |
| 24HOURS (MAN, no; new) | 100ml EXTRAIT DE PARFUM · PP100E-24H; 100ml PARFUM INTENSE · PP100P-24H; 10ml ATOMIZER · A10M-24H; 120ml EXTRAIT DE PARFUM · PP120E-24H; 120ml PARFUM INTENSE · PP120P-24H; 15ml GLASS MAN · 15GM-24H; 2ml EXTRAIT DE PARFUM · V2E-24H; 2ml PARFUM INTENSE · V2P-24H |
| DAY (MAN, no; new) | the same 8 labels as 24HOURS |
| CHAMPION (MAN, no; new) | 10ml ATOMIZER; 120ml EXTRAIT DE PARFUM; 120ml PARFUM INTENSE; 2ml EXTRAIT DE PARFUM; 2ml PARFUM INTENSE (one product, not five) |
| HOLY SWEET ELIXIR (WOMAN, no; new) | 10ml ATOMIZER · A10M-HOL-EX; 110ml PARFUM INTENSE · PW110E-HOL-EX (the category wins over the code letter); 2ml EXTRAIT DE PARFUM · V2E-HOL-EX |
| THE ONLY ONE (THE) (WOMAN, no; new) | 15ml LEATHER · 15GL-THE; 2ml EXTRAIT DE PARFUM · V2E-THE; 2ml PARFUM INTENSE · V2P-THE. The hamper product THE ONLY ONE (HAMPERS) is unchanged |
| ONLY THE BRAVE - REWORK (MAN, no; new) | 120ml EXTRAIT DE PARFUM · PP120E-ONL-R (named by the rework rule added after the run, see 8.6; the run itself produced `ONLY THE BRAVE (ONL-R)`) |
| CANVAS BAG / KARTU GARANSI (KEMASAN, yes; existing) | Satuan · KEM-CAN / KEM-KAR, name and category kept |
| GIFT CARD (KEM-GIF), PAPERBAG CREAM (KEM-PAP), STICKER GARANSI MR. FANTASTIC (KEM-MRF), STICKER GARANSI THE ONLY ONE (KEM-THE) | Satuan, ERP: bukan untuk dijual, not sellable |
| 24HOURS (DP120E-24H), GORGEOUS TUBEROSE (DW110E-GOR), KERTAS TESTER LANDSCAPE CHAMPION (KTL-CHA), ONLY THE BRAVE - 120ML PARFUM INTENSE REWORK (PP120P-ONL-R) | the same: one Satuan row at Rp0, ERP: bukan untuk dijual, not sellable |

### 8.5 Second full pull and owner edits

Before the second pull, the owner's edits were simulated:
- turn `sellable` on for `GORGEOUS TUBEROSE (DW110E-GOR)`;
- rename `24HOURS` to `24 HOURS`;
- re-file `24HOURS` under UNISEX.

The second full pull then ran: 374 upserted, 0 item errors, 0 deactivated. **0 rows changed** across products,
variants and outlets, and the content versions were unchanged (6,6,6,6). The display stayed sellable, and the
rename and re-filing stayed.

### 8.6 Open owner calls (defaults chosen and tested; change on request)

- **ONL-R rework: decided.** The owner answered on 2026-10-26 that it is its own product named `ONLY THE BRAVE - REWORK`. A rework code (the fragrance part ends in `-R`) now names a new product `<fragrance name> - REWORK`. The `(<fragrance code>)` suffix is kept for genuine name clashes only, so the re-run would now report 1 renamed product (THE) instead of 2, and 1 product name with " - ".
- **THE fragrance.** It is named `THE ONLY ONE (THE)`, because the hamper product holds the plain name.
  - A name that is already taken gets the fragrance code appended, and the run note reports it.
  - The owner can rename these products: name and category are now editable on linked products (`ac78c365`).
- **New-product category from the ERP gender.** This is a default only. The gender is inconsistent across the ERP (§6.4 caveat), and later pulls never change the category.
- **PP120P-ONL-R.** It is filed as DISPLAY PARFUM / others, so it became a not-for-sale others product. The ERP should re-file it if it is a sellable rework.
- **New KEM-\* packaging.** GIFT CARD, PAPERBAG CREAM and the two warranty stickers are others items. Under decision (b) they are filed under `ERP: bukan untuk dijual`, not under KEMASAN as §6.4 had planned. CANVAS BAG and KARTU GARANSI keep KEMASAN.
- **Saving without a category.** The backoffice product form still lets an ERP-linked product save with no category (`validateProductForm`). Now that the category is POS-owned, the owner may want it required as for other products. This is unchanged.

The ERP-side data issues of §6.7 are unchanged.

### 8.7 Teardown

The containers were stopped (`--rm`). The scratch Neon dump, the ERP JSON pages, the sandbox env file and the
binaries were deleted. `grep` for the key prefix and for the Neon host over the worktree and scratch found 0 hits.
No push, deploy, Neon write or ERP write was made.
