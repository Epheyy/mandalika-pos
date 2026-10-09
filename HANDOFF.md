# HANDOFF — current state (read this first)

Short, living handoff for Claude sessions (local and cloud/mwsh-vl). **Overwrite the "Now"
and "Next" sections at each milestone; keep it under ~150 lines.** History lives in git log
and `docs/`. The old `SESSION_HANDOFF.md` (~435 KB, Codex era, local-only) is historical:
read it by section only if a task needs old detail.

Last updated: 2026-10-10 by Claude (Opus 5.5).

## Now

- **Live:** Cloud Run `mandalika-pos` revision `00078-yey` (100%), built from
  `prod-hardening` @ `8c14481`; `prod-hardening` HEAD `ebceb46` (gofmt only, backend CI green).
  Rollback: `gcloud run services update-traffic mandalika-pos --region asia-southeast2 --to-revisions mandalika-pos-00077-b45=100`.
- **Shipped 2026-10-10:** client-IP spoofing fix (A34e15: no chi RealIP, `TRUSTED_PROXY_HOPS=1`,
  IPv6 /64 buckets, normalized login email) + per-account failed-login cap (30 / 15 min).
  Live forged-header check passed 7/7.
- **Branches:** `audit/hosted-proof-20260922` = Codex audit work + Claude docs, **not merged**
  into `prod-hardening`. Its Chromium browser gate is red (see Next 1).
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

**Refund permission (read-only Neon query, 2026-10-10):** every account effectively holds
`process_refund` (Administrator = admin role; Yasmine/cashier BSD, Anggun/manager BSD,
test/manager PMS = explicit rows). So the audit branch's batch-refund denial (A06) denies
nobody today. 7 refunded orders total, 6 under "test", 1 unattributed (no `refunded_by`
column exists — refunder isn't recorded). Administrator has 149 unexpired refresh tokens
(tokens accumulate / shared login) — worth a cleanup + token-reuse review later.

## Next

1. ~~Browser gate~~ **Fixed 2026-10-10 (`e1f7455`)**: it was a real backoffice bug — Reports
   defaulted to the UTC date but filtered by local day, so 00:00–07:00 WIB showed yesterday.
   Gate green inside that window. Same UTC-date pattern remains (not yet fixed, owner to
   decide): `CustomerDetail.tsx:41`, `OpnameTab.tsx:182,202`, `MovementSummary.tsx:25`,
   `csvUtils.ts` filenames; `auth.tsx` login day rolls at 07:00 WIB (UTC day).
2. Merge prep checks (plan §3): dependency-security blockers (26, gate red) decision, Opus
   review of `e957154` live-behaviour changes, promotion-key preflight, JSON compatibility,
   Cloudflare build.
3. Fast-forward merge audit → `prod-hardening`, deploy, then P0 slices in plan order
   (1: A13 transfer locking).

## Known gaps (not P0)

- No APK/OTA release ledger (artifacts expired, OTA bucket empty) → no rollback artifact.
- Cloud Run runs as the default compute SA with `roles/editor` (over-privileged).
- A34 parent (CI enforcement) and all release gates remain open.

## Working agreements (summary — full text in AGENTS.md)

Six rules (ask / scope / flag / verify / show / admit). Routing: Fable guardian only on request;
Opus plan + review of risky surfaces; Sonnet implements; Haiku search/chores. Advisor: see
AGENTS.md. Update this file before context compaction and at the end of each milestone.
