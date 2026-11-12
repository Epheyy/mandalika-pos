# Receipt designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner designs the printed receipt in the Backoffice (blocks, order, light styling, templates per outlet, 58/80mm, logo, QR). One renderer prints it on the tablet and draws the Backoffice preview. Today's receipt prints unchanged until someone edits it.

**Architecture:**
- `packages/printer` gains a pure block renderer. It writes to a sink: the ESC/POS sink gives bytes, the preview sink gives text lines.
- A built-in "Standar" layout is derived from today's `ReceiptSettings` and reproduces today's bytes exactly. `buildReceipt` becomes a thin wrapper over it.
- Templates live in their own table, with a per-outlet assignment. The sync pull ships each tablet its outlet's resolved template. With no template, the tablet prints Standar, exactly as today.

**Tech Stack:** TypeScript (`@mandalika/printer`, POS React/Capacitor, Backoffice React, vitest), Go + Postgres (pgx, chi), OpenAPI with the custom `cmd/codegen` and `openapi-typescript`, and `@dnd-kit` (already used by the POS).

**Spec:** `docs/plans/2026-11-12-receipt-designer-design.md` (mockup `docs/plans/2026-11-12-receipt-designer-mockup.html`)

---

## Design deviations found (code vs design)

1. **Today's receipt is not shaped like the mockup.**
   - It prints the header text double-size with no outlet name, address or phone. Then come `No`/`Tgl`, the items and the totals.
   - Customer and cashier print *after* the payment, as `Pelanggan: …`/`Telp: …`/`Kasir: …` (`packages/printer/src/escpos.ts:191-203, 250-256`).
   - A blank line follows the header only when both header and footer are set (`:184`).
   - **Resolution:**
     - Standar reproduces today's order. It uses a `transaction` block twice: `columns` style at the top and `inline` style at the bottom.
     - A **new** template starts from the mockup's order (`NEW_TEMPLATE_BLOCKS`, Task 1.3).
2. **Byte-for-byte conflicts with "never exceeds the width".** Four lines are sent unwrapped today and rely on the printer's own wrap:
   - the header text (double width, so 17 characters already fill 34 columns);
   - the footer text;
   - `Pelanggan: <name>`;
   - `Kasir: <name>`.

   **Resolution:**
   - Standar carries `compat: 'v1'`, which keeps those four lines and the Latin-1 byte mapping exactly as today.
   - Every stored template is non-compat. It wraps all text in software at the width, or at half the width for large text, and the width tests cover it.
   - The preview models the printer's wrap, so a preview line is never wider than the paper. Editing Standar in the designer drops `compat`.
3. **The tablet has only the outlet name.** The pull selects `code, name, timezone` (`backend/internal/sync/pull.go:104`).
   - **Resolution:** the pull also ships `outletAddress` and `outletPhone` (Task 2.3).
4. **The logo from `Outlet.logoUrl` cannot print offline.**
   - `logoUrl` is a Cloudinary URL (`apps/backoffice/src/lib/uploadImage.ts:18-24`), and nothing on the tablet decodes images.
   - **Resolution:** the Backoffice dithers the image when it is designed. The template stores a packed 1-bit raster, so the tablet never fetches anything. "Ambil logo brand" loads `documents.logoUrl` into the same pipeline.
   - One template serves many outlets, so a per-outlet logo is decision O2.
5. **Member points are an estimate on the tablet.**
   - `earnedPoints` is computed for display (`apps/pos/src/cashier/pricing.ts:415`), and the POS labels it "tampilan sementara" (`CustomerChip.tsx:99`). The server grants the real points.
   - The receipt snapshot does not store it, so a reprint cannot show it.
   - **Resolution:** the points block prints only on the live sale, with estimate wording (decision O1).
6. **No refund receipt exists today.** Only sales, the shift recap and tanda terima print. `RefundDialog`/`RefundAction` print nothing, and the refund is only enqueued (`CashierScreen.tsx:1130` on bundles P3 `cfd6f286`).
   - **Resolution:** Phase 5 adds a REFUND slip as a new print, not a restyle (decision O3).
   - The Void plan's DIBATALKAN is a short summary slip (void plan Task 3.5, `buildVoidSlip`). Phase 5 frames that slip with the template's logo and header blocks.
7. **"Cetak tes before saving" has no channel.** The Backoffice cannot reach a tablet. Today's "Tes Cetak" button prints a fixed sample (`apps/pos/src/printer.tsx:137`, `screens/SettingsScreen.tsx:130-140`).
   - **Resolution:** the Backoffice posts the unsaved draft for one outlet to the server (migration 0096). That outlet's "Tes Cetak" button fetches it online and prints it with the sample sale.
8. **Pengaturan › Struk is a card inside Pengaturan › Transaksi** (`apps/backoffice/src/screens/settings/TransaksiSection.tsx:165-212`).
   - **Resolution:** add a new tab, "Struk" (`#/pengaturan/struk`), for the designer.
   - "Jumlah salinan" and "Cetak struk otomatis" are tablet behaviour. They stay on the Transaksi card, which loses its header, footer and switches.
9. **The template sets the paper width, but a tablet cannot know its printer's width.**
   - **Resolution:** a per-device paper width setting, default 58mm. The tablet renders at `min(template width, device width)`, and the blocks reflow. The clamp ships in Phase 2 and the setting UI in Phase 4.
10. **Change is locked in the design but switchable today.** The design locks "Payment and change" (design line 44), and the mockup shows `Pembayaran & kembalian 🔒 wajib`. Today `showChange` can hide `Kembalian` (`escpos.ts:245`).
    - **Resolution:** in every stored template, payment **and** change are locked: `payment` has no `showChange`, and `Kembalian` prints whenever change > 0.
    - Only Standar (`compat`) still honours today's `showChange`, so day one stays byte-identical. Editing Standar removes the switch.
Builder decisions with no design conflict, such as the code page and detecting raster support, are in Global Constraints.

## Open owner decisions (defaults built unless the owner says otherwise)

- **O1, points wording.** Default: the rows read `Perkiraan poin` (`+80`) and `Perkiraan saldo` (`1.240`). They print on the live sale, including a retry of that sale's failed print. They never print on a reprint from history or from the local receipt list.
- **O2, logo source.** Default: one logo per template, either uploaded or taken from the brand logo (`documents.logoUrl`). A per-outlet logo needs a raster stored per outlet and is deferred.
- **O3, refund slip.** Default: build it in Phase 5. It prints once (copies not applied) after a refund is saved on the tablet, when a printer is paired.
- **O4, legacy fields after Standar is edited.** Default: frozen. Tablets older than the Phase 2 OTA keep printing today's layout from `appSettings.receipt`. Templates do not mirror back into it.
- **O5, test-print relay.** Default: keep the Cetak tes server relay (migration 0096, Tasks 4.2–4.4), so a draft can be test-printed before it is saved. The alternative needs no relay and no migration: `Duplikat` the template, assign the copy to one outlet, then tap Tes Cetak on that outlet's tablet.

## Dependencies on bundles and Void

- **Hard start dependency for Phase 1.** Two branches edit `escpos.ts`, and both must be merged into `prod-hardening` first:
  - **Bundles Phase 3** (`feat/bundles-3-pos`, branch head `cfd6f286`). It adds `ReceiptLine.pieces` (printed as `"  + <piece>"`), `ReceiptLine.lineDiscount`, and the `0xB7`→`-` byte mapping. `collapseBundleLines`/`bundleReceiptLine` live in `apps/pos/src/cashier/bundleReceipt.ts` and stay there.
  - **Void Task 3.5.** It adds `ReceiptData.replacesOrderRef`/`correctionAmount`, the `Pengganti untuk #…` and `Penyesuaian koreksi` rows, and `buildVoidSlip`/`VoidSlipData`.
  - Task 1.1 freezes `buildReceipt` **as it is on that base**.
- **Bundles Phase 4** changes only `bundleReceipt.ts` (the discount label). Re-check at build time that it left `escpos.ts` alone. If it did not, re-freeze in Task 1.1.
- **Phase 5 depends on Void Phase 3** (`printVoidSlip` in `apps/pos/src/printer.tsx`).
  - **Coordination point:** Void plan Task 3.5 defines `printVoidSlip(data)` (void plan line 1030). Phase 5 changes it to `printVoidSlip(data, settings, layout)`, updating every caller. Tell the Void implementer.
- **Migrations.** Void uses 0092–0094, and 0094 is blocked on the ERP. This plan uses **0095** (Phase 2) and **0096** (Phase 4).
  - The runner applies files in name order and skips names already recorded (`backend/internal/db/db.go:95-125`), so 0095 may land before 0094.
  - If a number is taken at merge time, renumber it in the same PR.
- **CashierScreen line references** in this plan are from bundles P3 `cfd6f286`:
  - sale print: about `:985-1007` (`.print` at `:1001`);
  - `handleReprint`: `:1011`/`:1020`;
  - `reprintLocal`: `:1030`;
  - `reprintOrder`: `:1060`;
  - refund enqueue: `:1130`;
  - `receiptQuote` extras Pick: `:166`.

  Void Phase 3 will shift them again; re-locate them when the task starts.
- **Postgres gate.** Void takes port 26482. This plan takes **26483** (prefix `RT`).

## Phases and release order

| Phase | Branch | Ships | Migration | Tasks |
|---|---|---|---|---|
| 1 | `feat/receipt-1-renderer` | POS OTA (bytes unchanged) | — | 3 |
| 2 | `feat/receipt-2-templates` | backend, then POS OTA | 0095 | 4 |
| 3 | `feat/receipt-3-designer` | Backoffice | — | 3 |
| 4 | `feat/receipt-4-logo-qr` | backend, Backoffice, POS OTA; on-device check before release | 0096 | 5 |
| 5 | `feat/receipt-5-stamps` | POS OTA | — | 2 |

