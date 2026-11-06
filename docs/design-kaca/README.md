# design-kaca (temporary)

Spec for the owner's polish pass "Kertas & Emas · Kaca" plus the live QA findings of 2026-11-04
(written by Claude chat Opus 5.5 and Google Gemini). Committed 2026-11-05 so slice sessions can read it;
**remove this folder once the Kaca wave is fully implemented** (owner, 2026-11-05).

Read with care: many QA rows are stale or wrong against live code. Verified status per finding:
see the orchestrator's verification notes (HANDOFF.md Progress board, 2026-11-05).

Owner rules that override this spec (2026-11-05):
- No see-through dialogs, slide-overs, sheets, toasts or pop-ups: anything with content to read is opaque.
- No PIN on manual discount (D-11) and no approver PIN on refunds.
- The cart column keeps today's behaviour (appears when a product is added); the open cart persists across reload.
- Auto-apply promos becomes a per-promotion setting in the backoffice, not a global behaviour change.

## Viewing the mocks

The `.dc.html` screens need `screens/support.js`, the design tool's small template runtime. It was missing from the export; a stand-in was rebuilt on 2026-11-06. Browsers block it on `file://`, so serve the folder:

```bash
cd docs/design-kaca/screens && python -m http.server 8765 --bind 127.0.0.1
```

Then open e.g. `http://127.0.0.1:8765/W1-Kaca.dc.html`. Each mock declares its intended viewport in `data-props` `$preview` (POS 1280x800, BO 1440x960-1120).
