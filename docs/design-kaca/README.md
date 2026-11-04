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
