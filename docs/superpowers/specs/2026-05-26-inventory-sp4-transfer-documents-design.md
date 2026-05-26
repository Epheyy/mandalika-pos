# Inventory Module — SP4: Transfer Documents & Sharing — Design

Date: 2026-05-26 · Branch: `prod-hardening`

## Module context (continuity)

The Inventory module = **warehouses + product transfers** for the multi-brand POS
template, decomposed into four sequenced sub-projects (each its own spec → plan →
build):

- **SP1 — Warehouse foundation** ✅ DONE & LIVE (backend rev 00021-d5c, migration 0015).
- **SP2 — Transfers core (backoffice)** ✅ DONE & LIVE (backend rev 00023-tz9, migration 0016).
- **SP3 — POS-side receiving + PIN** ✅ CODE COMPLETE & DEPLOYED (backend rev 00027-5cd, migration 0017; on-device re-test still user-pending but separate from SP4 work).
- **SP4 — Transfer documents & sharing** *(this spec)*: printable **surat jalan**
  (PDF + PNG via OS share-sheet, generated at send in the backoffice) + thermal-printed
  **tanda terima** on the POS at the destination after receive. **No WhatsApp
  Business API** — only the OS share-sheet.

**Module-wide locked decisions** (apply across SPs):

- Topology = **mesh** (any location ↔ any).
- Transfer flow = **two-step send → receive with in-transit**; **draft** before send.
- Warehouse modeling = **separate subsystem** (own tables; never POS-synced).
- Discrepancy = **receive actual qty, record the difference** with a reason.
- Approval = **authoritative PIN + selected roles** (SP3).
- Permission **`manage_inventory`** gates inventory ops in backoffice (admin implicit).

## SP4-specific decisions (locked this session)

