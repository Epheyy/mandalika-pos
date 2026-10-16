# A35 plan — OTA readiness, rollback safety, journal-compat rule, staged rollout

Date: 2026-10-17 · Author: Claude (Opus 5.5, planner) · Status: PLAN ONLY, no code written.
Sources: `docs/audits/2026-10-14-audit-status-sweep.md` §A35 (l.388), `AUDIT_REPORT.md` §A35 (l.544),
`docs/plans/2026-10-11-p0-slice9-a01-journal.md`, installed `@capgo/capacitor-updater` **8.50.2**
(`node_modules/.pnpm/@capgo+capacitor-updater@8.50.2_*/.../android/src/main/java/ee/forgr/capacitor_updater/`).

## 0. Correction to the audit premise (verified in source)

The audit says `notifyAppReady` fires "before journal open/migration (SyncProvider)". **That is stale.**
- `apps/pos/src/main.tsx:14-37`: `boot()` awaits `bootStorage()` (`apps/pos/src/bootStorage.ts:6-9` =
  `initSecureKV()` then `initJournal()`) and renders `<App/>` only on success; on reject it renders `<BootError/>`
  instead, and App never mounts.
- `initJournal()` (`packages/sync/src/journalBoot.ts:130-185`) runs at boot, not in SyncProvider. It opens the journal and
  reads and validates **every row** (`JournalOutboxStore.open` -> `validateRow`/`rowProblem`, `journalOutboxStore.ts:37-49,
  120-135`), and migrates or resumes the seal. It either adopts the store, falls back to KV (Q1, only before takeover), or
  throws `JournalBootError`.
- `otaNotifyReady()` (`apps/pos/src/native.ts:59-67`) is called from App's mount effect (`App.tsx:163-166`). So it
  already runs **only after a successful journal boot**, and never on the BootError path. It does not wait for network,
  auth or SyncProvider (offline and logged-out boots still confirm).
- What SyncProvider does later (`SyncProvider.tsx:170-198`, `engine.rehydrate()`) is re-read the already-validated
  mirror. It is not a journal-recovery step.

So A35's "move readiness after journal boot" is **already true by construction, but only implicitly**. A refactor that
moves the confirm into `main.tsx` before `await bootStorage()`, into a root wrapper, or behind `resync` would silently
break it. Task 1 locks it with tests. **Keep the confirm in App's commit effect, do NOT move it into `main.tsx` after
`render()`**: the effect only runs once React has committed App, so a bundle that crashes during render stays
unconfirmed and is rolled back.

## 1. Capgo semantics we rely on (verified in 8.50.2 source, CapacitorUpdaterPlugin.java)

- `checkRevert()` (`:4843-4880`) runs after the app-ready wait. If the current bundle is builtin it does nothing. If the
  current bundle's status is not `SUCCESS`, it calls `setError(current)`, then `performReset(toLastSuccessful=true)`
  (fallback = last successful non-builtin bundle if installable, else **builtin**, `:3979-4030`), and with
  `autoDeleteFailed` (default true) it deletes the bundle files.
- Wait time = `appReadyTimeout` (default 10000 ms, min 1000, `:823`). For a bundle not yet `SUCCESS` it is raised to
  **30000 ms** (`PENDING_BUNDLE_APP_READY_MIN_TIMEOUT_MS`, `:130`, `:953-970`). Our `apps/pos/capacitor.config.ts:44-49`
  sets neither, so a new bundle gets **30 s** to boot the journal and commit App. This is native config (APK only, OTA
  cannot change it).
- A version left in error state is never re-applied: "Latest bundle already exists, and is in error state. Aborting
  update." (`:4610-4625`).
- The native background check runs on foreground no matter what the JS shows (`:4925-4936`). A tablet stuck on
  BootError still downloads a higher-semver fix.
- **Crux: protection covers the first launch only.** Once `notifyAppReady` has marked a bundle `SUCCESS`, a later
  launch on the same bundle that BootErrors (or a bundle that boots fine but corrupts or mis-writes queue items while
  selling) is **never auto-reverted**. The only remedies are a higher-semver fix OTA, or an APK. Capgo's own doc says
  notifyAppReady only proves "JS loaded and executed" (`dist/esm/definitions.d.ts:395-421`). This residual risk is why
  Q5 (staged rollout) is needed.

