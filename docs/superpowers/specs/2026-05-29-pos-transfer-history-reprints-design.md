# POS — Transfer Notifier + Transfer History + Reprints — Design

Date: 2026-05-29 · Branch: `prod-hardening`

## Context

Four POS-side follow-ups, bundled into one spec/plan because they all touch the
POS app + the shared `@mandalika/printer` package and so ship in **one signed
APK**:

- **F2 — Hamburger "needs attention" dot:** light the existing header dot when an
  inbound transfer awaits receipt (not only when sync is pending).
- **F3 — Outlet transfer history:** a POS view of past transfers involving the
  cashier's outlet, with reprint of the tanda terima.
- **F4 — Order receipt reprint:** reprint a past sale's receipt from order history.
- **Shared — REPRINT marker:** any reprint stamps "CETAK ULANG (REPRINT)" on the
  slip; original prints stay unmarked.

POS is the Capacitor/React app (`apps/pos`). All four need a backend deploy (F3's
new endpoint) and an APK rebuild; **on-device thermal-print verification stays
user-pending** (no printer in CI).

## Current-state facts (verified)

- **Inbound transfers (SP3):** `engine.pollInbound()` GETs `/api/v1/sync/inbound-transfers`
  every ~20s (offline-tolerant KV cache); `engine.getInboundTransfers()` returns the
  cached `Transfer[]`. `CashierScreen.tsx` reads `inbound = engine.getInboundTransfers()`
  and passes `inboundCount = inbound.length` to `MenuDrawer`, which already badges the
  "Terima Transfer" item.
- **Hamburger dot:** `CashierScreen.tsx` (~L573–584) renders a red dot on the menu
  button when `offlineData.pendingCount > 0` (unsynced data) only.
- **Transfer endpoints:** `/api/v1/transfers` is backoffice-only (`manage_inventory`).
  `/api/v1/sync/inbound-transfers` is cashier-scoped (JWT `outletId`). **No
  outlet-scoped historical endpoint exists.** Transfers are mesh with polymorphic
  `source {kind,id,name}` / `dest {kind,id,name}`; the `Transfer` DTO carries status,
  dates, items (sent/received/difference), `suratJalanNo`, `tandaTerimaNo`,
  letterheads, `discrepancyReason`.
- **Printing:** `packages/printer` `buildReceipt`, `buildRecap`, `buildTandaTerima`
  (`escpos.ts`) + `printReceipt`/`printTandaTerima` (`print.ts`). POS has
  `OrderHistoryPanel.tsx`, `ReceiptPreview.tsx`, `printer.tsx` (`usePrinter`),
  `ReceiveTransferPanel.tsx`, `buildTandaTerimaData` mapper. SP4 already prints tanda
  terima after a receive.
- **POS auth/scope:** cashier JWT carries `outletId` (`authStore.outletId`), sent on
  every API call; sync endpoints scope to it server-side.

## F2 — Hamburger "needs attention" dot

`CashierScreen.tsx`: change the dot condition from `pendingCount > 0` to
`pendingCount > 0 || inboundCount > 0` (a single combined dot — "open the menu").
`inboundCount` is already in scope. No new data; reactivity rides the existing
inbound poll + render cycle that already updates the menu-item badge.

## F3 — Outlet transfer history

**Backend** — new cashier-scoped endpoint:
- `GET /api/v1/sync/outlet-transfers?status=completed|cancelled`
  - Auth: cashier JWT; scope to the token's `outletId` server-side (mirror
    `/sync/inbound-transfers`; ignore/forbid arbitrary outlet override).
  - Returns `{ data: Transfer[] }` where (`source.kind='outlet' AND source.id=outletId`)
    **OR** (`dest.kind='outlet' AND dest.id=outletId`) — i.e. incoming + outgoing —
    filtered to the requested `status`, newest first. Reuses the existing `Transfer`
    DTO + the SP2 transfers read shape (a new outlet-scoped read method, not the
    admin `Transfers` list).
  - OpenAPI: new path + reuse `Transfer`/list response; regen Go + TS; TS client
    method `outletTransfers(status)`.

**POS UI:**
- `MenuDrawer.tsx`: new item **"Riwayat Transfer"**.
- New `TransferHistoryPanel.tsx`: two tabs **Selesai** (completed) / **Dibatalkan**
  (cancelled). Each tab fetches `api.outletTransfers(status)` **on demand** when
  opened (not in the offline sync bundle — historical, not sales-critical). Offline
  or error → a "Perlu koneksi untuk memuat riwayat" notice (best-effort; may show the
  last successful fetch). List rows: transferNo, `dari → untuk` (source→dest names),
  date, item count, a discrepancy badge when `discrepancyReason`/difference present.
  Row → detail (items with sent/received/difference + reason).
- **Reprint:** in a completed transfer's detail, **"Cetak Ulang Tanda Terima"** →
  `usePrinter().printTandaTerima(buildTandaTerimaData(transfer, cashierName), settings, { reprint: true })`,
  reusing the existing SP4 mapper + BLE path. Disabled when the printer isn't paired
  (match existing `TandaTerimaPrompt` behavior).

## F4 — Order receipt reprint

`OrderHistoryPanel.tsx`: add **"Cetak Ulang"** per past sale →
`usePrinter().printReceipt(<receiptData for that order>, settings, { reprint: true })`.
The panel already lists past orders and a `ReceiptPreview` exists, so the receipt
data is reconstructable from the order; **verify during implementation** that the
order object in history carries full line items / payment / totals — if it only
holds a summary, reprint pulls the order detail first. Reuse the same builder the
checkout flow uses (no divergent receipt layout).

## Shared — REPRINT marker

- Add an optional `reprint?: boolean` to `buildReceipt` and `buildTandaTerima`
  (`escpos.ts`) — and thread it through `printReceipt`/`printTandaTerima`
  (`print.ts`) via the job/data. When true, render a centered
  **`*** CETAK ULANG (REPRINT) ***`** line both **at the top** (right after the
  header/letterhead) and **at the bottom** (just before the cut).
- Only history-triggered reprints pass `reprint: true`. The original prints —
  checkout receipt and the auto post-receive tanda terima prompt — leave it
  unset, so they stay unmarked.

## Out of scope

- Editing/receiving transfers from the history view (receiving stays the existing
  SP3 "Terima Transfer" flow; in-transit transfers are the receive queue, not history).
- Persisting a print count / "reprinted N times" — the marker is presence-only,
  driven by the action, not a stored counter.
- Backoffice changes.

## Testing

- **Backend:** live verify `/sync/outlet-transfers` with a cashier token — returns
  this outlet's completed + cancelled transfers (incoming and outgoing), excludes
  other outlets, honors `status`.
- **Printer:** vitest for the REPRINT marker (top + bottom present when
  `reprint:true`, absent otherwise) on `buildReceipt` + `buildTandaTerima`; pure
  mapper test for the outlet-transfer → row shape if a mapper is added.
- **POS:** `tsc --noEmit` + prod build clean; combined hamburger dot lights for an
  inbound transfer.
- **APK:** one signed build. **User-pending on device:** the dot appears on inbound;
  Riwayat Transfer lists + tabs + detail; "Cetak Ulang Tanda Terima" and order
  "Cetak Ulang" print with the REPRINT marker top + bottom; original prints unmarked.