1. **Architecture = hybrid.** Backoffice (web) renders the **surat jalan** as
   client-side PNG + PDF and exposes it via the **OS share-sheet** (Web Share API);
   the POS (native Android) thermal-prints the **tanda terima** over the existing
   BLE `@mandalika/printer` after a successful SP3 receive. Backoffice cannot reach
   BLE (it's a Cloudflare-Pages web app); POS does not produce the surat jalan
   (the sender is the admin on the web). The two surfaces are complementary, not
   redundant.
2. **POS print scope = tanda terima only** (post-receive). The POS does **not**
   print the surat jalan — the receiver's slip is the only thermal artifact on
   the destination side. The sender's surat jalan stays in the backoffice.
3. **Branding = brand default + per-location override (C2).** A new
   `app_settings.documents` block (`logo_url`, `brand_name`, `address_lines`,
   `phone`, `npwp`) provides the brand-level letterhead. Each warehouse and outlet
   may override `address_lines`, `phone`, `logo_url` (NULL ⇒ fall back to brand).
   Letterhead = **sender** location on the surat jalan, **receiver** location on
   the tanda terima.
4. **Render approach = client-side, HTML → PNG + PDF.** `html-to-image` renders the
   React surat-jalan component to a PNG blob; `jsPDF` wraps the PNG into a single-page
   A4 PDF. No server-side rendering, no Go layout work, no extra deploys to iterate
   on layout. Both formats are produced from the same React DOM, so they always agree.
5. **Surat jalan layout = L2 (minimal modern).** Logo + brand name top-left, doc
   title `SURAT JALAN` + number + date top-right, two-column **Dari / Untuk** blocks,
   item table (Nama / Ukuran / Qty), optional notes line, **2 signature lines**
   (Pengirim · Penerima). No "Sopir" line — internal transfers use staff couriers.
6. **Tanda terima layout = thermal 58 mm / 32 col**, mirroring the existing
   `buildRecap` ESC/POS builder pattern. Receiver letterhead at the top, doc number
   `TT-yyyy-NNNNN`, `Ref: TRF-...`, `Dari: <sender>`, item table with
   `Krm / Trm / Sel` columns, discrepancy reason, `Diterima oleh:` + signature line.
7. **Backoffice trigger UX = inline panel with explicit actions; Bagikan auto-opens
   share-sheet.** After `api.sendTransfer(id)` succeeds, an inline "Surat jalan siap"
   panel appears at the top of the transfer detail with four actions: **Bagikan**
   (auto-opens the OS share-sheet with the PNG attached), **Unduh PDF**, **Unduh PNG**,
   **Lihat** (modal preview). The panel persists at `in_transit` and `completed`
   for later re-share / re-download.
8. **POS trigger UX = auto-prompt modal after receive.** After an SP3 receive is
   **server-acknowledged** (not just optimistically credited — see "Open risk" below),
   a small modal appears: **"Tanda terima siap. Cetak sekarang?"** with **[Cetak]**
   and **[Lewati]**. [Cetak] is disabled when no BLE printer is paired (with a helper
   "Pasangkan printer di Pengaturan"). A persistent **"Cetak Ulang"** button stays on
   the completed transfer detail screen.
9. **Numbering = separate sequences.**
   - Surat jalan: `SJ-yyyy-NNNNN`, assigned at the moment the transfer transitions
     `draft → in_transit` (on `Send`).
   - Tanda terima: `TT-yyyy-NNNNN`, assigned at the moment the transfer transitions
     `in_transit → completed` (on `Receive`).
   - Both per-year sequences via a new `doc_sequences` counter table (atomic
     in-tx increment, mirrors the existing `getNextTransferNo` pattern).
10. **Permissions.**
    - Backoffice surat-jalan generate / share / download = existing **`manage_inventory`**
      (same gate that allows Send/Receive/Cancel). No new endpoint, no new perm —
      all data is already in `GET /transfers/{id}` + `GET /app-settings`.
    - POS Cetak Tanda Terima = **any cashier of the destination outlet**. No
      additional gate beyond the SP3 receive auth that already happened.
11. **Share-sheet payload = PNG only.** Bagikan attaches just the rendered PNG (best
    WhatsApp inline-preview UX). PDF stays available via Unduh PDF for formal /
    email use.

## Current-state facts (verified during brainstorm)

- **Backoffice is web** (`apps/backoffice`, Cloudflare Pages auto-deployed from
  `prod-hardening`). No Capacitor, no BLE access from this surface.
- **`@mandalika/printer`** (`packages/printer`) already exposes `buildReceipt`,
  `buildRecap`, `printReceipt`, `printRecap` over a `PrinterTransport` that is
  `CapacitorBleTransport` on native and `NoopTransport` in the browser. 58 mm
  / 32 col / I-Ware C5813 ESC/POS. `BOLD_ON/OFF`, `DOUBLE_ON/OFF`, `ALIGN_*`,
  `FEED_3`, `CUT`, `Buf` chain helper — all reusable for `buildTandaTerima`.
- **PrinterProvider** (`apps/pos/src/printer.tsx`) holds the paired-device id in
  the secure KV and exposes `print(...)`, `printRecap(...)`, `testPrint(...)`,
  `isPaired`. SP4 will add `printTandaTerima(...)`.
- **No PDF / image lib is installed** in any app today (`jspdf`, `html2canvas`,
  `html-to-image`, `pdf-lib`, `@react-pdf/renderer` — none present). SP4 adds
  `html-to-image` (~25 kB) + `jspdf` (~55 kB) to `apps/backoffice` only.
- **Transfer DTO** already carries `transferNo`, `source {kind,name,id}`,
  `dest {kind,name,id}`, `items[]` with `productName`, `variantSize`, `sku`,
  `sentQty`, `receivedQty`, `difference`, `status`, `note`, `discrepancyReason`,
  `createdAt`. SP4 extends with `suratJalanNo` + `tandaTerimaNo` (nullable).
- **SP3 inbound poll** (`GET /api/v1/sync/inbound-transfers`,
  `engine.getInboundTransfers()`) already carries the full Transfer payload for
  in-transit inbound transfers — so the POS already has the data it needs to
  print a tanda terima after its own `Receive` settles.
- **`app_settings`** is the canonical brand-level settings home; receipt header/
  footer already live there. SP4 colocates the document brand block here.

## Architecture (data flow)

```
ADMIN (backoffice / web)              CASHIER (POS / native)
─────────────────────────             ────────────────────────────────────
[transfer.draft]
     │ Kirim
     ▼
backend: ReceiveTx
  • status → in_transit
  • assign surat_jalan_no       ──sync──►  inbound poll → engine.getInboundTransfers()
     │                                       │
     ▼                                       │  (cashier sees inbound list)
SuratJalanPanel renders                      ▼
  • Bagikan  → render PNG → Web Share API   [Terima] → SP3 informed count + PIN
  • Unduh PDF → jsPDF wrap → anchor.click()  │
  • Unduh PNG → anchor.click()               │ enqueueTransferReceive (offline-safe)
  • Lihat    → modal preview                 ▼
     │                              backend ReceiveTx
     │                                • status → completed
     │                                • assign tanda_terima_no
     │                                • content_version bump (existing)
     │                                       │ ack → onReceiveAccepted
     │                                       ▼
     │                              TandaTerimaPrompt modal
     │                                • [Cetak] → buildTandaTerima → BLE write
     │                                • [Lewati] → close
     ▼                                       ▼
[transfer.in_transit]                 [transfer.completed on POS]
     │ (later, post-receive sync)            │ later: "Cetak Ulang" button
     ▼                                       ▼
[transfer.completed] — SuratJalanPanel still available for re-share
```

## Schema (Migration 0018)

```sql
-- Brand-level document defaults (single row alongside existing app_settings)
ALTER TABLE app_settings ADD COLUMN documents_logo_url      TEXT;
ALTER TABLE app_settings ADD COLUMN documents_brand_name    TEXT;
ALTER TABLE app_settings ADD COLUMN documents_address_lines TEXT;   -- newline-separated
ALTER TABLE app_settings ADD COLUMN documents_phone         TEXT;
ALTER TABLE app_settings ADD COLUMN documents_npwp          TEXT;

-- Per-location overrides (NULL ⇒ fall back to brand)
ALTER TABLE warehouses ADD COLUMN address_lines TEXT;
ALTER TABLE warehouses ADD COLUMN phone         TEXT;
ALTER TABLE warehouses ADD COLUMN logo_url      TEXT;
ALTER TABLE outlets    ADD COLUMN address_lines TEXT;
ALTER TABLE outlets    ADD COLUMN phone         TEXT;
ALTER TABLE outlets    ADD COLUMN logo_url      TEXT;

-- Document numbers assigned at status transition
ALTER TABLE transfers ADD COLUMN surat_jalan_no  TEXT UNIQUE;   -- 'SJ-2026-00001'
ALTER TABLE transfers ADD COLUMN tanda_terima_no TEXT UNIQUE;   -- 'TT-2026-00001'

-- Per-year counter rows for the two doc kinds
CREATE TABLE doc_sequences (
  kind     TEXT  NOT NULL,        -- 'SJ' or 'TT'
  year     INT   NOT NULL,
  next_seq BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, year)
);
```

Backfill: existing in-transit or completed transfers stay `NULL` — they predate the
documents feature and don't need retroactive numbers. The backoffice panel checks
for a present number before offering doc actions.

## Backend changes (Go)

### `internal/write/transfers.go`

- `Send(tx, transferID)` — at the end of the existing tx (after in-transit deduct):
  ```go
  n, err := nextDocNo(tx, "SJ", year)        // year = time.Now().Year()
  if err != nil { return err }
  if err := setSuratJalanNo(tx, transferID, n); err != nil { return err }
  ```
- `Receive(tx, transferID, meta ReceiveMeta)` — at the end of the existing tx
  (after credit + discrepancy):
  ```go
  n, err := nextDocNo(tx, "TT", year)
  if err != nil { return err }
  if err := setTandaTerimaNo(tx, transferID, n); err != nil { return err }
  ```
- `nextDocNo(tx, kind, year string)` — atomic counter (`next_seq` IS the assigned
  number, not the "next one to use"):
  ```sql
  INSERT INTO doc_sequences (kind, year, next_seq) VALUES ($1, $2, 1)
  ON CONFLICT (kind, year) DO UPDATE SET next_seq = doc_sequences.next_seq + 1
  RETURNING next_seq;
  ```
  - First call for `(kind, year)`: row inserted with `next_seq = 1`, returns `1` → `SJ-2026-00001`.
  - Subsequent calls: row updated to `old + 1`, returns the new value.
  - Format: `fmt.Sprintf("%s-%d-%05d", kind, year, n)` — uses the returned value
    directly.
  - Concurrency: `ON CONFLICT DO UPDATE` takes a row-level lock; two concurrent
    sends in the same year/kind serialize on this row, each gets a distinct
    number.

### `internal/read/transfers.go`

- `Transfer` DTO gains `SuratJalanNo *string` + `TandaTerimaNo *string`.
- All read paths (`GetTransfer`, `ListTransfers`, the inbound-poll handler that
  reuses the transfer-to-DTO mapper) emit the new fields automatically.

### `internal/read/app_settings.go`, `internal/write/app_settings.go`

- `AppSettings` DTO gains a `Documents` block:
  ```go
  type DocumentSettings struct {
      LogoURL      *string  `json:"logoUrl"`
      BrandName    *string  `json:"brandName"`
      AddressLines *string  `json:"addressLines"`     // newline-separated
      Phone        *string  `json:"phone"`
      NPWP         *string  `json:"npwp"`
  }
  ```
- `PUT /api/v1/app-settings` accepts the block; existing receipt block stays
  untouched.

### Warehouses & outlets

- Both DTOs gain optional `AddressLines`, `Phone`, `LogoURL`. Read+write paths
  pass them through. No business logic depends on them.

### OpenAPI

`backend/api/openapi.yaml` is the single source of truth; the changes above are
added there and `oapi-codegen` regenerates `api.gen.go` + `packages/api`. The CI
gate `make gen-check` will fail if the generated file drifts.

### Tests (Go)

- `repo_test.go`: `nextDocNo` happy path, concurrent calls (each gets a distinct
  number), per-year reset (calling for year 2027 starts at 00001 while 2026
  continues at its own counter).
- `transfers_test.go`: `Send` populates `surat_jalan_no` uniquely;
  `Receive` populates `tanda_terima_no` uniquely; cancelling a draft never
  assigns SJ; cancelling in-transit (existing flow) keeps the assigned SJ on
  the now-cancelled transfer (acceptable — the number is consumed, no
  re-use).

## Backoffice changes (React, `apps/backoffice`)

### New deps

- `html-to-image@^1` — ~25 kB gzipped, no Chrome/headless dependency.
- `jspdf@^2` — ~55 kB gzipped.

Both added to `apps/backoffice/package.json` only (not POS, not shared).

### New / extended files

- **`apps/backoffice/src/lib/letterhead.ts`** — pure resolver:
  ```ts
  export interface Letterhead {
    logoUrl: string | null;
    brandName: string;
    addressLines: string[];        // already split on \n, trimmed, empty lines dropped
    phone: string | null;
    npwp: string | null;
    locationName: string;          // 'Gudang Pusat' / 'Mandalika PMS'
  }
  export function resolveLetterhead(
    location: { name: string; addressLines?: string|null; phone?: string|null; logoUrl?: string|null },
    brand:    DocumentSettings,
  ): Letterhead
  ```
  Per-location field wins when non-null; otherwise fall back to `brand.*`.

- **`apps/backoffice/src/screens/transfers/docs/SuratJalanDoc.tsx`** — pure React
  component, L2 layout, accepts `{ transfer, senderLetterhead }`. Inline CSS only
  (no Tailwind class deps), explicit pixel dimensions for predictable canvas
  rendering. Renders into a hidden off-screen `<div>` mounted on demand.

- **`apps/backoffice/src/screens/transfers/docs/render.ts`** —
  ```ts
  export async function renderSuratJalanPng(t: Transfer, sender: Letterhead): Promise<Blob>
  export async function renderSuratJalanPdf(t: Transfer, sender: Letterhead): Promise<Blob>
  export async function shareSuratJalan(blob: Blob, filename: string): Promise<void>
  ```
  `shareSuratJalan` uses `navigator.canShare({ files: [file] })` → `navigator.share(...)`;
  falls back to triggering a download anchor + toast
  *"Share API tidak tersedia — bagikan secara manual."* when not supported (desktop
  Firefox, older browsers).

- **`apps/backoffice/src/screens/transfers/SuratJalanPanel.tsx`** — the inline panel.
  Hidden unless `transfer.suratJalanNo` is set (i.e. status ∈ {in_transit, completed}).
  Buttons: Bagikan (calls `shareSuratJalanPng`), Unduh PDF (downloads file with name
  `suratjalan-${SJNo}.pdf`), Unduh PNG (same with `.png`), Lihat (full-screen modal
  preview using the same React component, no canvas render).

- **`apps/backoffice/src/screens/transfers/Transfers.tsx`** — `TransferDetail` mounts
  `<SuratJalanPanel transfer={t} />` immediately under the `PageHeader` when
  `t.suratJalanNo` is truthy. No layout disruption when number is null (panel
  renders nothing).

- **`apps/backoffice/src/screens/Settings.tsx`** (or wherever the existing
  app_settings UI lives) — add a new "Dokumen" section with `logoUrl` (Cloudinary
  upload, reusing the existing product-image signer endpoint), `brandName`,
  `addressLines` (textarea), `phone`, `npwp`. Save via the existing
  `PUT /api/v1/app-settings`.

- **`apps/backoffice/src/screens/warehouses/`** (existing edit modal) — add
  optional **Alamat** (textarea), **Telepon**, **Logo** fields. Same for the
  outlets edit modal.

### Tests (Vitest)

- `letterhead.test.ts` — fallback semantics: location override wins; NULLs fall
  through to brand; both NULL → `null` (caller decides display).
- `SuratJalanDoc.test.tsx` — render snapshot with a fixture transfer + letterhead;
  verify L2 elements are present (logo, brand, doc title, Dari/Untuk blocks,
  table, 2 signature lines, no Sopir line).
- `render.test.ts` — `shareSuratJalan` falls back to anchor-download when
  `navigator.share` is undefined (jsdom default).

## POS changes (`apps/pos`, `packages/printer`)

No new deps.

### `packages/printer/src/escpos.ts`

Add:

```ts
export interface TandaTerimaLine {
  productName: string;
  variant: string;       // e.g. '50ml'
  sentQty: number;
  receivedQty: number;
  difference: number;    // receivedQty - sentQty
}

export interface TandaTerimaData {
  tandaTerimaNo: string;             // 'TT-2026-00001'
  transferNo: string;                // 'TRF-00005'
  receivedAt: Date;
  receiverHeaderLines: string[];     // resolved letterhead text (brand or override)
  senderName: string;                // 'Gudang Pusat'
  items: TandaTerimaLine[];
  discrepancyReason: string | null;
  receivedByName: string;
}

export function buildTandaTerima(
  data: TandaTerimaData,
  settings: ReceiptSettings,         // reused for headerText/footerText overrides
): Uint8Array
```

Layout (Buf chain, 32-col, mirroring `buildRecap`):

```
ALIGN_CENTER + BOLD + header[0]              (brandName, double size)
header[1..]                                  (address / phone lines, normal)
divider
ALIGN_CENTER + BOLD             TANDA TERIMA
divider
ALIGN_LEFT
No        : TT-2026-00001
Ref       : TRF-00005
Tgl       : dd/MM/yy HH:mm
Dari      : <senderName>
divider
            Krm   Trm   Sel    (column header line, padded)
for each item:
  productName (truncated to COLS)
  '  variant' padded with columns (right-aligned 4-3-3? — see math)
divider
Selisih: <discrepancyReason>     (if present)
divider
Diterima oleh: <receivedByName>
LF
______________________
Tanda Tangan
LF
ALIGN_CENTER
Dicetak <dd/MM/yy HH:mm>
FEED_3 + CUT
```

**Column math for the K / T / S triplet** (locked):
- Total width = 32 cols (Font A on 58 mm).
- The product name + variant span the full 32 cols on their own lines (truncated to
  fit), so the 3-column quantity grid only needs to align *under* them.
- Quantity grid (own line, right-aligned digits, 2 spaces between groups, no
  separators) — total must equal 32:
  - Row line: `'  '` (2-col indent, existing style for variant lines) +
    `variant.padEnd(17)` + `krm.padStart(3)` + `'  '` + `trm.padStart(3)` + `'  '` +
    `sel.padStart(3)` = **2 + 17 + 3 + 2 + 3 + 2 + 3 = 32**. ✓
  - Header line (one-time, above the items): `' '.repeat(19)` + `'Krm'` + `'  '` +
    `'Trm'` + `'  '` + `'Sel'` = **19 + 3 + 2 + 3 + 2 + 3 = 32**. ✓
  - The product name renders on its own preceding line via
    `b.line(item.productName.slice(0, COLS))`; the variant+qty line follows.
- Discrepancy line wraps at 32 cols using the existing `pad` helper from
  `escpos.ts`.
- Verified by the golden Vitest snapshot — drift in any of these constants fails
  the test.

### `packages/printer/src/print.ts`

```ts
export interface TandaTerimaJob {
  transport: PrinterTransport;
  deviceId: string | null;
  data: TandaTerimaData;
  settings: ReceiptSettings;
}
export async function printTandaTerima(job: TandaTerimaJob): Promise<void>
```

Same pattern as `printRecap` — connect, write once, disconnect.

### `apps/pos/src/printer.tsx` (PrinterProvider)

Add `printTandaTerima(data, settings)` to the context, identical shape to
`printRecap`.

### `apps/pos/src/cashier/transfers/`

- **`TandaTerimaPrompt.tsx`** — small modal triggered from the SP3 receive
  pipeline's **server-ack** handler (not the optimistic-credit handler — see
  *Open risk* below). Props: `{ transfer: Transfer, onClose: () => void }`.
  Renders title "Tanda terima siap", short summary (TT-no, sender name), and
  two buttons:
  - **Cetak** — calls `printer.printTandaTerima(buildData(transfer), settings)`.
    Disabled when `!printer.isPaired` with helper text. On success: toast
    "Tanda terima dicetak"; on BLE failure: toast + error reported via
    `errorReporter` (existing infra), modal stays open so user can retry.
  - **Lewati** — closes the modal. Persistent reprint stays available on the
    completed transfer detail.