## 2. Answers to the design questions

### Q1. Failure modes of gating readiness on journal boot (not on network)
Current behavior is already the target. Remaining edge cases:
1. **Q1 fallback (`kind:'fallback'`, journal not adopted before takeover).** The bundle confirms and sells on KV with a
   warning. This is correct: rolling back would not help (the builtin runs the same code) and the owner chose
   keep-selling (Q1). It cannot happen after takeover (`tookOverBefore` -> throw, `journalBoot.ts:148-158`).
2. **Slow journal boot (large queue, slow flash).** If `initSecureKV` + `initJournal` + first commit takes more than 30 s
   on a new bundle, a *good* bundle is rolled back and marked error (it is never retried, see section 1). This is not data
   loss. Measure it on the emulator (E1). If it comes close, the remedy is an APK with an explicit `appReadyTimeout`, not
   an OTA.
3. **Render crash after a good boot.** It stays unconfirmed and rolls back. This is good, and it is why the confirm
   stays in the effect.
4. **Plugin absent / web.** `native.ts:59-67` is a no-op off-device and swallows import errors. Unchanged.
5. **Never gate on network/login.** Pre-login screens never mount SyncProvider (`App.tsx:174-181`). Gating there would
   roll back every logged-out or offline tablet. Task 1 adds a test that forbids this.

### Q2. BootError / takeover failure -> stay unconfirmed -> rollback: is it safe?
**Yes, stay unconfirmed (current behavior).** The rollback is data-safe today, under conditions section 3 makes binding:
- **Who can be the rollback target.** OTA bundles are offered only to their exact APK `versionCode`
  (`backend/internal/read/repo.go:2037-2053`, mig 0049). The fallback is the previous successful bundle on that
  versionCode, or that APK's **builtin**. For the live target (versionCode 12 = APK 2.1) the builtin already contains
  slice 9 (`SENTINEL_VERSION = 1`, `packages/sync/src/journalSentinel.ts:12`). It sealed the journal on its own first
  launch, before any OTA bundle could be applied (`autoUpdate: true` = download now, apply on next background). A sealed
  journal is fully readable by the builtin.
- **A failing bundle on a sealed tablet writes nothing before it throws.** It goes through `resumeSealed`
  (`journalBoot.ts:218-222`), which is read-only. So the rollback target reads untouched data.
- **What stays stuck.** With genuine device corruption (row corrupt, open failed), the rollback lands on the builtin,
  which BootErrors on the same journal. Effects: the queue is kept and not lost; the OTA version is marked error and never
  re-offered to that tablet; support uses `quarantineCorruptRows` (`journalBoot.ts:395-410`). This is acceptable.
  RUNBOOK should say so.
- **The real data-loss vector: a bundle that changes journal-boot semantics.** `migrate()` -> `copyAll()` writes with
  `replaceAll: true` (`journalBoot.ts:262-272`). An older bundle reaches it whenever it sees **no takeover evidence**
  (`isTakenOver` is false for an unknown `migration` meta value, and Preferences holds no sentinel, `TAKEOVER_KEY` or
  `LEGACY_BACKUP_PREFIX` key). It then rebuilds the journal from the Preferences array, which **wipes journal-only
  sales**. Likewise, a bumped `SENTINEL_VERSION` makes every older bundle stop with `MSG_VERSION_MISMATCH`. That keeps
  the data but bricks the tablet until a roll-forward. A **pre-journal bundle** (a commit older than 5dfd242) republished
  as a newer semver would read the sentinel as a corrupt queue (`journalSentinel.ts:1-3`). Selling would then continue
  on an empty Preferences queue, so journal sales become invisible until a later takeover merge. **Therefore, never ship
  by OTA:** any change to `journalBoot.ts` states/keys, the sentinel, `OUTBOX_KEY`, the meta-key formats
  (`synced_refunds`), or a bundle built from a commit that is not a descendant of the APK's build commit. These are
  APK-only, because an APK is never auto-rolled-back (and `resetWhenUpdate` clears OTA bundles on a native update).
