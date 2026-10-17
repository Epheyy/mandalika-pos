# Hosted smoke scripts (Node 20+, no dependencies)

Run against a Cloud Run tag URL or the live URL. Secrets come from the environment and are never printed:

    BASE=https://<tag>---mandalika-pos-rqbgovtm2a-et.a.run.app \
    ADMIN_PW="$(gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD --project mandalika-pos)" \
    node scripts/smoke/smoke-a44.mjs

- `smoke-release.mjs` (set `RELEASE2=1` too): device codes, stock-count lifecycle, shift/outlet guards.
- `smoke-a44.mjs`: oversold sale, stock -N, exception row, report, acknowledge, refund.
- `smoke-a39.mjs`: customers CSV import preview/commit/replay/dedupe/stale (throwaway customers, deleted at the end).
- `smoke-a39b.mjs`: ingredient SKU assign / unit mismatch / one target per ingredient.
- `smoke-auth.mjs`: login, refresh rotation, replay, logout, `/livez`, sync pull.
- `cdp.mjs "<js>"`: evaluate JS in the POS WebView over `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`.

The login limiter allows 10 attempts per 5 minutes per IP+email per instance: export `ADMIN_TOKEN` (a/39/a44 accept it) to avoid
burning attempts. Scripts write throwaway data and clean up; some leave immutable audit rows by design (see HANDOFF).