- **Reprint affordance** — extend the existing inbound/completed transfer
  detail screen with a "Cetak Tanda Terima" button visible when
  `transfer.tandaTerimaNo` is set.

### Where the trigger fires (precise)

SP3's `enqueueTransferReceive` flow already has an `onReceiveAccepted`
callback path (FU-1/FU-2 wiring). SP4 hooks that callback:

```ts
onReceiveAccepted: (transferId) => {
  const t = engine.getCompletedTransfer(transferId);   // or refetch
  if (t?.tandaTerimaNo) showTandaTerimaPrompt(t);
}
```

The optimistic-credit path does **not** fire the modal — it waits for the
server ack so we never print a slip for a receive that ends up rejected via
FU-2 (backoffice force-receive collision). Cost: one sync cycle (~seconds
online; whenever connectivity returns offline). Acceptable.

### Tests

- `escpos.test.ts` — Vitest: `buildTandaTerima` golden snapshot for a
  representative fixture (with and without discrepancy reason; empty
  receiverHeaderLines edge case).
- `apps/pos/src/cashier/transfers/TandaTerimaPrompt.test.tsx` — Vitest +
  jsdom: [Cetak] disabled when not paired; clicking [Cetak] calls
  `printer.printTandaTerima`; [Lewati] closes.

