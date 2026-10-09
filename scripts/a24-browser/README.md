# Local browser acceptance fixture

These files are Playwright tool function snippets, not production entry points or
Node CLI scripts. They render the actual applications and intercept API traffic.
Only synthetic names, identities, nonfunctional auth strings and catalog data are used.

Start installed Vite in apps/pos and apps/backoffice with VITE_API_URL set to
http://127.0.0.1:59999, host127.0.0.1, strict ports5173/5174. Do not point these
checks at deployed apps. Use a dedicated test browser context; setup.js clears that
local test origin's storage and blocks external network requests. No real login.

Run setup.js with the Playwright browser_run_code_unsafe filename argument, then:

1. guest-gate.js: expected to fail on entry source, pass after A24.
2. qualify-pos.js: direct/linked picker cancel/confirm/takeover/clear-removal.
3. qualify-pos-boundaries.js: participant invalidation, clear, invalid legacy refusal.
4. For Backoffice, navigate to5174, seed synthetic Backoffice refresh and today's
   loginDate in localStorage, reload, click Promosi, then qualify-backoffice.js.
5. Return to5173. Fresh setup.js restores the synthetic catalog for independent cases.
6. guest-sales.js: guest/customer eligibility, captures/receipts/reconstruction.
7. physical-queue.js: per-owner removal and physical metadata conservation.
8. add-customer.js: ordinary customer_create and registered sale flow.

Every function throws on a failed invariant and returns evidence on success.
A few selectors intentionally follow existing UI structure (unlabelled edit icon,
Modal without dialog role); this does not add production test-only selectors.
API503 on batch is intentional to retain captured synthetic operations for inspection.
Queue attempts may evolve normally. Browser tests do not prove server persistence,
authentication, settlement, native storage durability or physical printer behavior.
See docs/A24_VERIFICATION.json for actual runs and fixture corrections.