**Why this slicing:**
- **Phase 1** is a pure refactor whose only proof is the golden diff. Shipping it alone means a byte change can never hide inside a feature.
- **Phase 2** is the contract and sync slice that Opus reviews. It is inert until a template exists, and the API is the only way to create one.
- **Phase 3** is UI only. It needs Phase 2 live.
- **Phase 4** isolates the printer abilities, which only a device can prove.
- **Phase 5** waits on Void.

**Release:** backend first, then the Backoffice, then the POS OTA. No phase changes native code. An APK is needed only if the on-device check (Task 4.5) shows the native SPP `write` cannot take a ~20KB payload in one call.

## Global Constraints

- **Byte-for-byte:**
  - Standar from any `ReceiptSettings` produces exactly the bytes of the frozen legacy `buildReceipt` for the same `ReceiptData` and `reprint` flag.
  - Golden tests pin the timezone with `process.env.TZ = 'Asia/Jakarta'`, set in the test setup before any `Date` formatting.
  - The setup asserts that one known instant formats to its expected `id-ID` string, so a TZ setting that did not apply (for example on Windows) fails loudly.
  - The hex goldens depend on ICU through `toLocaleString`; a Node or ICU upgrade may require regenerating them. The differential test does not depend on ICU.
  - `buildRecap` and `buildTandaTerima` stay byte-identical, and each gets its own golden.
- **Geometry:**
  - `COLS_BY_WIDTH = { 58: 32, 80: 48 }`. Large text (`GS ! 0x11`) takes 2 columns per character.
  - Raster images are at most **384 dots** wide (a multiple of 8, so they fit 58mm and the 58mm clamp) and at most **240 dots** high.
- **Limits** (TS `RECEIPT_LIMITS` and Go `receipttpl` constants, pinned by one shared case file):

  | Field | Limit |
  |---|---|
  | Blocks | 3–30 |
  | Template name | 1–60 chars, unique case-insensitive |
  | Text block | ≤ 500 chars, ≤ 12 lines |
  | All `text` + `header` text in a template | ≤ 1,500 chars (keeps the payload bounded) |
  | Header title | ≤ 64 chars |
  | Block label | ≤ 40 chars |
  | Templates | ≤ 50 |
  | Image blocks | ≤ 2, total raster ≤ 11,520 bytes |
  | QR blocks | ≤ 2 |
  | QR URL | `http://` or `https://`, ≤ 300 chars |
  | Upload input | png/jpeg/webp, ≤ 2 MB |

- **Printable text and code page:**
  - Stored text fields (`text`, `url`) hold printable ASCII `0x20–0x7E`, plus `\n` in `text` only. `name` and `label` are Backoffice-only and may be any UTF-8.
  - Today's `bytes()` sends Latin-1 as-is (`escpos.ts:140-148`), while the printers start in CP437. So the designer normalises typed text, and non-compat layouts also normalise data text, through `toPrinterText`. Standar keeps today's mapping.
- **Normalisation happens once, in the renderer.**
  - For a non-compat layout, `render.ts` passes all data text (names, labels, refs, outlet info) and template text through `toPrinterText` **before** any pad, wrap or centre.
  - So expansions like `…`→`...`, and NFKD, cannot lengthen a line after layout.
  - The sinks are pure byte maps (`encodeLegacy`).
- **Raster and QR cannot be detected over SPP.** An unsupported command prints garbage and never errors, so a per-device `Cetak logo & QR` switch decides. Off means the logo is skipped and the QR prints its URL as text.
- **Locked blocks:**
  - `items`, `totals` and `payment` each appear exactly once, are always enabled, and keep that relative order. Other blocks may sit between them.
  - In stored templates, `TOTAL`, the payment rows and `Kembalian` (when change > 0) always print (deviation 10).
  - The C1 rule stays: on an itemised slip (`data.discounts !== undefined`), every deduction, PPN, surcharge, points redemption and rounding row prints whatever the switches say.