## Permissions summary

| Surface | Action | Gate |
| --- | --- | --- |
| Backoffice | View SuratJalanPanel / generate / share / download | `manage_inventory` (existing, gates the whole transfer detail page) |
| Backoffice | Edit `app_settings.documents` block | `manage_settings` (existing for the settings screen) |
| Backoffice | Edit warehouse / outlet letterhead override | existing warehouse/outlet edit perm |
| POS | Cetak Tanda Terima from auto-prompt | any cashier of the dest outlet (no extra gate) |
| POS | Cetak Ulang Tanda Terima from completed detail | same |

No new permission introduced.

## Open risks & mitigations

- **Modal-vs-rejection race (mitigated).** A receive can be rejected by the
  server (SP3 FU-2 force-receive collision). Mitigation: the prompt only fires
  on the server-ack callback, not on optimistic credit. The slip never reflects
  a rolled-back receive.
- **Web Share API support gap.** Mobile browsers and Chrome desktop support
  `navigator.share` with files; Firefox desktop doesn't. Fallback = anchor
  download + toast. Acceptable because the user is told what to do; the file
  is still produced.
- **PNG fidelity.** `html-to-image` uses `foreignObject + serializer`. Custom
  fonts can fail to embed in the rendered SVG. Mitigation: the surat jalan
  component uses **system-stack** sans-serif fonts only (`ui-sans-serif,
  system-ui, -apple-system, sans-serif`). No web-font dependency.