- **Verdict.** Unconfirmed + rollback is safe *if and only if* every OTA bundle is journal-format-compatible with both
  its builtin and the previous bundle on that versionCode. Section 3 makes that a rule and Task 4 adds a mechanical
  check.

### Q3. Testing
- **Unit (vitest, `apps/pos`)** extend `apps/pos/src/bootStorage.wiring.test.ts` (it already pins
  `try { await bootStorage() } catch -> <BootError`, l.32-36):
  - (a) `<App` is rendered only after `await bootStorage()` and only outside the catch;
  - (b) `BootError.tsx` and the main.tsx catch branch never reference `otaNotifyReady`/`notifyAppReady`;
  - (c) `otaNotifyReady` is called from exactly one place, App's mount effect, and **not** from `SyncProvider.tsx`,
    `auth*`, or any `.then` of `resync`/login;
  - (d) a render test of `App` with `useAuth` mocked to `ready:false` and with `user:null`, asserting `otaNotifyReady`
    (mocked `./native`) is called once in both cases. This covers offline and logged-out confirmation.
- **Unit (`packages/sync`)** (e) in `packages/sync/src/journalBoot.test.ts` / `engine.journal.test.ts`: a sealed journal
  with an unknown *additive* item field and an unknown item `type` still adopts. Both are shape-valid, because
  `rowProblem` only checks key/seq. A status rewrite keeps the field (`outbox.ts:387,405,442` spread `...it`). Flush
  forwards type/payload/envelope verbatim and nothing else (`engine.ts:791-805`). This pins the facts the section 3 rule
  relies on.
- **Emulator only (the owner starts it).** Never publish a broken bundle to the live `/ota/check`: it would reach every
  versionCode 12 tablet. Serve the zips from the host (`http://10.0.2.2:<port>`) and drive `CapacitorUpdater.download({url,
  version})` + `set()` from chrome://inspect. This works only while `webContentsDebuggingEnabled: true`
  (`capacitor.config.ts:21`, test APK).
  - E1 good bundle, airplane mode, logged out -> `getCurrent()` status success. Survives a restart. Measure the time from
    launch to confirm with a 200-item queue (headroom against 30 s).
  - E2 local throwaway build where `bootStorage` throws (never committed) -> BootError -> within ~30 s it auto-resets to
    the builtin. Pending count is unchanged and the journal file is byte-identical (adb pull + md5, as in slice 9). The
    version is not re-applied on the next foreground.
  - E3 rollback compatibility: queue 2 offline sales on an OTA build, then `CapacitorUpdater.reset()` to the builtin ->
    the builtin shows both and syncs each exactly once (server `operation_receipts`).
  - E4 (after Task 6) a pilot allowlist offers the bundle only to the emulator's id. A curl with another `device_id`
    gets "no update"/the previous full release.

### Q4. Release rule for web-layer changes touching the journal
The draft RUNBOOK text is in section 3 (Task 3).

### Q5. Staged rollout: options, cost, recommendation
Today `LatestOtaRelease` returns the newest row per (platform, versionCode) to everyone (`read/repo.go:2037-2053`).
Capgo already sends `device_id` (persisted by `DeviceIdHelper`) and `custom_id` (persisted, set from JS with
`setCustomId`) (`CapgoUpdater.java:1512-1525`). `OtaCheck` decodes only platform/version_name/version_code
(`backend/internal/handlers/ota.go:46-71`). The OTA routes are hand-wired (`backend/internal/server/server.go:110-111,298`)
and **not in OpenAPI**, so there are no generated types to regenerate.

