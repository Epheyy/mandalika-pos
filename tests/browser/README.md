# Mandatory synthetic Chromium gate

From the repository root, using Node 22 and pnpm 9.15.0:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install --with-deps chromium
corepack pnpm typecheck:browser
corepack pnpm browser:ci
```

On Windows with browser system dependencies already available, use
`corepack pnpm browser:install`. Playwright 1.63.0 and its Chromium revision are
locked; no system-browser channel or executable fallback is used. Browser binaries
live outside the repository. An optional `--output <new-directory>` on browser:ci
selects a new evidence directory; old runs are never overwritten.

`required-scenarios.json` inventories the accepted historical scenarios and their
required, redundant or intentionally manual classification. The ordinary typed
Playwright tests call imported fixture functions, not evaluated snippet strings.
The required test IDs (the count lives in `required-scenarios.json`) include compound rendered journeys and 13 separately
reported real-React hook races. The discovery check and completion reporter reject
missing/duplicate/unregistered IDs, skips/fixmes, expected failures, unexecuted
tests and failures. `forbidOnly` is unconditional, retries are zero, and the first
failure stops the run; remaining required IDs then fail completion too.

POS and Backoffice use the real app Vite configurations with `envDir: false`, an
explicit synthetic API origin and strict loopback ports 5183/5184. Existing port
occupants are rejected, never reused or killed. API responses are intercepted
synthetic data at 127.0.0.1:59999; no API service, real login or provider credentials
are used. Every browser context starts empty. Synthetic nonfunctional tokens are
seeded before app startup, and service workers are disabled. The test server
replaces only Backoffice's decorative public-site logo URL with an inline synthetic
image. This fixture substitution does not edit the production brand module.

All other external HTTP(S) requests and WebSockets are aborted and fail the test,
even if application code swallows the network error. Only the two exact local Vite
WebSocket origins/root path are allowed. Unhandled API requests fail closed. HTTP
request evidence omits query strings. This is browser-context isolation, not a
host-level firewall or a hostile-code sandbox.

Playwright owns both Vite process trees. The worker fixture closes its Chromium
server in finally. The gate records owned process IDs and checks that they have
exited and both ports are closed. Uncertain cleanup fails the gate. Startup is
45 seconds per app, each test 120 seconds, suite 15 minutes, outer process
16 minutes and hosted job 25 minutes. SIGINT/SIGTERM and outer timeouts terminate
the owned Playwright process tree. Abrupt host loss/SIGKILL cannot execute finally;
the disposable hosted runner and failed/cancelled job provide that boundary.

Successful runs retain JSON/JUnit and concise command/network/process records.
Failed tests may retain synthetic traces/screenshots. CI uploads only an explicit
failure-file allowlist for seven days; no persistent browser profile or real
storageState is saved. Fixture data, receipts and queued operations are synthetic.

`.github/workflows/browser.yml` runs on every PR/push and workflow_call, checks out
the caller SHA and receives no signing/provider secrets. Android signing depends
on quality, database, backend and browser. The JS quality gate also typechecks the
new test code. React Doctor remains advisory and separate.

Chromium with synthetic transports does not establish native Android durability,
printing/sharing hardware, real provider behavior, or business database concurrency.
S0a/S0b rendered fixtures use successful test storage and simulated permission
transport; their backend/database assertions remain in the separate mandatory
PostgreSQL gate. Local Windows results do not establish hosted Ubuntu execution.
Full A34/T29 and all release gates remain open.

## Backoffice scenario helpers

Backoffice scenarios open the app with `openBackoffice(page)` and move with `navTo(page, navId)` /
`openTab(page, navId, tabKey)` from `fixture.ts`. Sidebar items carry `data-nav-id` (the ids in
`apps/backoffice/src/lib/router/routes.ts`) and `ui/Tabs` buttons carry `data-tab-key`, so label renames
never touch a scenario. Install the scenario's API route first, then call `openBackoffice`.