- **Cancelling an in-transit transfer "wastes" an SJ number.** Acceptable —
  sequence holes are normal for ID-style numbers and don't break audit. We
  do not re-use cancelled numbers.
- **Tanda terima per-year sequence vs cross-year transfers.** Receive year ≠
  send year is possible (a transfer sent on Dec 31 received on Jan 1). TT uses
  the **receive year** for the number. Documented as intentional.

## Testing strategy

- **Go unit tests** (existing `go test` pattern):
  - `nextDocNo` per-year sequence, concurrent calls produce distinct numbers.
  - `Send` / `Receive` write SJ / TT numbers in their existing tx.
  - DTO round-trip including new fields.
- **Vitest** (existing `pnpm --filter <app> test`):
  - `buildTandaTerima` golden snapshot.
  - `letterhead.resolveLetterhead` fallback semantics.
  - `SuratJalanDoc` render snapshot.
  - `render.ts` Web-Share-API fallback path.
  - `TandaTerimaPrompt` interaction.
- **Manual E2E (after implementation)**:
  - Backoffice: send transfer → SuratJalanPanel appears → Bagikan opens
    share-sheet on mobile Chrome → WhatsApp inline preview works.
  - POS (device): receive transfer → modal pops on ack → [Cetak] prints clean
    32-col slip with Krm/Trm/Sel + reason. Reprint button works on completed
    detail.
  - Cancelled in-transit: SJ number stays, panel stays available (read-only).

