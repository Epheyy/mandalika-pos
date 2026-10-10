# HANDOFF — current state (read this first)

Short, living handoff for Claude sessions (local and cloud/mwsh-vl). **Overwrite the "Now"
and "Next" sections at each milestone; keep it under ~150 lines.** History lives in git log
and `docs/`. The old `SESSION_HANDOFF.md` (~435 KB, Codex era, local-only) is historical:
read it by section only if a task needs old detail.

Last updated: 2026-10-10 by Claude (Opus 5.5).

## Now

- **Live:** Cloud Run `mandalika-pos` revision `00086-pac` (100%, tag `errc`), built from
  `prod-hardening` @ `249fd35` = merged audit work + P0 slices 1 (A13), 2 (A11) and 3 (sync
  error contract), deployed 2026-10-10. Migration 0045 applied. Backoffice on Cloudflare from
  `fe52d6e` (slices 1–3 are backend-only).
  Rollback: `gcloud run services update-traffic mandalika-pos --region asia-southeast2 --to-revisions mandalika-pos-00084-rav=100`
  (00084-rav = A13+A11 without the error contract; older: 00082-yig, 00080-noh).
- **Develop on `prod-hardening`** (local checkout switched 2026-10-10).
- **Shipped 2026-10-10:** client-IP spoofing fix (A34e15: no chi RealIP, `TRUSTED_PROXY_HOPS=1`,
  IPv6 /64 buckets, normalized login email) + per-account failed-login cap (30 / 15 min).
  Live forged-header check passed 7/7.
- **Branches:** `audit/hosted-proof-20260922` was **fast-forwarded into `prod-hardening` on
  2026-10-10** (Opus review: no code blockers; JSON wire output unchanged). Backoffice changes
  (Reports date fix, full pagination) went live via Cloudflare (new bundle verified).
- **Until the next APK:** nobody presses "Ya, hapus" on the tablet — the old app deletes
  parked items, and the merged backend rejects more invalid input than before.
- **Pre-existing bugs seen in the deploy smoke (same on the old revision):** `/sync/version`
  returns 500 with a raw Postgres error for an account with no outlet (should be 400, and
  must not leak DB text); `/sync/outlet-transfers` needs a `status` param.
- **Workflow:** Claude-only (`AGENTS.md`), subagents in `.claude/agents/`.

## Decisions (owner, 2026-10-10)

Owner accepted all recommendations in `docs/plans/2026-10-10-p0-remediation-plan.md` §4:
merge the audit branch after the §3 checks; POS account = shared terminal (operator recorded
per shift); remove POS outlet switcher + logout, never wipe an unsynced queue; old-format queued
events accepted for one release / 14 days then review; offline-authority duration deferred to
slice 10; cash below total = reject online / accept-and-flag offline; non-cash mismatch = keep
and flag; denied offline refund = visible needs-review cash movement, never deleted; competing
transfer receipt = first valid wins, second → review; all tablets at 0 pending before
sync-changing deploys while pre-launch. Still open: who resolves needs-review refunds (head
office vs outlet TL).

**Refund permission (read-only query of the TEST Neon DB, 4 accounts, 2026-10-10):** all 4
effectively hold `process_refund` (Administrator = admin role; Yasmine/cashier BSD,
Anggun/manager BSD, test/manager PMS = explicit rows). The real fleet is not on this DB yet.
No role grants it by default: backoffice user creation stores only what is ticked in
`PermissionPicker` ("Proses Refund"), and the Firestore import (`fsmigrate/tables.go:264-268`)
copies each user's old permissions as-is. **Merge-prep item:** any real cashier without the
row can refund today via `/sync/batch` but will be denied after the A06 merge — audit the
real accounts' permissions before go-live (feeds decision 8). 7 refunded orders total, 6 under "test", 1 unattributed (no `refunded_by`
column exists — refunder isn't recorded). Administrator has 149 unexpired refresh tokens
(tokens accumulate / shared login) — worth a cleanup + token-reuse review later.

## Next

1. ~~Browser gate~~ **Fixed 2026-10-10 (`e1f7455`)**: it was a real backoffice bug — Reports
   defaulted to the UTC date but filtered by local day, so 00:00–07:00 WIB showed yesterday.
   Gate green inside that window. Same UTC-date pattern remains (not yet fixed, owner to
   decide): `CustomerDetail.tsx:41`, `OpnameTab.tsx:182,202`, `MovementSummary.tsx:25`,
   `csvUtils.ts` filenames; `auth.tsx` login day rolls at 07:00 WIB (UTC day).