- **Printing rules unchanged (#136):** `runExclusive` serialisation, connect → write×copies → disconnect, and `Gagal…` copy via `printerErrorMessage`.
- **Never fail the sale's print; never lose a locked block.**
  - The production fallback is `packages/printer/src/__legacy__/buildReceiptV1.ts`, the frozen copy of today's `buildReceipt`. It shares no code with the renderer, so a renderer bug cannot also break the fallback.
  - An **unlocked** block that throws is skipped and reported.
  - A **locked** block (`items`, `totals`, `payment`) that throws aborts the whole layout. The tablet then prints `buildReceiptV1(data, settings, reprint)`.
  - Every fallback is reported through `reportErrors` (`source: 'print', kind: 'receipt_template'`).
- **OpenAPI:**
  - Block fields are optional and **not** `nullable`, with no `nullable` on a `$ref`. Blocks use a flat schema (a `type` enum plus optional fields), with no `oneOf`.
  - Run `corepack pnpm gen:check` and `cd backend && make gen-check`.
  - Add no top-level test in `backend/internal/api` or `backend/internal/codegen` (`scripts/ci/codegen_gate.py:18-19`).
- **Postgres gate:**
  - New `TestReceiptTemplatesPostgres` (`gatePool(t, "RT", 26483)`) in `backend/internal/handlers/receipt_templates_integration_test.go`. Register `("RT", "TestReceiptTemplatesPostgres", 26483, "rt")` in `scripts/ci/postgres_gate.py` after `BN`, or after Void's `VD`.
  - Widen the reserved range to `26439-26483` in `.github/workflows/postgres.yml:51,53,56`, `scripts/ci/runner-provision.sh:33` and `scripts/ci/README.md:13,102`.
- **Dependencies:** `apps/backoffice/package.json` gains `@mandalika/printer: workspace:*` and `@dnd-kit/core`/`sortable`/`utilities` at the POS versions (`apps/pos/package.json:27-29`). Ship `pnpm-lock.yaml` in the same commit (`corepack pnpm install --lockfile-only`).
- **No Capacitor in the Backoffice:** it imports only `@mandalika/printer/render`, a new pure subpath.
- **Copy (Indonesian):**

  | Where | Copy |
  |---|---|
  | Tab | `Struk` |
  | Page title | `Desain Struk` |
  | Block names | `Logo`, `Judul & info outlet`, `Info transaksi`, `Daftar barang`, `Diskon & total`, `Pembayaran & kembalian`, `Poin member`, `Teks`, `Garis`, `QR code` |
  | Lock badges | `wajib`, `total wajib` |
  | Add block | `+ Tambah blok` |
  | Paper | `Kertas` `58mm` / `80mm` |
  | Assignment | `Dipakai di N outlet` |
  | Buttons | `Cetak tes di tablet`, `Simpan` |
  | Tablet settings | `Lebar kertas`, `Cetak logo & QR` |
  | Stamps | `REFUND`, `DIBATALKAN` |
  | Stale save | `Template ini sudah diubah di tempat lain. Muat ulang lalu ulangi.` |
  | Delete an assigned template | `Template masih dipakai di N outlet. Pindahkan outletnya dulu.` |
  | Delete Standar | `Template Standar tidak bisa dihapus.` |

- **Reviewer tiers (AGENTS.md):**
  - Opus high reviews the renderer, generated types, sync and settings, anything printed as money, and the print queue and transport.
  - Sonnet medium implements everything and reviews the Backoffice UI.
  - Haiku low checks copy and style only.

## Review Focus

1. **A 48-column template on a 58mm tablet.** It must reflow to 32 columns, never print 48-character lines that the printer wraps into garbage. Owner: Task 2.4 (`resolveReceiptLayout` clamps). Test: `renders a 48-column template at 32 columns when the device width is 58`.
2. **A template that loses its locked blocks** through the API, a hand-edited row or an older server. The server refuses it (Task 2.1). A stored bad row still prints today's Standar on the tablet. A locked block that throws at render time prints the frozen legacy bytes. Owner: Task 2.4. Tests: `layoutFromApi returns null when payment is missing, and the tablet prints Standar` and `printReceipt prints buildReceiptV1 bytes and calls onLayoutError when the items block throws`.
3. **A logo with 5 copies cut off at disconnect.** `drainDelayMs` caps at 3000ms, about 24KB at 8 bytes/ms (`packages/printer/src/linkChoice.ts:20-28`), and the counter adds up across copies. The drain also holds the print queue, because native `doDisconnect` sleeps inside `runExclusive`. Owner: Tasks 4.4 and 4.5, which take the cap from the device measurement. Tests: `drainDelayMs never exceeds DRAIN_MAX_MS and covers 5 × MAX_RECEIPT_PAYLOAD_BYTES at the measured rate` and `runExclusive frees the queue within DRAIN_MAX_MS + 1 s after the last write`.
4. **An outlet whose template is deleted, or a default that cannot resolve.** The pull must still succeed, and the tablet prints Standar. Owner: Task 2.3. Test: `pull_succeeds_when_the_assigned_row_is_gone`.
5. **An older POS build reading the new pull.** It must parse the bundle and keep printing from `appSettings.receipt`, which this plan never changes shape of. Owner: Tasks 2.3 (optional fields) and 2.4. Test: `SyncPullBundle without receiptTemplate still prints Standar`. The old path is the absence case, and `ReceiptSettings` keeps its schema.

Also covered inside the owning tasks:
- an empty template (2.1);
- a huge logo (4.3 refuses files over 2 MB, 4.2 refuses rasters over the limits);
- a 300-character QR URL and an over-long one, which prints as text (4.1);
- a printer without raster support (4.1);
- an offline tablet with a stale template (2.3);
- Indonesian text outside the code page (1.3, 3.2).

---

## Phase 1: Shared renderer (`feat/receipt-1-renderer`, POS OTA, bytes unchanged)

### Task 1.1: Freeze the legacy receipt; text helpers and sinks

Reviewer: Opus high (everything printed goes through these helpers, money included).

**Files:**
- Create:
  - `packages/printer/src/__legacy__/buildReceiptV1.ts`: a verbatim copy of today's `buildReceipt` and its private helpers, exported as `buildReceiptV1(data: ReceiptData, settings: ReceiptSettings, reprint?: boolean): Uint8Array`.
    - It is **production code**: the fallback in Task 2.4, and the reference for the differential tests.
    - It is imported only inside the package, not exported from `index.ts`.
    - Never edit it after Task 1.1.
  - `packages/printer/src/receipt/data.ts`: `ReceiptData`, `ReceiptLine` and `ReceiptDiscountRow` move here unchanged. `escpos.ts` re-exports them.
  - `packages/printer/src/receipt/text.ts`
  - `packages/printer/src/receipt/sink.ts`
  - `packages/printer/src/test/setupTz.ts`, plus `setupFiles` in a new `packages/printer/vitest.config.ts`
- Modify: `packages/printer/src/escpos.ts` (import the helpers from `text.ts`; `buildRecap` and `buildTandaTerima` keep `cols = 32`).
- Test: `packages/printer/src/receipt/text.test.ts`, `packages/printer/src/receipt/sink.test.ts`, `packages/printer/src/escpos.unchanged.test.ts`

**Interfaces:**
- Produces (`text.ts`):
  - `money(n: number): string`, unchanged;
  - `pad(left: string, right: string, cols: number): string`;
  - `wrap(text: string, maxLines: number, cols: number): string[]`;
  - `center(text: string, cols: number): string`;
  - `labelRow(emit: (line: string) => void, label: string, amount: string, cols: number): void`;
  - `encodeLegacy(text: string): number[]` (today's `bytes()`, including `0xB7`→`0x2D` and >`0xFF`→`?`);
  - `toPrinterText(text: string): string`. It applies NFKD, drops combining marks, maps `‘’‚‛`→`'`, `“”„`→`"`, `–—`→`-`, `…`→`...`, `·`→`-` and NBSP→space, and turns any other char outside `0x20–0x7E` and `\n` into `?`.
- Produces (`sink.ts`):
  - `type Align = 'left' | 'center' | 'right'`;
  - `type Cmd = 'init' | 'alignLeft' | 'alignCenter' | 'alignRight' | 'boldOn' | 'boldOff' | 'largeOn' | 'largeOff' | 'feed3' | 'cut'`;
  - `interface ReceiptSink { cmd(c: Cmd): void; line(text?: string): void }`;
  - `class EscPosSink implements ReceiptSink { constructor(); done(): Uint8Array }`. It writes each `Cmd` with today's byte values (`escpos.ts:72-80`, plus `ALIGN_RIGHT = ESC a 2`). `line` writes `encodeLegacy(text)` plus `LF`. It is a pure byte map and never normalises; the renderer already has.
  - `type PreviewLine = { kind: 'text'; text: string; align: Align; bold: boolean; large: boolean }`;
  - `class PreviewSink implements ReceiptSink { constructor(cols: number); done(): PreviewLine[] }`. It tracks align, bold and large from the `Cmd`s. Each line is first mapped exactly as the bytes are (`encodeLegacy`, then decoded back), then split into chunks of `cols` (or `cols/2` when large), modelling the printer's own wrap.

- [ ] **Step 1: Write the failing tests.**
  - `pad/wrap/center at 32 match the legacy helpers on 200 generated strings`
  - `pad at 48 never exceeds 48 and never clips the amount`
  - `toPrinterText maps 'Café “Bunga” – 10ml…' to 'Cafe "Bunga" - 10ml...'`
  - `EscPosSink writes the legacy byte for every Cmd and maps text exactly like encodeLegacy`
  - `PreviewSink splits a 40-char large line into 16+16+8 at cols 32 and keeps bold/align`
  - `PreviewSink text equals what the bytes print (· becomes -, ☺ becomes ?)`
  - `buildRecap and buildTandaTerima bytes are unchanged` (hex golden captured from the base commit). `buildTandaTerima` prints `new Date()`, so pin it with `vi.setSystemTime`.
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `text.ts` and `sink.ts`, copy `buildReceiptV1.ts` verbatim, move the data types, and point `escpos.ts` at the helpers.
- [ ] **Step 4: Run** the same command plus `corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "refactor(printer): cols-aware text helpers, sinks, frozen legacy receipt"`

### Task 1.2: Block renderer, Standar layout, `buildReceipt` delegates

Reviewer: Opus high (totals, payment and C1 rows).

**Files:**
- Create:
  - `packages/printer/src/receipt/layout.ts`
  - `packages/printer/src/receipt/standar.ts`
  - `packages/printer/src/receipt/render.ts`
  - `packages/printer/src/receipt/blocks.ts`: one function per block type.
- Modify: `packages/printer/src/escpos.ts`. `buildReceipt` keeps its signature and body `receiptBytes(standarLayout(settings), data, { reprint })`.
- Test: `packages/printer/src/receipt/standar.golden.test.ts`, plus `packages/printer/src/receipt/__golden__/*.hex` for 6 named cases.

**Interfaces:**
- Consumes: Task 1.1 sinks and helpers; `resolveReceiptFlags` (`packages/types/src/receiptFlags.ts:40`).
- Produces (`layout.ts`):

  ```ts
  type PaperWidth = 58 | 80
  const COLS_BY_WIDTH: Readonly<Record<PaperWidth, number>>
  type TxField = 'orderNumber' | 'date' | 'cashier' | 'customerName' | 'customerPhone'
  type ReceiptBlock =
    | { id: string; type: 'header'; enabled: boolean; text: string; size: 'normal' | 'large'; showOutletName: boolean; showOutletAddress: boolean; showOutletPhone: boolean; spaceAfter?: boolean }
    | { id: string; type: 'transaction'; enabled: boolean; fields: TxField[]; style: 'columns' | 'inline' }
    | { id: string; type: 'items'; enabled: true }
    | { id: string; type: 'totals'; enabled: true; showSubtotal: boolean; showDiscount: boolean; showTax: boolean }
    | { id: string; type: 'payment'; enabled: true; showChange?: boolean }
    | { id: string; type: 'points'; enabled: boolean }
    | { id: string; type: 'text'; enabled: boolean; label?: string; text: string; align: Align; bold: boolean; size: 'normal' | 'large'; spaceBefore?: boolean }
    | { id: string; type: 'divider'; enabled: boolean }
  interface ReceiptLayout { paperWidth: PaperWidth; blocks: ReceiptBlock[]; compat?: 'v1' }
  const LOCKED_TYPES: readonly ['items', 'totals', 'payment']
  ```

  `spaceAfter`, `spaceBefore` and `payment.showChange` are **compat-only**. They are honoured only when `compat === 'v1'`, ignored otherwise, and never stored (Tasks 2.1, 3.1).
- Produces (`render.ts`):
  - `interface RenderOptions { reprint?: boolean; maxPaperWidth?: PaperWidth; onBlockError?: (blockId: string, e: unknown) => void }`;
  - `class LockedBlockError extends Error { blockId: string; cause: unknown }`. `renderReceipt` throws it when a locked block throws. An unlocked block that throws is skipped, and `onBlockError` is called.
  - `renderReceipt(layout: ReceiptLayout, data: ReceiptData, sink: ReceiptSink, opts?: RenderOptions): void`;
  - `receiptBytes(layout: ReceiptLayout, data: ReceiptData, opts?: RenderOptions): Uint8Array`;
  - `receiptPreview(layout: ReceiptLayout, data: ReceiptData, opts?: RenderOptions): PreviewLine[]`.
  - `cols = COLS_BY_WIDTH[min(layout.paperWidth, opts.maxPaperWidth ?? layout.paperWidth)]`.
  - Non-compat: `normalizeForPrint(data: ReceiptData): ReceiptData` (`toPrinterText` on every string field) and the template text run before layout.
  - Compat: no normalisation, so the bytes stay today's.
- Produces (`standar.ts`): `standarLayout(settings: ReceiptSettings): ReceiptLayout` with `compat: 'v1'`. It emits these blocks, with the flags resolved by `resolveReceiptFlags`:
  1. `header` (`text: headerText`, large, no outlet parts, `spaceAfter: !!headerText && !!footerText`);
  2. `transaction` columns, `[orderNumber if showOrderNumber, 'date']`;
  3. `divider`;
  4. `items`;
  5. `divider`;
  6. `totals` (showSubtotal/showDiscount/showTax);
  7. `payment` (`showChange`, compat-only);
  8. `divider`;
  9. `transaction` inline, `[customerName?, customerPhone?, cashier?]`;
  10. `text` (footer, center, `spaceBefore: true`), only when `footerText` is set.
- **Rules the differential test pins:**
  - **`header` in compat:** it emits `alignCenter`, then the title (`boldOn largeOn` line `largeOff boldOff`) when non-empty, then the space, then `alignLeft`, even when the title is empty.
  - **`text`:** the space comes before its align command.
  - **Marks:** the reprint mark (`*** CETAK ULANG (REPRINT) ***`, centred and bold) prints after the leading run of `header` blocks (later also `image`) and again before `feed3 cut`.
  - **Void rows:** `replacesOrderRef` prints at the mark position, and `correctionAmount` prints in `totals` right before `TOTAL`, wherever the frozen copy puts them.
  - **Compat lines:** the header title, footer and inline rows are sent unwrapped.

- [ ] **Step 1: Write the failing tests.**
  - `Standar equals buildReceiptV1 for all 256 flag combinations × {header only, footer only, both, neither} × 8 data cases × reprint on/off`. The data cases are: a plain sale, itemised C1 with 4 discounts, pre-C1 with `discountAmount`, split tender with refs, a reward at Rp0, a bundle with pieces and `lineDiscount`, a Void replacement with a correction, and 60-character names.
  - `Standar equals buildReceiptV1 for 2,000 seeded random ReceiptData`. Use a fixed-seed generator (no new dependency). A failure prints the seed. It covers:
    - 0–12 lines, with names up to 80 chars including `·`, `é` and `☺`;
    - optional variant, reward, `pieces` and `lineDiscount`;
    - 0–5 discounts and 0–3 tenders with refs;
    - surcharge, points redeemed and signed rounding;
    - random customer and cashier;
    - random flags, header and footer.
  - `6 hex goldens are unchanged`. These protect against the frozen copy drifting too.
  - `an unlocked block that throws is skipped and reported; a throwing items block throws LockedBlockError`
  - `buildReceipt keeps its signature`. This is the type test in the existing `escpos.receipt.test.ts`.
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test -- standar`. Expected: FAIL.
- [ ] **Step 3: Implement** the layout types, Standar, the renderer for the block types above, and the delegation.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/printer test && corepack pnpm --filter @mandalika/pos test -- receipt giveaway guestSale`. Expected: PASS. The existing receipt tests in `apps/pos` act as extra guards.
- [ ] **Step 5: Commit** `git commit -m "refactor(printer): block renderer; buildReceipt prints the Standar layout byte for byte"`

### Task 1.3: Designer blocks, width invariants, sample sale, `./render` subpath

Reviewer: Opus high (shares the totals path; the width guarantee).

**Files:**
- Modify:
  - `packages/printer/src/receipt/blocks.ts`: the non-compat behaviour of `header` (outlet name, address and phone centred and wrapped; the title wrapped at `cols/2` when large), `transaction` (both styles wrapped), `points`, `text` (align, bold, large, wrapped) and `divider`.
  - `packages/printer/src/receipt/data.ts`: `ReceiptData` += `outlet?: { name: string; address?: string | null; phone?: string | null }`, `points?: { earned: number; balance: number | null }`.
  - `packages/printer/package.json`: `exports` += `"./render": "./src/receipt/index.ts"`.
- Create:
  - `packages/printer/src/receipt/validate.ts`
  - `packages/printer/src/receipt/sample.ts`
  - `packages/printer/src/receipt/index.ts`: re-exports the layout, render, standar, validate, sample, text and data types. It contains no Capacitor import.
- Test: `packages/printer/src/receipt/width.test.ts`, `packages/printer/src/receipt/blocks.test.ts`

**Interfaces:**
- Produces:
  - `NEW_TEMPLATE_BLOCKS: ReceiptBlock[]`, in the mockup's order: header (outlet parts on), transaction columns (all five fields), divider, items, divider, totals, payment (no `showChange`), divider, points, text `Terima kasih!` centred.
  - `SAMPLE_RECEIPT: ReceiptData`: the mockup sale. It has a CHAMPION bundle with three pieces and an 85.000 line discount, `2ml PI · HOLY SWEET`, QRIS 800.000, points +80/1.240, and outlet `Outlet Grand Indonesia`.
  - `RECEIPT_LIMITS`, with the values in Global Constraints.
  - `type LayoutIssue = { blockId?: string; code: string; message: string }`. The codes are the ones in the shared case file (Task 2.1): `locked_missing`, `locked_disabled`, `locked_order`, `too_many_blocks`, `too_few_blocks`, `text_too_long`, `too_many_lines`, `total_text_too_long`, `title_too_long`, `label_too_long`, `not_printable`, `name_invalid`, `unknown_type`, `compat_field`, and from Phase 4 `image_too_wide`, `image_too_tall`, `image_bytes`, `too_many_images`, `too_many_qr`, `url_invalid`.
  - `validateTemplate(input: { name: string; paperWidth: number; blocks: readonly ReceiptBlock[] }): LayoutIssue[]`. The Backoffice runs it on the body before saving.
  - **Issue order, identical in Go and TS:**
    - Template-level checks first, in this order: name, block count, locked rules (missing, disabled, order), total text, image/QR counts.
    - Then each block in list order, its fields in schema order: `type`, `text`, `label`, `url`, `image`.
    - Go returns the first issue. TS returns all issues in that order, and its `[0]` must equal Go's.
  - `compat_field` (a `spaceBefore`, `spaceAfter` or `showChange` in the body) is **TS-only**. Go decodes into `api.ReceiptBlock` with `DecodeLoose` (`backend/internal/handlers/writes.go:34-40`), which drops unknown fields before validation, so Go never sees them. The Backoffice catches them; the server never stores them.
- **Points rows (O1):** `Perkiraan poin` / `+<earned>`, and `Perkiraan saldo` / `<balance>` when it is not null. The block prints nothing when `data.points` is absent.

- [ ] **Step 1: Write the failing tests.**
  - `no printed line exceeds the width at 32 and 48`. Run `NEW_TEMPLATE_BLOCKS`, every block type and both transaction styles over a long-input matrix:
    - a 70-character product, a 60-character customer, a 64-character title;
    - 500-character text in each align, large and normal;
    - a 40-character discount label and a tender with a reference;
    - outlet address and phone;
    - `…` and a ligature (`ﬁ`) inside names and text near the line end, which normalise to longer ASCII.

    Parse the bytes, tracking `GS ! 0x11`, and assert `len × (large ? 2 : 1) ≤ cols`. Also assert `receiptPreview` agrees.
  - `points block is absent without data.points and prints both rows with it`
  - `itemised slip prints every deduction and PPN even when the totals switches are off`
  - `header prints outlet name, address and phone centred`
  - `a non-compat layout prints 'Cafe' for 'Café', normalised before layout`
  - `a new template prints Kembalian whenever change > 0 (payment has no switch)`
  - `validateTemplate reports locked_missing, locked_order and too_many_blocks`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/printer test && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(printer): designer blocks with width guarantees, sample sale, pure render entry"`

**Phase 1 done:** run `corepack pnpm quality:ci` (green), open a PR, release by `make ota-release` (bytes unchanged, so no on-device check is needed), then update HANDOFF.

---

## Phase 2: Templates storage and sync (`feat/receipt-2-templates`, migration 0095)

**Storage decision: a table, not `AppSettings`.**
- `UpdateAppSettingsBy` overwrites `receipt` wholesale (`backend/internal/write/settings.go:93-100`). A stale Backoffice tab would wipe templates.
- The settings draft, diff and conflict machinery (`useSettingsDraft.ts:73-87`) is built for scalar paths, not for block arrays.
- Assignment is per outlet, and so is the pull.
- Each template gets its own 1 MiB body limit.
- `AppSettings.receipt` keeps `copies` and `autoPrint`, and its header, footer and flags (O4: frozen).

**Standar stays virtual until first saved.**
- With no template row, the pull omits `receiptTemplate`, and the tablet prints `standarLayout(appSettings.receipt)`, which is byte-identical.
- The default is explicit. Only saving Standar from the designer sends `isDefault: true`, and the server accepts it only while no default row exists.
  - Creating another template first never changes what NULL outlets print: they keep getting no `receiptTemplate` until Standar itself is saved.
  - A saved Standar drops `compat`, so it changes the bytes for every outlet on the default. The designer says so on that first save: `Menyimpan Standar mengubah struk semua outlet yang memakai Standar.`
- No SQL or Go conversion is needed, so the only converter is the TS one that Task 1.2 golden-tests.

### Task 2.1: Migration 0095 and template validation (Go)

Reviewer: Opus high (settings contract).

**Files:**
- Create:
  - `backend/internal/db/migrations/0095_receipt_templates.sql`
  - `backend/internal/receipttpl/validate.go`
  - `backend/internal/receipttpl/validate_test.go`
  - `backend/internal/receipttpl/testdata/cases.json`: about 30 cases, each `{ name, template, valid, code? }`, at every limit boundary.
  - `packages/printer/src/receipt/validate.test.ts`
- Modify: `backend/api/openapi.yaml` (the `ReceiptBlock` schema only), plus the generated `backend/internal/api/api.gen.go` and `packages/api/src/schema.d.ts`.
- **Migration** (starts with `SET LOCAL lock_timeout = '5s';`, additive):
  - `receipt_templates`:
    - `id uuid PK DEFAULT gen_random_uuid()`
    - `name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60)`
    - `paper_width smallint NOT NULL CHECK (paper_width IN (58,80))`
    - `blocks jsonb NOT NULL`
    - `is_default boolean NOT NULL DEFAULT false`
    - `version integer NOT NULL DEFAULT 1`
    - `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`
    - `updated_by text`
  - Indexes: unique `lower(btrim(name))`; unique partial `(is_default) WHERE is_default`.
  - `ALTER TABLE outlets ADD COLUMN receipt_template_id uuid REFERENCES receipt_templates(id) ON DELETE SET NULL`. This is a backstop only; the write path refuses deleting an assigned template.

**Interfaces:**
- Produces:
  - `receipttpl.Validate(name string, paperWidth int, blocks []api.ReceiptBlock) error`. It returns `apperr.Validation` with the Indonesian message of the first issue.
  - The constants mirror `RECEIPT_LIMITS`.
  - It refuses unknown `type`s, non-printable text and any locked-block violation. It reports the first issue in the shared order (Task 1.3).
  - Compat-only fields cannot reach it: the schema lacks them and `DecodeLoose` drops them.
  - It accepts `image`/`qr` only from Phase 4. Until then they are `unknown_type`.

- [ ] **Step 1: Write the failing tests.**
  - `TestValidateCases` loops `testdata/cases.json`. The cases include:
    - empty blocks → `locked_missing`;
    - payment disabled → `locked_disabled`;
    - totals before items → `locked_order`;
    - 31 blocks;
    - 501-character text;
    - `é` in text → `not_printable`;
    - name `"  "`.
  - Go skips cases marked `"tsOnly": true` (the `compat_field` ones), because `DecodeLoose` drops those fields.
  - The TS side: `validateTemplate agrees with backend/internal/receipttpl/testdata/cases.json`, in `packages/printer/src/receipt/validate.test.ts`. It reads the same JSON through a relative path and asserts the same `valid` and first `code`.
- [ ] **Step 2: Run** `cd backend && go test ./internal/receipttpl/` and `corepack pnpm --filter @mandalika/printer test -- validate`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration and `Validate`. Add the `ReceiptBlock` schema (defined in Task 2.2's Interfaces) to `backend/api/openapi.yaml` here and run `make gen`, so `api.ReceiptBlock` exists. Task 2.2 adds the remaining schemas.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: receipt_templates table and shared template validation (migration 0095)"`

### Task 2.2: OpenAPI, repo, handlers, client; Postgres gate

Reviewer: Opus high (generated types, write path).

**Files:**
- Modify:
  - `backend/api/openapi.yaml`, near `ReceiptSettings` at `:2099`
  - generated `backend/internal/api/api.gen.go` and `packages/api/src/schema.d.ts` (`make gen`)
  - `packages/api/src/client.ts`: type aliases near `:24`, and methods next to `getAppSettings` `:1244`
  - `backend/internal/server/server.go`: the `manage_settings` group `:371-381`
  - the four CI files (Global Constraints)
- Create:
  - `backend/internal/write/receipt_templates.go`
  - `backend/internal/read/receipt_templates.go`
  - `backend/internal/handlers/receipt_templates.go`
  - `backend/internal/handlers/receipt_templates_integration_test.go`

**Interfaces:**
- **OpenAPI schemas:**
  - **`ReceiptBlock`:**
    - `required: [id, type, enabled]`;
    - `type` enum `[header, transaction, items, totals, payment, points, text, divider]`;
    - optional fields `label`, `text`, `size [normal, large]`, `align [left, center, right]`, `bold`, `showOutletName`, `showOutletAddress`, `showOutletPhone`, `fields` (array of enum `TxField`), `style [columns, inline]`, `showSubtotal`, `showDiscount`, `showTax`. There is no `showChange` (deviation 10).
  - **`ReceiptTemplate`:** `required [id, name, paperWidth, blocks, isDefault, version, outletIds, updatedAt]`, with `paperWidth` enum `[58, 80]`.
  - **`ReceiptTemplateInput`:** `required [name, paperWidth, blocks]`, plus `version` (required on update) and `isDefault` (read on create only; **ignored on update**).
  - **`ReceiptTemplateListResponse`** and **`ReceiptTemplateResponse`**.
  - **`ReceiptTemplateAssignInput`:** `required [outletIds]`, with `outletIds: uuid[]` and an optional `templateId: uuid`. An absent `templateId` means the default, including a still-virtual Standar.
  - **`SyncReceiptTemplate`:** `required [id, version, paperWidth, blocks]`.
- **Routes** (all `manage_settings`):
  - `GET /api/v1/receipt-templates`
  - `POST /api/v1/receipt-templates`
  - `PUT /api/v1/receipt-templates/{id}`
  - `DELETE /api/v1/receipt-templates/{id}`
  - `PUT /api/v1/receipt-templates/assign`
- **Write** (`write.Repo`, with `type ReceiptTemplateIn struct { Name string; PaperWidth int; Blocks []api.ReceiptBlock; IsDefault bool }`, validated by `receipttpl.Validate` first):
  - `CreateReceiptTemplate(ctx, actor string, in ReceiptTemplateIn) (string, error)`. `IsDefault` while a default already exists → 409.
  - `UpdateReceiptTemplate(ctx, actor, id string, in ReceiptTemplateIn, version int) error`. It never reads `in.IsDefault`, and no action in this plan moves the default. A stale version gives a 409 with the stale-save copy, and the version is bumped.
  - `DeleteReceiptTemplate(ctx, id string) error`. Default → 409. Assigned → 409 with the outlet count.
  - `AssignReceiptTemplate(ctx, templateID *string, outletIDs []string) error`.
    - With an id: the listed outlets move to it, and outlets that were on it but are not listed go to NULL.
    - With nil, or the default's own id: the listed outlets go to NULL. Other outlets are untouched.
  - Every write calls `bumpVersionOutlets` (`write/repo.go:41`) for the outlets whose resolved template changed, or all outlets for a default edit.
  - Blocks are stored as `json.Marshal` of the typed slice, so unknown fields are dropped.
- **Read** (`read.Repo`):
  - `ReceiptTemplates(ctx) ([]api.ReceiptTemplate, error)`. `outletIds` holds the outlets resolving to each template, NULLs included for the default.
  - `ReceiptTemplateForOutlet(ctx context.Context, q RowQuerier, outletID string) (*api.SyncReceiptTemplate, error)` returns the assigned template, else the default, else `nil`.
- **TS client:**
  - `listReceiptTemplates(): Promise<ReceiptTemplate[]>`
  - `createReceiptTemplate(input: ReceiptTemplateInput): Promise<ReceiptTemplate>`
  - `updateReceiptTemplate(id: string, input: ReceiptTemplateInput): Promise<ReceiptTemplate>`
  - `deleteReceiptTemplate(id: string): Promise<void>`
  - `assignReceiptTemplate(input: ReceiptTemplateAssignInput): Promise<void>`

- [ ] **Step 1: Write the failing Postgres gate** `TestReceiptTemplatesPostgres` (seeded like `TestBundlesPostgres`: 3 outlets and an admin), with these subtests:
  - `second_template_while_standar_virtual_leaves_null_outlets_and_pull_unchanged`
  - `create_isDefault_refused_when_default_exists`
  - `assign_without_templateId_moves_outlets_back_to_default`
  - `create_refuses_locked_removed` (422)
  - `update_stale_version_409`
  - `delete_default_409`
  - `delete_assigned_409`
  - `assign_moves_outlets_and_bumps_their_version_only`
  - `list_outletIds_include_default_nulls`
  - `fk_set_null_backstop`: a raw `DELETE` leaves `outlets.receipt_template_id` NULL.
- [ ] **Step 2: Run** `python scripts/ci/postgres_gate.py --runtime native --pg-bin <pg18/bin> --no-race --only RT --output <new dir>`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, `make gen`, repo, handlers, routes, client and the CI range.
- [ ] **Step 4: Run** the gate (PASS), `cd backend && make gen-check && go test ./...`, and `corepack pnpm gen:check && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: receipt template CRUD and outlet assignment"`

### Task 2.3: Pull ships the outlet's template, address and phone

Reviewer: Opus high (sync pull).

**Files:**
- Modify:
  - `backend/internal/sync/pull.go`: `PullBundle` gains:

    ```go
    ReceiptTemplate *api.SyncReceiptTemplate `json:"receiptTemplate,omitempty"`
    OutletAddress   string                   `json:"outletAddress,omitempty"`
    OutletPhone     string                   `json:"outletPhone,omitempty"`
    ```

    The `:104` select adds `address, phone`. A template read error fails the pull, like the giveaway at `:115`.
  - `backend/api/openapi.yaml`: `SyncPullBundle` (`:2534`) gains `receiptTemplate: $ref SyncReceiptTemplate`, plus `outletAddress` and `outletPhone` as strings. All three are optional and not nullable.
  - the generated files
  - `backend/internal/handlers/receipt_templates_integration_test.go`: new subtests
- Test: `packages/sync/src/snapshot.receiptTemplate.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - Gate subtests:
    - `pull_carries_assigned_template`
    - `pull_falls_back_to_default`
    - `pull_omits_receiptTemplate_without_rows`
    - `pull_succeeds_when_the_assigned_row_is_gone`: it falls back to the default, or omits the template when there is none.
    - `pull_carries_outlet_address_phone`
  - `snapshot keeps receiptTemplate across a reload and a failed pull leaves it unchanged`
- [ ] **Step 2: Run** the RT gate and `corepack pnpm --filter @mandalika/sync test -- receiptTemplate`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, plus `make gen-check` and `corepack pnpm gen:check`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(sync): pull ships the outlet's receipt template, address and phone"`

### Task 2.4: POS prints the resolved layout

Reviewer: Opus high (print path, snapshot, fallback).

**Files:**
- Create:
  - `packages/printer/src/receipt/fromApi.ts`, exported from `./render`
  - `apps/pos/src/receiptLayout.ts`
- Modify:
  - `packages/printer/src/print.ts`: `PrintJob` gains `layout?: ReceiptLayout`, `maxPaperWidth?: PaperWidth` and `onLayoutError?: (e: unknown) => void`.
    - `buildPayload` renders the layout and passes `onBlockError` through to `onLayoutError`.
    - On any throw (a `LockedBlockError` or anything else), it reports and prints `buildReceiptV1(data, settings, reprint)`, never the renderer again.
  - `apps/pos/src/printer.tsx`: `print(data, settings, reprint?, layout?)` and `testPrint(settings, layout?)`.
  - `apps/pos/src/cashier/CashierScreen.tsx` (lines on bundles P3): the sale print (about `:985-1007`), `handleReprint` (`:1011`/`:1020`), `reprintLocal` (`:1030`) and `reprintOrder` (`:1060`) pass `receiptLayout`.
    - The sale's `lastReceipt.current` carries `outlet` and `points`, so a `handleReprint` retry of that sale prints them too.
    - `handleReprint`'s fallback to `newestReprintable` (after a restart) and the other two reprints carry `outlet` only.
  - `apps/pos/src/cashier/receiptQuote.ts`: the `extras` Pick (`:166` on bundles P3) adds `'outlet' | 'points'`.
  - `apps/pos/src/cashier/localReceipts.ts:102`: `reprintReceiptData` takes an optional `outlet`.
  - `apps/pos/src/screens/SettingsScreen.tsx:134`
- Test: `packages/printer/src/receipt/fromApi.test.ts`, `packages/printer/src/print.test.ts`, `apps/pos/src/receiptLayout.test.ts`

**Interfaces:**
- **`layoutFromApi(t: unknown): ReceiptLayout | null`** is tolerant:
  - It drops blocks of unknown `type` (a newer Backoffice) and blocks with ill-typed fields.
  - It returns `null` when `paperWidth` is unknown or any locked-block rule fails.
  - It never returns `compat`.
- **`resolveReceiptLayout(template: SyncPullBundle['receiptTemplate'], receipt: ReceiptSettings): ReceiptLayout`** returns `layoutFromApi(template) ?? standarLayout(receipt)`. CashierScreen calls it with `snapshot.receiptTemplate` and `settings.receipt` (`:336`, which already falls back to `DEFAULT_SETTINGS`) inside a `useMemo`.
- **`DEVICE_PAPER_WIDTH_DEFAULT: PaperWidth = 58`.** `apps/pos/src/printer.tsx` passes it as `maxPaperWidth` on every receipt job, so callers never pass it. Phase 4 makes it a device setting.
- **Live sale extras:**
  - `outlet: { name: snapshot.outletName ?? '', address: snapshot.outletAddress ?? null, phone: snapshot.outletPhone ?? null }`.
  - `points` only when loyalty is on and a customer is attached: `{ earned: derived.earnedPoints, balance: customer.points - derived.redeemedPoints + derived.earnedPoints }`.
  - A retry of the live sale (`handleReprint` with `lastReceipt.current`) is still the live sale, so it keeps `points`. A reprint from history or the local receipt list passes `outlet` only.
- **`onLayoutError`** calls `reportErrors([{ source: 'print', kind: 'receipt_template', … }])`.

- [ ] **Step 1: Write the failing tests.**
  - `layoutFromApi returns null when payment is missing, and the tablet prints Standar`
  - `layoutFromApi drops an unknown block type and keeps the rest`
  - `renders a 48-column template at 32 columns when the device width is 58`
  - `SyncPullBundle without receiptTemplate still prints Standar` (bytes equal `buildReceipt`)
  - `printReceipt prints buildReceiptV1 bytes and calls onLayoutError when the items block throws`
  - `printReceipt skips a throwing text block, reports it, and still prints items, totals and payment`
  - `printReceipt with a layout keeps copies, runExclusive and Gagal copy` (extends `print.test.ts`)
  - `live sale and its handleReprint retry pass outlet and points; a reprint from history or a local receipt passes outlet only`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test && corepack pnpm --filter @mandalika/pos test -- receiptLayout print`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm quality:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): print the outlet's receipt template, Standar when none"`

**Phase 2 done:** release the backend first, then `make ota-release`. Smoke: `GET /receipt-templates` answers 401 without sign-in, and a signed-in pull carries `outletAddress`. Update HANDOFF.

---

## Phase 3: Backoffice designer (`feat/receipt-3-designer`)

### Task 3.1: Designer state (pure)

Reviewer: Sonnet medium (the server and the tablet both enforce the locked rules).

**Files:**
- Create: `apps/backoffice/src/screens/settings/struk/designerReducer.ts`, with its test.
- Modify:
  - `apps/backoffice/package.json`: add `@mandalika/printer` and `@dnd-kit/*` (Global Constraints)
  - `pnpm-lock.yaml`

**Interfaces:**
- `interface DesignerState { templateId: string | null; name: string; isDefault: boolean; version: number | null; layout: ReceiptLayout; dirty: boolean; editingId: string | null }`
- `type DesignerAction`:
  - `{ type: 'load'; template: ReceiptTemplate }`
  - `{ type: 'loadVirtualStandar'; settings: ReceiptSettings }`
  - `{ type: 'newTemplate'; name: string; paperWidth: PaperWidth }`
  - `{ type: 'duplicate'; name: string }`
  - `{ type: 'toggle'; id: string }`
  - `{ type: 'move'; from: number; to: number }`
  - `{ type: 'edit'; id: string; patch: Partial<ReceiptBlock> }`
  - `{ type: 'add'; block: 'text' | 'divider' | 'points' | 'transaction' | 'header' }`
  - `{ type: 'remove'; id: string }`
  - `{ type: 'setWidth'; paperWidth: PaperWidth }`
  - `{ type: 'rename'; name: string }`
- `designerReducer(state: DesignerState, action: DesignerAction): DesignerState`
- `fromCompat(layout: ReceiptLayout): { layout: ReceiptLayout; adjustments: CompatAdjustment[] }`:
  - it drops `compat`, `spaceAfter`, `spaceBefore` and `payment.showChange`;
  - it normalises the header title and footer text with `toPrinterText`;
  - it clips them to `RECEIPT_LIMITS`: the title to 64 chars, the footer to 500 chars and 12 lines.

  This matters because today `headerText`/`footerText` have no limits (`backend/internal/write/settings.go:209-224` validates only `copies`), so without it the first save could be refused with a 422.
- `type CompatAdjustment = { blockId: string; kind: 'replaced_chars' | 'clipped_chars' | 'clipped_lines' | 'change_locked'; before: string; after: string }`. `DesignerState` gains `adjustments: CompatAdjustment[]`.
- `loadVirtualStandar` gives `standarLayout(settings)` **with `compat` kept**, plus `templateId: null`, name `Standar` and `isDefault: true`. The unedited preview then equals what tablets print.
  - The first mutating action (toggle, move, edit, add, remove, setWidth) applies `fromCompat` before it changes anything, and stores its `adjustments`.
  - `toBody` applies it too when the unedited Standar is saved.
- Every `edit` of `text` passes through `toPrinterText`.
- `toBody(state): ReceiptTemplateInput`:
  - it always strips compat;
  - it sends `isDefault: true` only when `templateId === null && isDefault`;
  - it sends `version` when `templateId` is set.

- [ ] **Step 1: Write the failing tests.**
  - `toggle and remove are refused for items, totals and payment`
  - `move that puts totals above items is refused`
  - `move of a text block between totals and payment is allowed`
  - `edit of text stores 'Cafe' for 'Café'`
  - `unedited virtual Standar previews exactly what buildReceipt prints`
  - `the first edit drops compat; toBody never sends compat, spaceAfter, spaceBefore or showChange`
  - `fromCompat normalises é and clips a 700-char, 20-line footer to 500 chars and 12 lines, reporting both adjustments`
  - `toBody sends isDefault only for the unsaved Standar`
  - `duplicate gives templateId null, isDefault false and a new name`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- designerReducer`. Expected: FAIL.
- [ ] **Step 3: Implement**, then run `corepack pnpm install --lockfile-only`.
- [ ] **Step 4: Run** the same command and `corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(backoffice): receipt designer state"`, including `pnpm-lock.yaml`.

### Task 3.2: Designer screen (Pengaturan › Struk)

Reviewer: Sonnet medium. Haiku low does a copy pass.

**Files:**
- Create in `apps/backoffice/src/screens/settings/struk/`:
  - `StrukSection.tsx`: the page. Left: the block list and editor. Right: the paper preview with the buttons.
  - `BlockList.tsx`: `@dnd-kit/sortable` with `KeyboardSensor`. Each row has a grip, a name, a hint, a switch or a lock badge, and a delete button for blocks that are neither locked nor default.
  - `BlockEditor.tsx`: the per-type form, opened under the selected row as in the mockup.
  - `ReceiptPaper.tsx`: draws `receiptPreview(layout, SAMPLE_RECEIPT)` as monospace lines, `cols` characters wide. Large lines use double font size.
  - `TemplateBar.tsx`: the template select, `Template baru` (from `NEW_TEMPLATE_BLOCKS`), `Duplikat`, `Ganti nama`, `Hapus`, the `Kertas` toggle and `Dipakai di N outlet`.
  - `AssignOutletsDialog.tsx`: outlet checkboxes from `api.listOutlets`.
    - Saving calls `assignReceiptTemplate({ templateId, outletIds: checked })`, with no `templateId` for Standar.
    - Unchecking an outlet sends it back to Standar.
    - For a virtual Standar, `outletIds` shown = the outlets not assigned to any listed template.
  - `useReceiptTemplates.ts`: load, then save (create or update with `version`), delete and assign. On a 409 it shows the server copy and keeps the draft.
- Modify:
  - `apps/backoffice/src/lib/router/routes.ts:114-119`: `tab('struk', 'struk', 'Struk')`
  - `apps/backoffice/src/screens/settings/settingsDiff.ts:12`: `TabId` += `'struk'`
  - `apps/backoffice/src/screens/SettingsScreen.tsx:90-250`: render `StrukSection`. The designer has its own leave guard (`useUnsavedChanges`) and does not use the settings save bar.
  - `apps/backoffice/src/screens/settings/TransaksiSection.tsx:165-212`: the card keeps only `Jumlah Salinan` and `Cetak struk otomatis`, plus the line `Desain struk ada di Pengaturan › Struk`.
  - `apps/backoffice/src/screens/settings/receiptFlags.test.tsx`: the switches move to the designer. Move these assertions to the `transaction`/`totals`/`payment` editors.
- Test: `apps/backoffice/src/screens/settings/struk/StrukSection.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `with no templates the designer shows Standar built from receipt settings, and Simpan creates it`
  - `locked rows show the lock badge and no switch`
  - `switching Kertas to 80mm widens the preview to 48 columns`
  - `a 409 on save shows the stale-save copy and keeps the edits`
  - `Hapus on Standar is disabled`
  - `typed text with é shows the replaced character hint`
  - `saving Standar from settings with headerText 'Café' and a 700-char footer succeeds and lists what changed`. It asserts:
    - the notice `Disesuaikan agar bisa dicetak:` lists the replaced `é` and the clipped footer;
    - the POST body passes `validateTemplate` with no issues.
  - `the payment row has no Kembalian switch`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- Struk receiptFlags`. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow "Kertas & Emas" tokens. The QR and image preview arrive in Phase 4.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/backoffice test && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(backoffice): receipt designer in Pengaturan › Struk"`

### Task 3.3: Browser scenario and mockup comparison

Reviewer: Sonnet medium.

**Files:**
- Create: `tests/browser/backoffice-receipt-scenarios.ts`, using synthetic routes at `127.0.0.1:59999` the way `backoffice-settings-scenarios.ts` does.
- Modify:
  - `tests/browser/accepted.spec.ts`: add `test('BO-RECEIPT-DESIGNER …')`
  - `tests/browser/required-scenarios.json`: register `BO-RECEIPT-DESIGNER`

- [ ] **Step 1: Write the scenario.** It covers: open `#/pengaturan/struk`, reorder `Poin member` above `Daftar barang`, toggle a text block, switch to 80mm, Simpan (assert the POST body has no `compat`), assign 2 outlets, and the reload shows `Dipakai di 2 outlet`. Capture screenshots at 1024 and 1440 widths.
- [ ] **Step 2: Run** `corepack pnpm browser:ci`. Expected: FAIL first, then PASS after the wiring.
- [ ] **Step 3: Compare the mockup.** Render `docs/plans/2026-11-12-receipt-designer-mockup.html` and the screenshot side by side, and list each difference in the PR. This follows the design-fidelity rule.
- [ ] **Step 4: Run** `corepack pnpm quality:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "test(browser): receipt designer scenario"`

**Phase 3 done:** a Backoffice release, which needs the Phase 2 backend live. Then update HANDOFF.

---

## Phase 4: Logo, QR and test print (`feat/receipt-4-logo-qr`, migration 0096)

**Release gate:** Task 4.5 must pass on the owner's RPP02N before this phase ships.

### Task 4.1: Raster and QR in the renderer

Reviewer: Opus high (payload size; printed output).

**Files:**
- Create:
  - `packages/printer/src/receipt/raster.ts`
  - `packages/printer/src/receipt/qr.ts`
- Modify:
  - `layout.ts`: the `ReceiptBlock` union += `{ type: 'image'; enabled; label?; image: ReceiptRaster; align: Align }` and `{ type: 'qr'; enabled; label?; url: string; align: Align }`.
  - `sink.ts`: `ReceiptSink` += `image(r: ReceiptRaster): void` and `qr(data: string, moduleSize: number): void`. `PreviewLine` += `{ kind: 'image'; raster: ReceiptRaster; align }` and `{ kind: 'qr'; data: string; align }`.
  - `render.ts`: `RenderOptions` += `graphics?: boolean` (default `true`). The leading run that the reprint mark follows now includes `image`.
  - `validate.ts`
- Test: `raster.test.ts`, `qr.test.ts`, `graphics.test.ts`

**Interfaces:**
- **`ReceiptRaster`:** `{ width: number; height: number; data: string }`. `data` is base64 of `width/8 × height` bytes, rows MSB-first, 1 = black.
- **`ditherToRaster(rgba: Uint8ClampedArray, width: number, height: number): ReceiptRaster`:**
  - alpha is composited over white;
  - luminance is `0.299R + 0.587G + 0.114B`;
  - Floyd–Steinberg, threshold 128;
  - `width` must be a multiple of 8, and the caller pads with white.
- **ESC/POS image:** `GS v 0` with `m = 0`, `xL xH = width/8`, `yL yH = band height`, in bands of at most 64 rows.
- **ESC/POS QR** (model 2, ECC M), these exact bytes:
  - `1D 28 6B 04 00 31 41 32 00`
  - `1D 28 6B 03 00 31 43 <n>`
  - `1D 28 6B 03 00 31 45 31`
  - `1D 28 6B <pL> <pH> 31 50 30 <data>`, where `pL + 256·pH = len + 3`
  - `1D 28 6B 03 00 31 51 30`
- **Module size:** 6 for ≤ 50 chars, 5 for ≤ 120, 4 for ≤ 300.
- **Fallbacks, all of which never throw:**
  - `graphics: false`: an image prints nothing, and a QR prints its URL as wrapped, aligned text.
  - A raster whose data length is wrong: the block is skipped.
  - A URL over 300 chars: it prints as text.

- [ ] **Step 1: Write the failing tests.**
  - `ditherToRaster of a 16×2 half-black image packs 0xFF00 rows`
  - `image block emits GS v 0 bands of ≤ 64 rows with the right xL/yL`
  - `qr block emits the five GS ( k commands with pL/pH for a 300-char url`
  - `graphics off: no GS v 0 or GS ( k bytes; the QR url prints as text within the width`
  - `a raster with a short data string is skipped, the rest prints`
  - `width test still holds with image and qr blocks at 32 and 48`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(printer): raster logo and QR blocks with text fallback"`

### Task 4.2: Server: image and QR fields; test-print relay (migration 0096)

Reviewer: Opus high (generated types, a new sync endpoint).

**Files:**
- Create:
  - `backend/internal/db/migrations/0096_receipt_test_prints.sql`: `receipt_test_prints (outlet_id uuid PK REFERENCES outlets(id) ON DELETE CASCADE, paper_width smallint NOT NULL, blocks jsonb NOT NULL, created_by text, created_at timestamptz NOT NULL DEFAULT now())`.
- Modify:
  - `backend/api/openapi.yaml`:
    - `ReceiptBlock.type` += `image`, `qr`;
    - new optional fields `image: $ref ReceiptRaster` and `url`;
    - new `ReceiptRaster`, `ReceiptTestPrintInput { outletId, paperWidth, blocks }` and `ReceiptTestPrintResponse { data: SyncReceiptTemplate }`.
  - `backend/internal/receipttpl/validate.go` and `testdata/cases.json`: the raster and QR limits. A raster must decode to exactly `width/8 × height` bytes.
  - `backend/internal/handlers/receipt_templates.go`:
    - `POST /api/v1/receipt-templates/test-print` (`manage_settings`) validates the draft and upserts by outlet;
    - `GET /api/v1/sync/receipt-test-print`, next to `/sync/receive-approvers` (`server.go:220`), reads the outlet from scope. It returns rows newer than 60 minutes; otherwise it answers 404 `not_found`.
  - `packages/api/src/client.ts`: `sendReceiptTestPrint(input)` and `getReceiptTestPrint(): Promise<SyncReceiptTemplate | null>` (404 → null).
  - the generated files and the gate test file

- [ ] **Step 1: Write the failing tests.**
  - `TestValidateCases` gains:
    - a raster 392 wide → `image_too_wide`;
    - height 241;
    - data one byte short;
    - three image blocks;
    - a 301-char URL;
    - `ftp://`.
  - Gate subtests:
    - `test_print_round_trip_for_outlet`
    - `test_print_expires_after_60_min`
    - `test_print_other_outlet_404`
- [ ] **Step 2: Run** `cd backend && go test ./internal/receipttpl/`, the RT gate (`python scripts/ci/postgres_gate.py --runtime native --pg-bin <pg18/bin> --no-race --only RT --output <new dir>`), `cd backend && make gen-check` and `corepack pnpm gen:check`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, schema, `make gen`, validation, handlers, routes and client.
- [ ] **Step 4: Run** `cd backend && go test ./internal/receipttpl/`, the RT gate (`python scripts/ci/postgres_gate.py --runtime native --pg-bin <pg18/bin> --no-race --only RT --output <new dir>`), `cd backend && make gen-check` and `corepack pnpm gen:check`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: logo and QR template fields, test-print relay (migration 0096)"`

### Task 4.3: Backoffice: logo upload, QR editor, "Cetak tes di tablet"

Reviewer: Sonnet medium.

**Files:**
- Create:
  - `apps/backoffice/src/screens/settings/struk/imageToRaster.ts`
  - `apps/backoffice/src/screens/settings/struk/TestPrintDialog.tsx`
- Modify: `BlockEditor.tsx` (image and QR forms), `ReceiptPaper.tsx` (the raster drawn on a canvas, and a QR placeholder box with the URL; no QR library), `designerReducer.ts` (`add` of `'image' | 'qr'`).

**Interfaces:**
- **`fileToRaster(file: File): Promise<ReceiptRaster>`:**
  - It refuses a type other than png, jpeg or webp, and files over 2 MB, with `Gambar maks. 2 MB (PNG, JPG, WebP)`.
  - It decodes with `createImageBitmap` and scales to fit 384×240 while keeping the aspect ratio.
  - It pads the width up to a multiple of 8 with white, then calls `ditherToRaster`.
- **`urlToRaster(url: string)`** fetches with `mode: 'cors'`. If that fails, it shows `Logo tidak bisa diambil; unggah file gambarnya.`
- **`TestPrintDialog`** has an outlet select and posts the draft. It confirms with `Terkirim. Di tablet outlet <nama>, buka Pengaturan › Printer lalu ketuk Tes Cetak (berlaku 60 menit).`

- [ ] **Step 1: Write the failing tests.**
  - `fileToRaster refuses a 3 MB png`
  - `a 1000×1000 image becomes 240×240`
  - `a 390-wide image becomes ≤ 384 and a multiple of 8`
  - `QR editor counts to 300 and blocks Simpan above it`
  - `Cetak tes posts the unsaved draft for the chosen outlet`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- imageToRaster BlockEditor TestPrint && corepack pnpm typecheck:ci`. Expected: FAIL.
- [ ] **Step 3: Implement** `imageToRaster.ts`, the editors, the preview and `TestPrintDialog.tsx`.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/backoffice test -- imageToRaster BlockEditor TestPrint && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(backoffice): logo and QR blocks, test print to a tablet"`

### Task 4.4: POS: device paper width, graphics switch, test print, drain budget

Reviewer: Opus high (transport drain; print path).

**Files:**
- Modify:
  - `apps/pos/src/receiptLayout.ts`: `devicePaperWidth()` and `deviceGraphics()` are read from KV keys `mandalika.pos.printerPaperWidth` (`'58' | '80'`, default 58) and `mandalika.pos.printerGraphics` (`'on' | 'off'`, default `'on'`).
  - `apps/pos/src/screens/SettingsScreen.tsx`: under the printer card, `Lebar kertas` 58mm/80mm and the `Cetak logo & QR` switch. `handleTestPrint` (`:130`) first tries `api.getReceiptTestPrint()` when online.
    - A draft prints `SAMPLE_RECEIPT` with a `CETAK TES` title line.
    - Otherwise it prints the resolved layout with the sample.
    - **Relay precedence:** a relay draft is used only by this explicit Tes Cetak tap. It is held in memory for that one print, never written to the snapshot, and never used for a sale. Sales always print the template from the pull, so a newer saved template always wins.
  - `packages/printer/src/print.ts`: `PrintJob` gains `graphics?: boolean`, passed to `RenderOptions.graphics`.
  - `apps/pos/src/printer.tsx`:
    - every receipt job reads `devicePaperWidth()` and `deviceGraphics()` and passes them as `maxPaperWidth` and `graphics`, replacing the Phase 2 constant;
    - `testPrint(settings, layout?)` prints `SAMPLE_RECEIPT`.
  - `packages/printer/src/linkChoice.ts:20-28`: the drain budget.
- Create: `packages/printer/src/receipt/worstCase.ts` (test helper, not exported).
- Test: `packages/printer/src/linkChoice.test.ts`, `apps/pos/src/receiptLayout.test.ts`, `apps/pos/src/screens/SettingsScreen.test.tsx`

**Interfaces:**
- **Drain:**
  - `worstCaseLayout(): ReceiptLayout` (test helper in `packages/printer/src/receipt/worstCase.ts`) is built from `RECEIPT_LIMITS`:
    - 30 blocks, including 2 images at the raster cap and 2 QR codes of 300 chars;
    - text blocks summing to the 1,500-char cap;
    - all five transaction fields.

    `WORST_CASE_SALE` has 60 lines with 70-char names, 6 discounts and 3 tenders with references.
  - `MAX_RECEIPT_PAYLOAD_BYTES` (exported from `linkChoice.ts`) is that payload's measured length rounded up to the next 1,000. The test pins it.
  - **Keep a cap.**
    - `DRAIN_MAX_MS` and `DRAIN_BYTES_PER_MS` take the numbers measured in Task 4.5: the real SPP drain rate on the RPP02N, and the time 5 copies of the worst case need.
    - They are not the paper formula `300 + 5×MAX/8`, which is about 13 s at 20KB.
    - Until 4.5 runs, leave them at today's values (`linkChoice.ts:20-22`).
  - **Queue cost:** native `doDisconnect` sleeps `drainMs` before it closes (`apps/pos/android/app/src/main/java/com/mandalika/pos/ClassicPrinterPlugin.java:350`). Because `sendJob` awaits `disconnect()` inside `runExclusive` (`print.ts`), the drain blocks the next print for its full length. The cap is therefore also the worst wait before the next sale prints.

- [ ] **Step 1: Write the failing tests.**
  - `drainDelayMs never exceeds DRAIN_MAX_MS and covers 5 × MAX_RECEIPT_PAYLOAD_BYTES at the measured rate`
  - `runExclusive frees the queue within DRAIN_MAX_MS + 1 s after the last write`. Use a fake transport whose `disconnect` waits `drainDelayMs(bytes)`, with fake timers, so a second job starts by then.
  - `receiptBytes(worstCaseLayout(), WORST_CASE_SALE) ≤ MAX_RECEIPT_PAYLOAD_BYTES`
  - `graphics off prints the QR url as text on the sale`
  - `Tes Cetak prints a pending Backoffice draft, else the outlet's template`
  - `a sale after a Tes Cetak with a relay draft prints the pulled template, not the draft`
  - `Lebar kertas 80 lets a 48-column template print at 48`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test -- linkChoice worstCase && corepack pnpm --filter @mandalika/pos test -- receiptLayout SettingsScreen`. Expected: FAIL.
- [ ] **Step 3: Implement** the device settings, test print, `worstCase.ts` and the derived drain constants.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/printer test -- linkChoice worstCase && corepack pnpm --filter @mandalika/pos test -- receiptLayout SettingsScreen`. Expected: PASS.
- [ ] **Step 4b: Run** `corepack pnpm quality:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): paper width and graphics settings, Backoffice test print, drain budget for logos"`

### Task 4.5: On-device check on the RPP02N (manual; release gate)

Owner: the owner and a Sonnet session over adb (`tablet-checks-via-adb`). It is read-only and uses no credentials.

- [ ] **Step 1:** On the test tablet (APK 2.3), install the Phase 4 OTA bundle from a local build. Do not publish it to the fleet.
- [ ] **Step 2:** Send a draft from the Backoffice with a 384×240 logo, a 300-character QR URL and every block type. Print it with "Tes Cetak" and with a real sale at copies = 5.
- [ ] **Step 3: Record**, with a photo:
  - Does the logo print without garbage?
  - Does the QR scan on a phone?
  - Does copy 5 end in full, after the cut?
  - Does `Cetak logo & QR` off print the text fallback?
  - Does the 58mm clamp print an 80mm template cleanly?
  - The time to the first byte and the total print time.
- [ ] **Step 4: If anything fails:**
  - Garbage logo: try bands of 24 rows.
  - QR unsupported: default `printerGraphics` to `'off'`.
  - A tail cut off, or a wait that is too long: set `DRAIN_BYTES_PER_MS` and `DRAIN_MAX_MS` from the measurement in Task 4.4's constants.
  - Re-run the step.
- [ ] **Step 5:** Write the result into HANDOFF and the PR. Release order: backend, Backoffice, then `make ota-release`.

---

## Phase 5: Refund and Void slips framed by the template (`feat/receipt-5-stamps`)

Depends on Void Phase 3 (`buildVoidSlip`, `VoidSlipData`, `printVoidSlip`).

### Task 5.1: Stamped slips in the renderer

Reviewer: Opus high (refund amounts printed).

**Files:**
- Create: `packages/printer/src/receipt/slips.ts`
- Modify: `packages/printer/src/index.ts` and `./render`, to export the new functions. Void's `buildVoidSlip` stays in `escpos.ts`, unused by the POS after Task 5.2.
- Test: `packages/printer/src/receipt/slips.test.ts`

**Interfaces:**
- **`type SlipStamp = 'REFUND' | 'DIBATALKAN'`.**
- **`RefundSlipData`:** `{ orderRef: string; dateTime: Date; lines: { name: string; variant?: string; qty: number; amount: number }[]; total: number; payoutLabel: string; reasonLabel?: string; cashierName: string }`.
- **`voidSlipBytes(layout: ReceiptLayout, data: VoidSlipData, opts?: RenderOptions): Uint8Array`:**
  - The layout is always present: `resolveReceiptLayout` never returns null.
  - An outlet with no template therefore gets Standar's header block around the void slip. This is intended: the slip carries the same title as the outlet's receipts.
  - It prints:
    1. the layout's leading `image`/`header` blocks;
    2. a divider;
    3. the stamp, centred, bold and large;
    4. a divider;
    5. Void's body lines, in the same text and order as `buildVoidSlip` (void plan copy table);
    6. `feed3 cut`.
- **`refundSlipBytes(layout: ReceiptLayout, data: RefundSlipData, opts?: RenderOptions): Uint8Array`:**
  - It prints the same frame with `REFUND`, then:
    - `No: #<orderRef>`;
    - `Tgl`;
    - each line as `<qty> x <name>`, with the amount right-aligned;
    - a divider;
    - bold `TOTAL REFUND`;
    - `Dikembalikan lewat <payoutLabel>`;
    - `Alasan: <reason>`;
    - `Kasir: <name>`.
  - Lines are wrapped within `cols`.

- [ ] **Step 1: Write the failing tests.**
  - `void slip with Standar's layout prints the header text, DIBATALKAN, then Void's body lines in buildVoidSlip's order`
  - `void slip with a template prints the logo/header blocks, then DIBATALKAN, then the body`
  - `refund slip lines add up to TOTAL REFUND and fit 32 and 48 columns`
  - `stamp line is centred, bold, large`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test -- slips`. Expected: FAIL.
- [ ] **Step 3: Implement** `slips.ts` and the exports.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/printer test -- slips`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(printer): REFUND and DIBATALKAN slips framed by the receipt template"`

### Task 5.2: POS prints them

Reviewer: Opus high (refund flow, print path).

**Files:**
- Modify:
  - `apps/pos/src/printer.tsx`: `printVoidSlip(data, settings, layout)` (the signature changes from Void's `printVoidSlip(data)`; update every caller) and a new `printRefundSlip(data, settings, layout)`.
    - Both run through `sendJob` with 1 copy.
    - `layout` comes from `resolveReceiptLayout`.
  - `apps/pos/src/cashier/CashierScreen.tsx`. After the refund's `engine.enqueue('refund', …)` succeeds (`:1130` on bundles P3) and a printer is paired, it prints the refund slip. The data is built from the refunded order, the dialog selection, `refundAmountFor` and the payout label. A failure shows a toast and calls `reportErrors` (`kind: 'refund_slip'`), and never undoes the refund. The void path passes `receiptLayout`.
- Create: `apps/pos/src/cashier/refundSlipData.ts`, `buildRefundSlipData(order: Order, input: RefundConfirmInput, methods: PayoutMethodCfg[]): RefundSlipData`.
- Test: `apps/pos/src/cashier/refundSlipData.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `buildRefundSlipData of a 2-line partial refund lists only the selected lines and the refund amount`
  - `split order uses the chosen payout label`
  - `a print failure after a refund keeps the refund queued and reports refund_slip`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/pos test -- refundSlip`. Expected: FAIL.
- [ ] **Step 3: Implement** `refundSlipData.ts` and the two print paths.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/pos test -- refundSlip`. Expected: PASS.
- [ ] **Step 4b: Run** `corepack pnpm quality:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): print REFUND and DIBATALKAN slips with the outlet template"`

**Phase 5 done:** `make ota-release`, then an on-tablet print of one refund slip and one void slip. Update HANDOFF.

---

## Known gap (follow-up, not a task)

- **The on-screen receipt will no longer match the paper.** `apps/pos/src/cashier/ReceiptPreview.tsx` draws the post-sale receipt in HTML with its own fixed layout.
  - Once an outlet has a template, the screen and the paper differ in block order, outlet info, points and text blocks. The money rows still agree.
  - Follow-up: render `receiptPreview(layout, data)` there, after the Kertas & Emas styling question is settled.

## Not verified (check in the owning task)

- **Byte-level start state.** The exact `escpos.ts` after Void Task 3.5 is unknown: where `Pengganti untuk #` sits relative to the reprint mark. Task 1.1's frozen copy settles it.
- **Canvas CORS** on Cloudinary delivery URLs (Task 4.3), which "Ambil logo brand" needs. Upload from a file is the fallback.
- **The RPP02N's raster and QR support**, its safe band height, and whether native SPP `write` accepts a ~20KB payload in one call (Task 4.5).
- **Drain numbers.** The RPP02N's real SPP drain rate, which sets `DRAIN_MAX_MS` and the worst wait before the next print (Task 4.5).
- **The BLE path with images.** BLE printing has never been checked on a device.
- **`@dnd-kit` under React 19 in the Backoffice.** The POS uses the same versions; confirm in Task 3.1.
