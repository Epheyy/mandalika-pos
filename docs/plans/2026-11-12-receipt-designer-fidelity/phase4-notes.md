# Phase 4 fidelity notes (logo, QR, Cetak tes di tablet)

Compared `p4-struk-logo-qr@1440x900.png` and `@1024x768.png` (Backoffice, 80mm, a generated 300x100 logo uploaded, a QR block added) with `mockup@1440x900.png`. At 1024 the layout stacks (block list above the preview), so the preview and its buttons are below the shot; the 1440 shot shows them.

- Logo: the mockup draws a boxed "MANDALIKA" at the top of the paper. The build puts the new Logo block at the end of the list (new blocks append), so the dithered logo sits at the bottom of the paper until the admin drags it up. The dither turns the thin box into a dashed line and fills the glyphs (1-bit, as printed).
- QR: the mockup draws a checkerboard QR. The build draws a bordered 64px square with "QR" and the address in small mono text underneath (no QR library, by design). New QR blocks start with `https://example.com`.
- Rows: `Logo` and `QR code` use the same row style as the other blocks; hints are `dari outlet / unggah` and `alamat web di struk` (the mockup shows the URL as the QR hint).
- `Cetak tes di tablet` sits left of `Simpan` under the preview, as in the mockup, as a secondary button (mockup: outlined gold).
- Not in the mockup: the `Cetak logo & QR` checkbox under the preview (mirrors the tablet switch, shows the text fallback).
- The mockup's add row reads "+ Tambah blok (teks, garis, QR, gambar)"; the build keeps "+ Tambah blok" and lists the kinds in the menu (Logo, QR code added).
- Everything else is unchanged from Phase 3.
