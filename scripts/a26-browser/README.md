# A26 browser qualification

These are Playwright tool function snippets, not standalone Node scripts. Run
with `mcp__playwright__browser_run_code_unsafe` using the absolute filename.
Installed local Vite apps use `VITE_API_URL=http://127.0.0.1:59999`, ports5174
(Backoffice) and5173 (POS). All API responses are synthetic; external hosts are
blocked. Do not point these fixtures at a live financial environment.

1. `backoffice-setup.js` resets browser routes and synthetic local auth, seeds51
   orders with the real server's200/default50 limit behavior, and captures CSV.
   Before the fix this returned50 rows, after the fix51.
2. `backoffice-checks.js` tests51/201/1000 orders, CSV/totals/filters, shift CSV,
   dashboard/last-product stock, and failed-page export/error behavior.
3. `transactions-checks.js` checks the Reports Transactions tab's XLSX and failure.
   This replaces the Blob interceptor: rerun setup before repeating CSV tests.
4. Run existing `scripts/a24-browser/setup.js` to establish the POS synthetic
   cashier, then click Menu. Run `pos-recap.js` for401 orders/flows,251 history,
   historical detail, later-page failures and same-storage offline panel remount.

Use observed controls: current Backoffice Field labels are not associated with
their inputs, so fixtures locate selects through their options. Currency assertions
normalize nonbreaking spaces. HMR after source edits can remount the cashier;
finish edits before running and re-open Menu when needed.

Outputs in `docs/A26_BROWSER_*.json` are actual returned assertions/data. Browser
fixtures verify rendered app wiring, not live API or native/printer qualification.
Real authenticated handler/PostgreSQL evidence is separately captured by
`TestPaginationPostgres`, with an explicit fresh loopback fixture and no secret fallback.
