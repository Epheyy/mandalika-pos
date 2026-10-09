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
office vs outlet TL) and which accounts hold `process_refund`.

## Next

1. **Fix the audit-branch browser gate.** `BO-PAGES-CSV` times out waiting for "51 transaksi".
   Hypothesis: tests build fixtures with UTC `new Date()` while the backoffice filters by
   Asia/Jakarta date, so the gate fails between 17:00–24:00 UTC. Confirm with the rerun of
   `0478648` (run 36120323567, attempt 2), then make the test timezone-stable.
2. Merge prep checks (plan §3): dependency-security blockers decision, Opus review of `e957154`
   live-behaviour changes, promotion-key preflight, JSON compatibility, Cloudflare build.
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
