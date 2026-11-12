# Receipt designer in the Backoffice — design

Date: 2026-11-12. Status: proposal accepted by the owner. The owner skipped the questions
and asked for a proposal, then said "yes, build it after bundles and void".

Build order: bundles (`docs/plans/2026-11-12-bundles-design.md`), then Void, then this.
The receipt has to print bundle lines and the Void stamp, so it goes last.

Mockup: `docs/plans/2026-11-12-receipt-designer-mockup.html` (layout only).

## Why

The owner wants to design the printed receipt from the Backoffice instead of having its
layout fixed in code. This fits the owner's wider aim of configuring presentation from
the Backoffice.

Today, Pengaturan › Transaksi › Struk is one global setting (`ReceiptSettings`):

- a header text and a footer text;
- show/hide switches for tax, cashier, order number, customer name and phone, discount,
  subtotal and change;
- the number of copies and auto-print.

`packages/printer/src/escpos.ts` (`buildReceipt`) prints a fixed order of sections at
58mm, 32 characters per line (`COLS = 32`). It has no logo, image or QR code support.

## What gets built

### Blocks

The receipt is an ordered list of blocks. The owner switches blocks on or off, drags
them into order and styles them lightly. The blocks:

- **Logo:** the outlet's logo (`Outlet.logoUrl`) or an uploaded image, printed in
  monochrome.
- **Title and outlet info:** title text (normal or large size) plus the outlet's name,
  address and phone. Each part can be switched off.
- **Transaction info:** number, date, cashier and customer name/phone. This replaces the
  current switches for these.
- **Item list.** Locked: it always prints. Bundles print with their three pieces and any
  bundle discount, as the bundles design specifies.
- **Discounts and total.** The total line is locked. The discount rows and subtotal follow
  today's switches.
- **Payment and change.** Locked.
- **Member points:** points earned on this sale and the new balance, when a member is
  attached.
- **Free text:** any number of blocks, for example a returns policy or a tax number.
- **Divider line.**
- **QR code** for a URL, for example Instagram, WhatsApp or a feedback link.
- **Closing line.**

Styling: left, centre or right alignment, bold, and a large size for the title.

### Locked blocks

The item list, the total and the payment always print. The designer changes presentation
only: it can never hide what was charged or alter any number.

### Templates

- "Standar" is used by every outlet by default.
- The owner can create more templates and assign each outlet one template.
- Each template sets its paper width: 58mm (32 columns, today's printers) or 80mm
  (48 columns).

### Preview and test print

- The Backoffice shows a live preview drawn by the same layout code the printer uses: one
  renderer with two outputs, text lines for the preview and ESC/POS bytes for printing.
  The preview uses a sample sale that includes a bundle.
- "Cetak tes" prints the sample on a tablet before the template is saved.

### Rollout

- The current header, footer and switches convert into the "Standar" template, so receipts
  print exactly as today until someone edits it.
- Templates reach the tablets with the settings sync. Offline tablets keep printing with
  the last template they received.

### Other receipt types

- Refund and Void receipts use the outlet's template, with a "REFUND" or "DIBATALKAN"
  stamp.
- *My call:* the shift recap (`buildRecap`) and the transfer receipt (`buildTandaTerima`)
  stay as they are.

## Constraints and risks

- **New printer abilities.** Logo and QR code need ESC/POS raster images (`GS v 0`) and
  QR commands (`GS ( k`). Confirm them with a test print on the owner's printer before
  promising them.
- **Image speed.** Images print slower over Bluetooth Low Energy, and the BLE path itself
  is still untested on a device.
- **Printing rules stay the same.** The Bluetooth Classic print queue and its "Gagal…"
  error messages (#136) are unchanged.
- **Settings and types.** A settings change goes through OpenAPI and the generated types.
  An older POS build must keep printing with its old fixed layout when a template field
  is missing.

## Left to the builder

- How templates are stored (inside `AppSettings`, or in their own table).
- The block schema, image dithering and upload limits.
- The drag-and-drop component.
- How the work splits into PRs.
