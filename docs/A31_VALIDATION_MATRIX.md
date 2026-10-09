# A31 validation matrix

Packet: A31-POLLING-20260921-01. Production hook and real React19/Chromium DOM;
only promise settlement and interval firing controlled. No mock React renderer.
The test entry is separate from the production app entry, uses installed Vite,
and adds no dependency. It is explicitly browser-run, not discovered by Vitest.

| Review scenario | Current evidence |
|---|---|
|01 B success then A success|hook01 passes; before A replaced B|
|02 A completes while B pending|hook02 passes; no A data or terminal loading|
|03 A error after B success|hook03 passes; B has no stale error|
|04 A success after B failure|hook04 passes; B error remains|
|05 rapid A/B/C|hook05 passes; C only|
|06 same-scope overlapping polls|hook06 passes; latest-started wins|
|07 manual versus interval|hook07a and07b pass, both start orders|
|08 scope clears data and error|hook08 passes after prior success+poll error|
|09 unmount pending|hook09 no extra render after settlement; refetch after unmount starts no request. Before-fix failure was the latter assertion, not proof of a React warning|
|10 stable deps, SWR, error, manual|hook10 passes before and after; unchanged dependencies do not refetch on rerender|
|11 A26 cohort|hook11 real fetchAllPages, A201 across2 pages then B1; B state retained after last A page|
|12 rendered outlet success|actual Reports, A page2 held, switch B, B1/Rp7000 publishes, release A; main text byte-identical|
|13 rendered outlet failure|actual Reports B503 then A success; B error/main text unchanged, CSV disabled|
|14 old interval cleanup|hook14 explicitly invokes retained old callback; no extra request starts|
|15 regressions/types|BO50/50 with retained PostgreSQL response fixture; app and standalone harness types pass|

## Before/after

A31_BEFORE_FIX_BROWSER.json records 12 failing cases and1 passing case using the
same checked-in harness before editing the hook. A31_HOOK_BROWSER.json is13/13.
A31_REPORTS_BROWSER.json records both actual rendered races with HTTP request scope,
page numbers and before/after visible text. These are synthetic intercepted HTTP,
not database-backed checks. The page2 response is already requested under A before
the switch, so this exercises a genuine obsolete A cohort, not merely an A label.

## Reproduction

Root is C:/Users/MyBook Hype AMD/Downloads/mandalika-pos.
From root set VITE_API_URL=http://127.0.0.1:59999, then run:
`node apps/backoffice/node_modules/vite/bin/vite.js apps/backoffice --host 127.0.0.1 --port 5174 --strictPort`.
Use installed Playwright browser_run_code_unsafe with filenames
`scripts/a31-browser/hook-races.js` and `scripts/a31-browser/reports-races.js`.
The hook runner requires passed==total==13; rendered runner throws on failed checks.
For the before state restore only the packaged before-image of usePolledQuery in
an isolated replay workspace; do not roll back the current worktree.

A31_VERIFICATION.json retains exact shell commands/cwd/exits/output. Initial BO run
was49 pass/1 opt-in skipped because MANDALIKA_A26_PAGES was unset. A subsequent run
with the existing docs/A26_POSTGRES_PAGES.json passed50. This replays retained
synthetic PostgreSQL output; it does not reverify a current database/handler.
App typecheck and the separately excluded browser test source both passed.
No JS DOM/test-renderer dependency was installed; real browser was already available.

## Caller trace and limits

A31_CALLERS_BEFORE/AFTER.json contain63 AST-extracted call sites and full fetcher/
dependency expressions. A31_CALLER_ANALYSIS.json classifies scope and five changes:
Customers product options, Promotions product options, StockCount products,
PromoGrantsTab products, CustomerDetail order history. Backend Products/Orders use
scope(r); global promotion/customer/user/catalog endpoints do not implicitly gain
an outlet filter. Existing explicit location/date/page/customer dependencies remain.

Local source review checked all publication sites, old callback entry guards,
manual latest-generation lookup, symmetric cleanup and SWR. No independent
ChatGPT or separate-agent review of this new slice has occurred.

The hook does not cancel requests or freeze auth headers across pages. Obsolete
cohorts may continue I/O but cannot publish. Server offset snapshot consistency,
other ad-hoc effects, POS polling, A28 calendars, A30 permissions and A34 CI are
not solved. No fresh database/native/live check was needed for this browser hook;
no parent/release gate closes. Earlier policy-blocked database cleanup remains
stopped and retained; it was not retried or bypassed.