| Option | Mechanism | Cost | Pilot by outlet? | Notes |
|---|---|---|---|---|
| A. Do nothing | all tablets at once | 0 | no | A defect that shows up after the confirm hits the whole fleet at once (section 1 crux) |
| B. device_id allowlist | nullable `rollout_targets text[]` on `ota_releases`, filtered in SQL | S-M, backend + script only, no POS change | indirectly: the owner needs the pilot tablet's device_id (from the Task 5 check logs) | Usable for the very next OTA; mapping a device_id to a tablet is clunky |
| C. custom_id = bound outlet id | same column, matched against `custom_id`; POS calls `setCustomId(outletId)` once the terminal is bound, clears it on release | B + S POS | **yes** | The POS change must first reach the fleet (one all-at-once OTA, or ride the next APK); a tablet without a custom_id only gets full releases (fail-safe) |
| D. percentage (hash of device_id) | `rollout_percent` | S-M | no | The pilot outlet can't be chosen; a small fleet makes percentages meaningless |

**Recommendation: build B+C as one column now, before the next production-type OTA.** The column matches
`device_id = ANY(targets) OR custom_id = ANY(targets)`.
- **Promotion** re-publishes the **same** version/url/checksum with no targets. Rows are append-only, so no new endpoint
  is needed.
- **Check order** in `/ota/check`: versionCode exact match, then rollout eligibility (in SQL, before `Decide`), then
  strictly newer semver (`backend/internal/ota/decide.go:69-87`, unchanged). A device outside the allowlist gets the
  newest *eligible* release.
- **custom_id is client-asserted** on a public endpoint. Spoofing it only gets a tablet an early copy of a bundle that is
  already public in GCS. It is not an auth boundary; say so in a code comment.

Suggested default policy for the owner: **pilot outlet first**. Run 1 outlet for 1 trading day with at least 1 synced
sale, at least 1 app restart and a clean error log, then promote.

### Q6. Ordering with builtin and the versionCode guard
- `Decide` treats `builtin` as older than any release (`decide.go:60-87`). A fresh or reinstalled tablet (or one after
  `resetWhenUpdate`) therefore gets the newest *eligible* bundle on its next foreground. The allowlist filter must sit in
  the SQL so that non-pilot tablets keep receiving the last full release instead of "no release".
- A pilot version must be a higher semver than the current full release. Promotion re-uses the identical version string,
  so pilot tablets see "up-to-date". The "already current" guard in `scripts/ota-release.sh:91-101` probes with no
  custom_id/device_id, so it sees the last *full* release and lets the promote run. Task 7 must keep that true.
- The rollback target of any bundle is the builtin of the same versionCode, or an earlier bundle on it. Hence the
  section 3 rule: compatible with the builtin of the target versionCode AND with the previous bundle. A
  `NATIVE_VERSION_CODE` override (`ota-release.sh:65-71`) must build from a commit that descends from that APK's build
  commit (Task 4).

## 3. Release rule (to add to RUNBOOK.md under "Web-layer OTA", Task 3)

> **Journal rollback-compatibility rule (A35).** Any OTA bundle can be rolled back automatically, either to the previous
> bundle or to the APK's builtin. Every OTA must therefore leave the journal readable, and correctly handled, by both.
> 1. **APK-only, never OTA:**
>    - changes to the `packages/sync/src/journalBoot.ts` migration states or keys (the `migration` meta values,
>      `TAKEOVER_KEY`, `LEGACY_BACKUP_PREFIX`, the quarantine keys);
>    - `journalSentinel.ts` (`SENTINEL_VERSION`, sentinel shape) and `OUTBOX_KEY`;
>    - the format of journal meta values (e.g. synced refunds);
>    - removing or renaming an `OutboxItem` field, or changing what a `status` means;
>    - anything in `OutboxJournalPlugin.java` (native code, APK only anyway).
> 2. **OTA-safe:** additive optional `OutboxItem` fields or payload keys that older bundles ignore. They are preserved
>    when an item is rewritten, because status updates spread the stored item. Data the server needs must live in
>    `payload` or `envelope`. An older bundle sends only `type`/`idempotencyKey`/`payload`/`envelope`, so after a
>    rollback any new sibling field is dropped on the wire.
> 3. **New `OutboxType` or new required payload key:** release in two steps. First ship the server that accepts it, then
>    the bundle that writes it. Check that the builtin's local views (queue summary, refund gate, recap) tolerate the
>    new item. If they don't, the change is APK-only.
> 4. The bundle's commit must descend from the commit the target APK was built from (`ota-release.sh` checks this,
>    Task 4).
> 5. For a journal-adjacent OTA: confirm 0 pending sales on the pilot tablet first and use the pilot (staged) path. Do not
>    promote until the pilot tablet has synced a sale and restarted once.
> 6. Readiness: a bundle confirms only after the journal boots (`main.tsx` -> App effect). A bundle that BootErrors on
>    its first launch is rolled back within ~30 s, and that version is never retried on that tablet, so publish a higher
>    semver. A bundle that has already confirmed is never rolled back automatically: roll forward.

