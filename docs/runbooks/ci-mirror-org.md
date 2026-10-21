# CI mirror on a free GitHub organization

Why: the personal account's 2,000 included Actions minutes for private repos are exhausted (October 2026) and no
payment method can be attached. A free organization has its own included minutes. The mirror repo exists only to run
the five push-triggered gates; `origin` (Epheyy/mandalika-pos) stays the source of truth for Cloudflare, collaborators,
the APK workflow and deploys.

The gates need no repository secrets (verified 2026-10-21: `quality.yml`, `postgres.yml`, `browser.yml`,
`backend.yml`, `dependency-security.yml` reference none), so a bare private repo is enough.

## 1. Create the organization (owner, once, in the browser)

1. Sign in as Epheyy. Open https://github.com/organizations/plan.
2. Choose **Create a free organization**.
3. Organization name: for example `mandalika-ci` (any free name; it appears only in URLs). Contact email: yours.
   "This organization belongs to": **My personal account**. Complete the form.
4. Skip adding members. Skip the survey.
5. Confirm Actions are enabled: `https://github.com/organizations/<org>/settings/actions` → "Allow all actions and
   reusable workflows" (the default). Leave everything else default.

## 2. Create the empty mirror repository (owner, once)

1. `https://github.com/organizations/<org>/repositories/new`.
2. Name `mandalika-pos-ci`, **Private**, no README, no .gitignore, no license (it must be empty).
3. Create. Note the URL `https://github.com/<org>/mandalika-pos-ci.git`.

Tell Claude the org name. The rest is command line.

## 3. Add the remote and push (Claude or owner)

```bash
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos"
git remote add ci https://github.com/<org>/mandalika-pos-ci.git
git push ci prod-hardening
```

The first push uploads the full history (about a minute). Every later push to `ci` runs the five gates on the mirror.

Watch the runs:

```bash
gh run list -R <org>/mandalika-pos-ci --branch prod-hardening --limit 10
```

## 4. Rules while the mirror is in use

- Push code merges to **both** remotes: `git push origin prod-hardening && git push ci prod-hardening`. Origin keeps
  the history that Cloudflare and collaborators see; `ci` runs the gates.
- Docs-only commits carry `[CF-Pages-Skip]` **and** `[skip ci]` in the message so neither Cloudflare nor Actions
  spends anything on them.
- CI results live on the mirror, so when a release note cites "CI green on <sha>", cite the mirror run id.
- Never add secrets, deploy credentials or the Android keystore to the mirror. The APK workflow is dispatched on
  origin only (`gh workflow run android-release.yml --ref prod-hardening -R Epheyy/mandalika-pos`) and only after
  origin's minutes reset.
- The mirror's own 2,000 minutes also run out. Current burn is roughly all five gates per push; keep pushes to merges.

## 5. When origin's minutes reset (about 2026-11-01)

Nothing to undo. Keep pushing to both; CI on origin resumes automatically. Delete the mirror only when the account has
a budget again: `git remote remove ci`, then delete the mirror repo in the browser.

## Related

- Local race coverage without CI: `python scripts/ci/postgres_gate.py --go-runner docker --output artifacts/postgres/result.json`
  runs every Postgres gate with `go test -race` inside the pinned `golang:1.26.10` Linux image (Docker Desktop must be running).
  `--only ST,RA` limits the run to the listed gates.