## Out of scope (deferred)

- WhatsApp Business API (locked: OS share-sheet only).
- Server-side rendering or binary archival of the doc snapshots — all data is
  reproducible from `Transfer` + `app_settings.documents` + the location row.
- Bulk export of surat jalans (not requested).
- Per-warehouse/outlet `npwp` override — stays brand-level.
- Embedding a logo image on the thermal slip (ESC/POS raster bit images, GS v 0)
  — slips stay text-only. The PDF surat jalan carries the logo.

## Acceptance criteria

A backoffice admin can:
- (AC1) Edit the `app_settings.documents` brand block (logo, name, address, phone,
  npwp) and per-warehouse / per-outlet overrides; saves persist.
- (AC2) Send a transfer; immediately see a "Surat jalan siap" panel with PNG
  preview thumbnail and four actions; Bagikan opens the OS share-sheet on a
  supporting browser with the PNG attached; Unduh PDF / PNG produces the file;
  Lihat shows a full-fidelity modal preview.
- (AC3) Re-open a completed transfer days later and re-share / re-download the
  same surat jalan from the persistent panel.

A POS cashier at the destination outlet can:
- (AC4) Receive a transfer via the SP3 flow; once the server ack arrives, see a
  "Tanda terima siap. Cetak sekarang?" modal with [Cetak] and [Lewati].
- (AC5) [Cetak] prints a clean 32-col thermal slip with the receiver letterhead,
  TT number, Ref TRF number, Dari, Krm/Trm/Sel table, discrepancy reason if any,
  cashier name, and a signature line.
- (AC6) Reprint the tanda terima later via "Cetak Ulang" on the completed
  transfer detail.

The system:
- (AC7) Assigns `SJ-yyyy-NNNNN` exactly once per send, `TT-yyyy-NNNNN` exactly
  once per receive; per-year sequences; no duplicates under concurrent calls.
- (AC8) Cancellation never assigns a new doc number; SJ assigned at send is
  retained on a cancelled in-transit transfer (number "burned", acceptable).
- (AC9) No new endpoint or permission is introduced; existing
  `GET /transfers/{id}`, `GET /app-settings`, and `manage_inventory` perm suffice.
