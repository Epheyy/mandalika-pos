# Void ("Batalkan transaksi") — design

Date: 2026-11-12. Status: draft, waiting for the owner's approval.

Build order (owner): bundles, then Void, then the receipt designer.

The owner confirmed the flow and the summary, with one condition: the whole
"Batalkan & perbaiki" flow must be fully recorded so it can be audited. For everything
else the owner said "use your recommendations". Those recommendations are marked
*(rec)*, so the owner can tell their decisions from mine.

## Why

Sales get entered wrongly. The mistake is most often the payment method; it can also be
the items, the promotion or the customer.

- It is usually noticed right after the receipt prints.
- It is sometimes noticed later that day.
- It is sometimes noticed days later, when stock doesn't match the shelf.

Usually the customer paid and took the goods; only the record is wrong. Today the only
tool is a refund. A refund counts as a sale plus a refund, implies goods and money came
back, and leaves the shift's payment totals wrong.

## What success looks like

- A cashier fixes a wrong sale on the POS in under a minute. The corrected sale takes the
  place of the wrong one.
- Shift payment totals and expected cash are right again, including for shifts that have
  already closed.
- Stock matches the shelf again.
- Every void can be audited: who, when, on which device, why, what was voided, what
  replaced it, and the before/after amounts.

## Non-goals

- Editing a completed sale in place. A sale is never edited: it is voided and replaced.
- Replacing refunds. Refunds stay as they are.
- Voiding part of a sale. A void always covers the whole sale.
- Deleting anything.

## Anti-goals: these would make it a failure even if it works

- A void that leaves no trace, or loses the original sale.
- Expected cash or payment totals that are wrong after a correction.
- Stock corrected twice: once by a stock count and again by a later void.
- Someone voiding a sale without the permission to do so.
- Any stock, sync, refund or outbox guard weakened to make Void work.

## What exists today (checked on origin/prod-hardening, 2026-11-12)

- **A "cancelled" status that nothing sets yet.**
  - `orders.status` already allows `'cancelled'` (migration 0077, `orders_status_check`).
  - The POS labels it "Batal" (`OrderHistoryPanel.tsx`) and the Backoffice "Dibatalkan"
    (`lib/labels/order.ts`). Order filters and reports accept it.
  - The POS recap already skips it (`recapAggregate.ts:57`, `ShiftRecapPanel.tsx:925`).
  - No runtime code sets it. Orders imported by fsmigrate can already carry it
    (`packages/types/src/index.ts:31`); they have no void record. The "Pembatalan" report
    shows them as "Dibatalkan (impor lama)".
- **Refunds:**
  - `order_refunds` (migration 0077) records the amount, payment method, reason, shift,
    who, and a ledger document key.
  - The permission is `process_refund`, and it is checked when the refund is sent (A06).
  - Points are clawed back or restored, and stock returns through refund movements.
- **Shifts.**
  - An open shift's totals come from its orders.
  - A closed shift reads a close-time snapshot that is **never recomputed**
    (`service/shift.go:182-195,247,269`, `read/shifts.go:17-24`, `sync/batch.go:176`).
  - Late sales already leave a closed shift unchanged (`sync/attribute.go:240-242`).
  - There is one open shift per outlet at a time (`service/shift.go:111-116`).
- **Permissions** are per-user rows (`user_permissions`). Custom roles are only presets,
  and the built-in cashier role has no grant table.
- **ERP documents.**
  - A refund document carries one tender in one payout method
    (`integration/erp/payload.go:249-282`).
  - A document is queued only when it has stock movements (`ledger/outbox.go:33-36`).
- **There is no general audit log table.**

## Decided by the owner

- A **Void** button in the transaction history on both the POS and the Backoffice.
- A reason is **mandatory**.
- Void returns the stock and removes the sale's payments from the shift records.
- Void is separate from refund. A sale that has been refunded, even partly, can't be voided.
- **"Batalkan & perbaiki":** void the wrong sale and record the correct one in its place.
  The money stays where it is. A plain void with no replacement also exists, for
  duplicates and test sales.
- **The voided sale:**
  - its status becomes "Dibatalkan" and its stock returns;
  - points earned on it are reversed and points redeemed on it are given back;
  - its promo code use is released;
  - it drops out of the sales totals;
  - it stays visible with the reason, who voided it and when.
- **Old sales:** the void and its replacement both count on the **original sale's business
  day and shift**, even if that shift is closed. The shift is marked "dikoreksi setelah
  ditutup".
- **ERP:** it receives a reversal of the original sale, plus the corrected sale.
- **Who:**
  - Cashiers can void sales from their own open shift on the POS.
  - Older sales are voided in the Backoffice, by roles with a new "Batalkan transaksi"
    permission.
  - There is no PIN.
- **The whole flow is recorded for audit.**