## 4. Tasks (tests first; every task touching boot/journal/OTA gets an Opus review)

| # | Size | Files | Change | Verify | Reviewer |
|---|---|---|---|---|---|
| 1 | S | `apps/pos/src/bootStorage.wiring.test.ts`, new `apps/pos/src/App.otaReady.test.tsx`, comment at `App.tsx:160-166` | Tests (a)-(d) from Q3. Rewrite the App comment: the confirm runs only after bootStorage (journal) succeeded; never gate it on network or auth; keep it in this effect so a render crash stays unconfirmed. **No behavior change.** | `corepack pnpm --filter @mandalika/pos test`. Mutate locally (move the call into SyncProvider, or into the main.tsx catch) and check the tests fail | Opus |
| 2 | S | `packages/sync/src/journalBoot.test.ts` (or `engine.journal.test.ts`) | Test (e) from Q3 | `corepack pnpm --filter @mandalika/sync test` | Opus |
| 3 | S | `RUNBOOK.md`, section "Web-layer OTA" (after l.112) | Add the section 3 rule and the section 1 rollback facts (30 s window, a failed version is never retried, roll forward) | Read-through | Haiku writes it (docs only); Opus checks the wording against section 2 |
| 4 | S | `scripts/ota-release.sh` | Before the build: (i) if `git diff --name-only <base>..$RELEASE_SHA` touches `packages/sync/src/journal*.ts`, `outbox.ts`, `storage.ts`, `syncedRefunds.ts` (synced-refunds format, `syncedRefunds.ts:4`) or `apps/pos/android/**`, print those files and refuse unless `OTA_JOURNAL_CHANGE_ACK=1`; (ii) refuse unless `<base>` is an ancestor of `$RELEASE_SHA`. `<base>` = the `APK_BUILD_SHA` env var, defaulting to the last commit that changed `versionCode` in `apps/pos/android/app/build.gradle` (check (i) can only over-flag; check (ii) is WEAKER than the real rule, see R3) | `bash -n`, shellcheck if installed, then a dry run on a scratch branch with and without a journal-file change | Opus |
| 5 | S | `backend/internal/handlers/ota.go`, `ota_test.go` | Decode `device_id` and `custom_id` leniently, cap their length, never echo them. Log `slog.Info("ota check", platform, version_name, version_code, device_id, custom_id, offered)`. This is the adoption trail (a partial release-ledger substitute) and how the owner finds the pilot device | `go test ./internal/handlers/ -run Ota`; malformed bodies still get "no update" | Opus (public endpoint) |
| 6 | M | new `backend/internal/db/migrations/0057_ota_rollout_targets.sql`; `backend/internal/ota/decide.go` (`Release.RolloutTargets []string`); `read/repo.go:2037`; `write/repo.go:1140`; `handlers/ota.go`; PG-gate fixture (`scripts/ci/postgres_gate.py`) | Full column path. **Migration:** nullable `text[]`. **Read:** `LatestOtaRelease(ctx, platform, code, deviceID, customID)` adds `AND (rollout_targets IS NULL OR $3 = ANY(rollout_targets) OR $4 = ANY(rollout_targets))`; it filters only, and `/ota/check` never returns the targets. **Write:** INSERT the column. **Validation:** `validateOtaPublish` allows at most 50 targets, each non-empty and at most 128 chars. **No OpenAPI and no generated types** (routes are hand-wired; `grep /ota backend/api/openapi.yaml` finds nothing). Tests first: a pilot row is offered only to a listed id; an unlisted device gets the previous full row; NULL means everyone; a builtin device outside the list gets the previous full row | `go test ./...`, PG gate, `make gen-check` unchanged | Opus |
| 7 | S | `scripts/ota-release.sh`, `Makefile` | `OTA_PILOT_TARGETS=id1,id2` adds `rolloutTargets` to the publish body. New `make ota-promote VERSION=x.y.z`: re-publish that version with no targets, without a rebuild. There is no authed read endpoint and `/ota/check` never returns `size`, so the values are sourced like this: url + checksum come from probing `/ota/check` with `version_name:"builtin"`, the target `version_code` and a pilot target id as `device_id`/`custom_id`; size comes from the GCS object (`gcloud storage objects describe`). Before publishing, re-zip-checksum or compare against the probe so a mismatched object is refused. No new endpoint | Dry run against the test backend with a throwaway version, then delete the rows (owner OK needed for Neon writes) | Opus |
| 8 | S | `apps/pos/src/native.ts` (new `otaSetCustomId`), `apps/pos/src/terminalBinding.ts` `writeBinding` :48 / `clearBinding` :52 (or their callers), plus boot-time `readBinding` :28 after `bootStorage`, + test | Call `CapacitorUpdater.setCustomId` with the bound outlet id once the terminal is bound, and with an empty string on release. Never blocks boot, no-op off-device, errors swallowed, never runs before `bootStorage` | Unit test with the plugin mocked: bound -> called with the id; released -> called with an empty string; unbound -> not called | Opus (OTA + terminal binding) |
| 9 | - | emulator checks E1-E4 (the owner starts the emulator) | Run the Q3 emulator checks and record the results in HANDOFF | adb/devtools evidence | Opus reviews the evidence |

