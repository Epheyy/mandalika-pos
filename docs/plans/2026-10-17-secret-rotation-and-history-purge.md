# Secret rotation + git history purge (plan, 2026-10-17)

Trigger: owner found `.claude/settings.local.json` in pushed history. Verified (masked scans, values never printed):

- Old versions in commits `a595fc6` (2026-05-18) and `34676aa` (2026-06-21) contain the Neon Postgres connection string
  with password and the `SEED_ADMIN_PASSWORD` value. Secret Manager `DATABASE_URL` and `SEED_ADMIN_PASSWORD` are still
  version 1 from 2026-05-18, so the leaked values are the CURRENT live ones.
- A search of ALL history for every current secret value found nothing else: JWT access/refresh, Redis, Sentry DSN and
  Cloudinary secret are NOT in history. Only `DATABASE_URL` (2 commits) and `SEED_ADMIN_PASSWORD` (2 commits), both only in
  `.claude/settings.local.json`.
- The file was untracked in `e957154` (2026-09-22) and is gitignored (`.claude/*`); HEAD is clean.
- Repo is private with 3 collaborators (mikaeladityan, kujangga, Epheyy). 1 open PR. Branches on GitHub: 12 heads, 0 tags.

## Phase 1 — rotation (owner + Claude)

1. OWNER: Neon console → reset the DB role password → copy the new connection string → add it as a new secret version
   (`gcloud secrets versions add DATABASE_URL --project mandalika-pos --data-file=-`, paste, finish input). The backend
   cannot reach the DB between the reset and step 2. Tell Claude "done".
2. CLAUDE: roll a new Cloud Run revision (same image, secrets are read as `latest` at start), verify `/readyz`, `/livez`,
   an authed read and the sync path; keep `00114-win` as the labelled rollback image.
3. CLAUDE: admin password. Only ONE admin exists and `POST /users/{id}/reset-password` refuses a self-reset, so use a throwaway
   ops script (not committed): random password generated locally, hashed with the app's argon2id (`auth.HashPassword`),
   `UPDATE users` for `admin@mandalika.test` + revoke all that user's refresh tokens + set `refresh_revoked_before`, and the new
   password written straight to Secret Manager `SEED_ADMIN_PASSWORD` (new version) without printing it. Owner reads it with
   `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD --project mandalika-pos`.
4. CLAUDE: disable version 1 of `DATABASE_URL` and `SEED_ADMIN_PASSWORD` in Secret Manager so the leaked values are dead there too.
5. OWNER (recommended): in the Neon console, look at connection/audit history for unfamiliar access since 2026-05-18.
6. CLAUDE: CI secret-scan guard (`scripts/ci/secret_scan.py` in the quality workflow) so a secret in a tracked file fails CI.

Not affected / no rotation needed: JWT secrets, Redis URL, Sentry DSN, Cloudinary secret (not in history).

## Phase 2 — history purge (ONLY on the owner's explicit go; the owner warns the collaborators first)

Dry run 2026-10-17 in a scratch mirror clone of GitHub (nothing pushed): 12 heads, 1,118 commits, 8 commits touch the file.
`git filter-branch --index-filter 'git rm --cached --ignore-unmatch -- .claude/settings.local.json'` finished in ~11.5 min;
all 12 branch tips get new hashes (the file's first commit is from April, so every descendant changes); the file is reachable from
0 commits afterwards; no tracked content changed apart from that file. `git filter-repo` is not installed (a PyPI download, only
with approval); the built-in tool was enough.

Steps: (a) owner tells collaborators to push everything and stop; the 1 open PR is merged or closed; (b) fresh mirror clone, rewrite,
verify again (file unreachable, every tip tree equal apart from the file, secret search returns 0); (c) keep a `git bundle` of the
original refs as a backup; (d) on the owner's go: `git push --force` for `refs/heads/*` (and tags if any) — never `refs/pull/*`;
(e) everyone re-clones (or `git fetch && git reset --hard origin/<branch>`); Claude deletes the stale local worktrees/branches and
re-creates what is needed; (f) ask GitHub Support to purge cached views / `refs/pull/*` — old SHAs stay reachable on GitHub until then
(the rotation is what makes that harmless).

Side effects to accept: every commit SHA changes (HANDOFF/plan docs cite old SHAs); Cloud Run revision `commit-sha` labels, OTA
release `commit_sha` records and CI run history point at SHAs that no longer exist, so `promote-backend.sh` re-verification of
OLD labelled revisions will refuse (rollback with `gcloud run services update-traffic` still works); any open PR breaks.

## Phase 2 result (2026-10-21, owner GO received)

Verified against a fresh mirror clone of GitHub (12 heads, 1,337 commits) and the GitHub API:

- No commit reachable from any branch contains `.claude/settings.local.json` (0 on every ref, before any rewrite).
- The two leak commits are dangling objects on GitHub: `a595fc6` and `34676aa` both return `diverged` against
  `prod-hardening` (not ancestors), and the branches carry rewritten twins instead (`dc82a14` = the same
  "production hardening" commit without the file). Every branch tip SHA was unchanged by a filter-branch pass, which
  confirms the rewrite had already landed on origin before today.
- Both dangling SHAs still serve the old file by direct SHA (`contents/...?ref=a595fc6` 7,100 bytes,
  `?ref=34676aa` 24,569 bytes). Only GitHub can drop unreachable objects.
- The pickaxe hits for `SEED_ADMIN_PASSWORD=` and `neon.tech` on branches are templates, runbooks and test fixtures
  with placeholder credentials (`.env*.example`, `RUNBOOK.md`, `config_test.go`, `test_secret_scan.py`); checked masked.

Therefore: **no force-push was done and none is needed.** Collaborators can resume; PR #1 does not need to be closed
for this. Remaining step (owner): ask GitHub Support to purge unreachable objects and cached views, quoting the two
SHAs. Request text:

> Repository Epheyy/mandalika-pos (private). We rewrote history to remove a file containing credentials, which have since
> been rotated. The old commits a595fc6 and 34676aa are no longer reachable from any branch but are still served by SHA
> (for example /contents/.claude/settings.local.json?ref=34676aa). Please run garbage collection on the repository and purge
> cached views and pull-request refs so these objects are no longer retrievable.