## Recommendations (owner: "use your recommendations")

### Reasons *(rec)*

The reason is a required choice:

- Salah metode pembayaran
- Salah barang
- Salah promo
- Salah pelanggan
- Transaksi ganda
- Transaksi tes
- Lainnya

A note is required for "Lainnya" (at least 10 characters) and optional otherwise. Reports
group voids by reason.

### Permissions *(rec)*

There are two new per-user permissions:

- **`void_own_shift`:** void a sale in the outlet's **currently open shift**, from the POS.
  - "Own shift" means the outlet's open shift the cashier is working, not only the sales
    they rang. There is only one open shift per outlet.
  - A migration grants it to every existing cashier user, and the cashier preset includes
    it, so new cashiers get it.
- **`void_any`:** void any sale of an outlet in your scope, within the void window, from
  the Backoffice.
  - It is also needed on the POS to make the replacement for an older sale (see below).
  - Nobody gets it by default except admins, who already have every permission. The owner
    grants it per user or through a preset.

Both are checked when the void reaches the server, like refunds (A06). Instant revocation
(#138) applies to them.

A void made offline that reaches the server after its shift has closed is **refused**: the
cashier no longer qualifies. The tablet shows why, and a `void_any` user redoes it in the
Backoffice.

### Void window *(rec)*

A sale can be voided up to **7 days** after its business day. The limit is a Backoffice
setting. Older mistakes go through stock adjustments and refunds, as today. A limit keeps
voids away from periods the ERP may already have closed (see the ERP section).

### POS flow *(rec)*

1. History → the sale → **Batalkan**.
2. A sheet asks for the reason and the choice: **Batalkan & perbaiki** (the default) or
   **Batalkan saja**.
3. For **"perbaiki"**, the cart opens pre-filled from the voided sale: items, customer and
   promotions. The cashier fixes what was wrong and completes it.
   - The void is committed only when the replacement completes. The void and the
     replacement are saved locally together and sent as one outbox item.
   - If the cashier abandons the cart, the app restarts, or the shift closes first,
     nothing is voided and the sale stays as it was.
4. For **"Batalkan saja"**, the void is committed on confirm and sent alone.
5. Once the void is committed locally, a short **"DIBATALKAN" slip** prints: the original
   number and total, the reason, who voided it and when. If the server later refuses the
   void, the tablet shows why and the sale returns to completed.
6. The replacement's receipt reads **"Pengganti untuk #<nomor asli>"**.

### What the replacement charges *(rec)*

The money stays where it is, so:

- The payment step starts with the payments the voided sale actually received. The
  method can be changed: the most common fix is changing Tunai to QRIS.
- **Editing amounts:**
  - The amounts can be edited only while the original sale's shift is still the open
    shift, for example when the customer is there to pay or get back a difference.
  - For an older sale, the amounts are fixed to what was received. An order has one shift
    and payment lines carry no shift, so its money can't be split across two shifts.
  - If a customer settles a difference on an older sale, that is its own normal sale or
    refund in today's shift.
- If the corrected items or promotions price differently from what was received, and the
  customer isn't there, the gap is recorded as a visible **"Penyesuaian koreksi"** line:
  a discount if the store received less, a surcharge if it received more. The
  replacement's total then equals the money actually received, and reports show the gap
  as its own line.
- The replacement is priced by the normal rules at the time it is entered, the same as any
  sale, including offline rules.

### Older sales *(rec)*

- **In the Backoffice,** a `void_any` user can:
  - use **Batalkan saja**;
  - use **Batalkan & perbaiki** for payment-method and customer fixes. This is a simple
    form with the same items and prices, where only the payment lines and the customer
    change. These are the fixes that don't need a cart.
- **Item or promotion fixes** on older sales need a cart, and only the POS has one:
  - The sale is voided in the Backoffice first.
  - On the POS, a `void_any` user opens the voided sale from history and taps **"Buat
    pengganti"**.
  - The replacement links to the voided sale and takes its business day and shift.
- **These are two separate writes,** so a voided older sale can exist without its
  replacement for a while. The Pembatalan report flags it "menunggu pengganti" until the
  replacement is made or someone marks it "tanpa pengganti".

This refines the owner's "older sales only in the Backoffice": the void still happens
there, and only the cart step uses the POS.

### Stock *(rec)*

- **Return and re-deduct.** The voided sale's items return to stock. The giveaway counts
  too. The replacement deducts what it sells, as any sale.
- **After a stock count.** If an approved stock count for that outlet came after the sale
  and covered one of its items, the void warns. For each such item the user chooses
  between:
  - "kembalikan stok" (the default);
  - "sudah dikoreksi oleh stock opname", which skips the return.
  
  The choice is recorded in the audit.

### Points, codes and customer *(rec)*

- Points follow the existing refund rules: points earned are clawed back, the same way as
  for a full refund, and points redeemed are given back.
- A promo code's use is released, so a customer-assigned or capped code can be used again.
- The customer's spend drops by the voided sale, as for a full refund.
- Unlike a refund, which leaves `visit_count` alone (`service/refund.go:388`), a void
  **also removes the visit**: the voided sale never happened. The replacement counts its
  own visit on its own customer, so "Salah pelanggan" moves the visit to the right
  customer.

### Shifts and reports *(rec)*

- A voided sale and its payments leave the original shift's totals. The replacement's
  payments count in that same original shift.
- **Closed shift.** When the original shift is already closed:
  - its close snapshot is **never recomputed** (the existing A06/M3 rule);
  - each void and replacement is stored as a correction delta per payment method against
    that shift;
  - the shift shows its original close figures and the corrected figures (snapshot plus
    deltas) side by side, marked "dikoreksi setelah ditutup", with the corrections listed;
  - `closing_cash`, the counted cash, never changes, so the corrected difference explains
    the shortage or overage;
  - late sales and refunds that arrived after close stay outside the snapshot, exactly as
    today.
- **Sales reports** exclude voided sales.
- **A new Backoffice report, "Pembatalan",** lists voids, filterable by outlet, date,
  cashier, reason and after-close. Each row shows:
  - the original and its replacement;
  - the before/after totals and payment methods;
  - any Penyesuaian koreksi;
  - who voided it, when, and on which device.
- The POS shift recap lists the voids made in that shift.

### Audit record *(rec)*

Every void writes one record that is never edited. It holds:

- the original sale and its replacement (if any);
- the outlet, business day and shift;
- `after_close`;
- the source (POS or Backoffice);
- the user and device;
- the time, the reason and the note;
- the stock-return choice per item;
- the ERP reversal document key.

The original sale is never changed apart from its status and a link to its void. Voiding
a replacement is allowed; the chain stays visible.

### ERP *(rec, needs the ERP developer)*

- The reversal of the original sale must return the stock **and reverse every payment
  line**.
- It must be sent even when no stock moves, for example when every line was skipped as
  "sudah dikoreksi oleh stock opname". Otherwise the ERP keeps the money twice.
- Today's refund document can't do this: it carries one tender, and documents are queued
  only with stock movements. So the reversal is most likely **its own document kind**.
- The replacement is a normal sale document.
- **Prerequisite before Void's ERP slice: confirm with the ERP developer on the staging
  ERP:**
  1. Can the ERP accept a stockless, multi-tender reversal, and in which document kind?
  2. Which date do the reversal and the replacement carry: the original sale's date or
     the void date?
  3. Does the ERP close periods inside the 7-day void window?

## Constraints

- **Offline-first.**
  - A void of your own open shift's sale works offline, through the outbox, like refunds.
  - **A void and its replacement travel as one outbox item.** The server applies both or
    neither, so a refused void can never leave its replacement counted twice.
  - If the server refuses the void (it was refunded meanwhile, the permission was removed,
    or it is outside the window), the tablet shows why and the sale stays completed.
- **Guards** (stock, refund, sync, outbox) are never weakened. Every task touching them is
  reviewed at Opus high (`AGENTS.md`).
- **Void has its own write path.** It must not write `order_refunds` rows or reuse
  `RefundLinesTx`. Every money reader, the shift aggregation and the refund report treat
  refund rows as money paid out, so they would double-count. The void path repeats the
  side effects itself: points, code usage, customer spend and visits, stock, and the
  ledger/outbox. Each one is pinned by tests and reviewed at Opus high.
- **Closed-shift corrections** change the shift-close hold logic and its tests. That is an
  Opus-reviewed change that keeps the "snapshot never recomputed" rule.
- **Bundles.** A sale containing bundles is voided whole. This design builds on the
  bundles design: `docs/plans/2026-11-12-bundles-design.md`.
- **API and generated types.**
  - API changes go through OpenAPI and the generated types.
  - A new top-level test in `backend/internal/api` or `internal/codegen` must be listed in
    `scripts/ci/codegen_gate.py`.
- **Migrations** follow the bundles migrations; plan from `origin/prod-hardening`.
- **POS look** follows "Kertas & Emas"; visual slices are compared with mockups before
  shipping.
- **Receipts.** The DIBATALKAN slip and the "Pengganti untuk" line are plain additions to
  today's printer code. The receipt designer will style them later.

## Left to the builder

- The tables and columns, beyond the audit record's contents.
- The API shape.
- How the POS pre-fills the cart.
- How the "Penyesuaian koreksi" line is stored: reuse the manual discount and surcharge
  fields, or a new line kind.
- How expected cash is recomputed for a closed shift.
- How the work is split into PRs.