Order: Tasks 1-3 first. They close the "readiness" and "rule" parts of A35 and need no deploy and no APK. Then Task 4.
Then Tasks 5-7 (a backend release with migration 0057). Then Task 8, which rides the next OTA or APK and so necessarily
goes to all tablets at once. Task 9 comes last.

## 5. Risks
- **R1 (high, residual):** a bundle that confirms and *then* mis-writes queue items is never auto-reverted (section 1).
  Mitigation: staged rollout (Tasks 5-8), the section 3 rule, and roll-forward. Capgo cannot remove this risk entirely.
- **R2:** on a slow tablet with a big queue, the 30 s first-launch window can roll back a good bundle, and that version is
  then blocked on that tablet. Measure it in E1. The fix is APK-only (`appReadyTimeout`).
- **R3:** Task 4 has two checks. Check (i), the journal-file diff, can over-flag, which is the safe direction. Check (ii),
  the ancestor check against the commit that bumped `versionCode`, is **weaker** than the real rule. A bundle built from
  a commit between that bump and the actual APK build commit passes (ii) without descending from the build commit. The
  exact build commit is in the APK manifest JSON under `Downloads/mandalika-apk/`, not in the repo. Owner question 4
  closes this gap.
- **R4:** the Task 8 custom_id only takes effect after an all-at-once OTA. Until then, pick pilots by device_id from the
  Task 5 logs.
- **R5:** the emulator tests need `webContentsDebuggingEnabled: true`. A production-type APK turns it off, so run E1-E4 on
  the test APK.

## 6. Open questions for the owner
1. Staged rollout policy: **pilot outlet first (recommended)** or all tablets at once? If pilot first: which outlet, and
   how long a soak (suggestion: 1 trading day)?
2. Build staged rollout now (Tasks 5-8, size M, migration 0057), or only before the first production-type OTA?
   Recommendation: now. OTA 2.1.1 is already live for versionCode 12 and the fleet is still small.
3. OK to log Capgo `device_id`/`custom_id` (a random install id / the outlet id; no customer data) in the Cloud Run logs
   for `/ota/check`?
4. For Task 4, should the repo record the exact APK build commit per versionCode (e.g. `apps/pos/android/native-builds.json`,
   written at APK build time), or is the build.gradle heuristic enough?
5. Still open in the A35 audit text and out of scope here: the date to switch to a production-type APK (debug flags
   off), a release ledger, inspection of the built APK artifact, and a kill-during-first-migration test on a device.