2. ~~Merge prep~~ done 2026-10-10. Dependency-security (26 blockers) is not a deploy gate and
   every blocker also exists on pre-merge `prod-hardening`. Follow-ups:
   - **Next APK:** Capacitor 8.3.4 → ≥ 8.5.1 (critical GHSA-rvm3-566m-v7fv) + removes the
     destructive "Ya, hapus" button. Both need a native rebuild.
   - **Backend slice:** Go toolchain patch (stdlib 1.26.8 has 13 advisories), x/crypto bump,
     chi upgrade; build-only npm (brace-expansion, source-map-js); rgbcolor licence evidence.
   - **Scaling:** backoffice now loads all order pages on every 12 s poll and errors
     ("Data berubah saat dimuat") if rows change mid-load — fine for 1 tablet, not for 26.
3. ~~Backend deploy~~ done. ~~P0 slice 1 (A13)~~ done 2026-10-10: transfer row lock, guarded
   status updates, atomic guarded send decrement (sorted lines), lock-conflict retry
   (3 attempts) + clean 409 `ErrBusy`; PostgreSQL gate TR (11 subtests, fails on old code).
   ~~P0 slice 2 (A11)~~ done 2026-10-10: `operation_receipts` + `RunWithReceipt` make
   refund / shift_open / shift_close / cash_flow / customer_create exactly-once on
   `/sync/batch` (replay returns the original result; mismatch = clean conflict); migrations
   now run each file under `pg_advisory_xact_lock` (pooler-safe). PostgreSQL gate OR.
   CI gate image now pulled from `public.ecr.aws/docker/library/postgres:18.3` (Docker Hub
   rate limits blocked it).
   ~~P0 slice 3 (error contract)~~ done 2026-10-10: failed `/sync/batch` items carry `code`
   (rejected|forbidden|not_found|conflict|competing_receipt|key_conflict|busy|internal;
   actor_mismatch reserved) and `retryable` (present only on errors). Only marked
   rejections (`internal/apperr`) and PG class 22/23 except 23503 are non-retryable;
   unknown/server/connection errors are retryable `internal` with a sanitized message
   (raw error in logs). Concurrent duplicate orders return `duplicate`. **Clients must treat
   a missing or unknown `code` as today's behaviour.**
   ~~P0 slice 4 (A01a)~~ code done 2026-10-10 (`afc1b91`, `4c42dbe` on prod-hardening; ships
   in **APK 1.1 / versionCode 2**, built by run 38025511989 (`63c387d`; artifact `mandalika-pos-release-apk`, expires 2027-01-08), + Capacitor 8.5.3 critical-advisory fix):
   awaited fail-loud outbox writes (item only sendable after its write succeeded),
   corrupt-queue quarantine + banner, single-flight submit buttons, old engines disposed on
   logout, transfer_receive discarded only on competing_receipt/conflict/not_found,
   retryable errors don't burn attempts (reported after 10). **A01 still OPEN:**
   `@capacitor/preferences` uses `apply()`, so a resolved write isn't on disk yet — full
   durability needs the SQLite journal (slice 9). Tablet ran a `6093c6d` APK (v1.0).
   **Owner on-device checklist** (tablet at 0 pending/0 failed before install): sale
   survives force-close; "Ya, hapus" gone; guest sale; customer+loyalty sale; linked
   code/BXGY/bundle; refund (terminal account needs "Proses Refund", re-login); Rekapan +
   Riwayat; shift close; transfer receive prints TT; offline sale syncs after reconnect.
   **Next: P0 slice 5 — A02 + A03 client states** (needs_review, backoff, route by `code`).
   CI flakiness today: Docker Hub, ECR Public and Maven Central all rate-limited/refused
   hosted runners once each (re-runs passed); consider caching the PG image in GHCR and
   Gradle download retries. setup-android no longer installs the removed `tools` package.
   Open follow-ups: corruption banner marker never clears; failed save burns an order
   number; release APK still has WebView debugging on; CI could inject versionCode.
   Follow-ups: no pruning job for `operation_receipts`; OR test goroutines use t.Fatalf;
   cold start ~1–3 s slower (locked per-file migration check); shift opens from two
   different keys at one outlet still both succeed.
   Small follow-ups: ingredient transfer sends don't sort lines (rare deadlock → raw 400 text);
   `/sync/version` 500 for outlet-less accounts.

## Known gaps (not P0)

- No APK/OTA release ledger (artifacts expired, OTA bucket empty) → no rollback artifact.
- Cloud Run runs as the default compute SA with `roles/editor` (over-privileged).
- A34 parent (CI enforcement) and all release gates remain open.

## Working agreements (summary — full text in AGENTS.md)

Six rules (ask / scope / flag / verify / show / admit). Routing: Fable guardian only on request;
Opus plan + review of risky surfaces; Sonnet implements; Haiku search/chores. Advisor: see
AGENTS.md. Update this file before context compaction and at the end of each milestone.
