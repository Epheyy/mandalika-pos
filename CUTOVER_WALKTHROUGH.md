# Phase F Cutover — Beginner's Walkthrough

This guide assumes you know **nothing** about this migration. Read top to
bottom. `CUTOVER.md` is the short checklist; this file explains every step in
plain language so you understand *what* you're doing and *why*.

---

## What is even happening here?

The app used to store all its data in **Firebase Firestore** — a cloud database
run by Google. We rebuilt the backend to use **PostgreSQL** ("Postgres") — a
different database that *we* run and control.

The new code is finished. But the **old data still lives in Firestore**. This
phase ("the cutover") copies that data out of Firestore and into Postgres, then
switches the app over and turns Firebase off.

Think of it like moving house:

- **The export** = packing everything in Firebase into boxes (one big file).
- **The migration tool** = a truck + crew that unloads those boxes into the
  right rooms in the new house (Postgres).
- **The dry-run** = a rehearsal: the crew unpacks everything, you check nothing
  broke, then they put it all back in the truck. No commitment yet.
- **The real cutover** = doing it for real, then living in the new house.
- **Decommission** = selling the old house once you're sure the new one works.

You will run a few commands in a terminal. Each one is explained. You do **not**
need to write any code.

---

## Words you'll see (glossary)

- **Firestore / Firebase** — the OLD cloud database (Google). Source.
- **Postgres / PostgreSQL** — the NEW database (ours). Destination.
- **Collection** — Firestore's word for a group of records (e.g. all
  `orders`, all `customers`). Like a spreadsheet tab.
- **Document** — one record in a collection (one order, one customer).
- **Table** — Postgres's word for the same thing a collection is. The
  migration maps each Firestore collection to a Postgres table.
- **Export** — a single big `export.json` file containing a copy of all
  Firestore data. You create this with a small script.
- **Service account key** — a JSON file that is basically a robot password.
  It lets the export script read Firebase without a human logging in. Treat it
  like a password — never share or commit it.
- **The migration tool** — a program in this repo
  (`backend/cmd/migrate-firestore`) that reads `export.json` and fills
  Postgres. You run it with one command.
- **Dry-run** — a practice run. The tool does everything, then **undoes it**
  so nothing is actually saved. Safe to run as many times as you want.
- **Parity** — "do the numbers match?" After loading, the tool counts what it
  put in Postgres and compares it to what was in Firestore. They should match.
- **Staging** — a practice environment (a throwaway database on your machine).
  NOT the real production system. You test here first.
- **Production** — the real live system that real staff and customers use.
- **Outbox** — the POS (cashier) app can take sales while offline. Those
  sales sit in a local "outbox" queue on the device until the internet comes
  back and they sync to the server. An undrained outbox = sales not yet saved
  to the server.
- **Idempotent** — a fancy word meaning "safe to run more than once." If the
  migration tool crashes halfway, you just run it again — it won't create
  duplicates.
- **Rollback** — undo. Putting the database back exactly how it was.

---

## Before you start (gather these)

1. **Access to the Firebase project** (the Google account that owns it).
2. **A service account key file.** Get it here:
   - Go to the Firebase console (console.firebase.google.com).
   - Pick the project → gear icon → **Project Settings**.
   - **Service Accounts** tab → **Generate new private key** → it downloads a
     `.json` file. Save it somewhere safe. This is the robot password.
3. **Node.js installed** (to run the export script). Check by running
   `node --version` in a terminal. If it errors, install Node first.
4. **This repo on your machine**, and the ability to open a terminal in the
   project folder.
5. **Docker installed** (to run the practice Postgres database). Check with
   `docker --version`.
6. **A maintenance window** — a planned ~1 hour when staff are told "the system
   will be briefly switching over." Pick a quiet time (e.g. after closing).

If any of these is missing, stop and sort it out first. You cannot do the
cutover without all six.

---

## Step 1 — Copy the data out of Firebase ("the export")

Goal: produce one file, `export.json`, containing everything in Firestore.

`CUTOVER.md` contains a small script called `dump-firestore.mjs`. Copy that
script into a file with that name in the project folder.

In a terminal, in the project folder, run these two lines (replace the path
with where you saved the robot-password JSON):

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
node dump-firestore.mjs > export.json
```

What this does: the script logs into Firebase using the key, reads every
collection, and writes it all into `export.json`.

While it runs it prints lines like `orders: 1234` to the screen. **Write these
numbers down.** They say how many records were in each collection. You'll check
later that the same number landed in Postgres.

⚠️ Important:

- `export.json` contains real customer info (names, phones, orders). Treat it
  like a confidential document. It is already set to never be committed to
  git. Delete it when the cutover is fully done.
- If the script errors saying a collection doesn't exist, the real Firebase
  project may use different names than the script expects. Open the Firebase
  console, look at the actual collection names, and edit the `COLLECTIONS`
  list in the script to match.
- If `orders` is huge (tens of thousands) the script might run out of memory.
  If that happens, ask a developer to add "paging" to the script. For most
  cases it's fine.

Result of Step 1: a file `export.json` exists, and you have a list of
"how many of each thing" written down.

---

## Step 2 — Practice run + check the numbers ("dry-run + parity")

You will NOT touch the real system yet. You'll load the data into a throwaway
practice database on your own machine and check everything looks right.

In a terminal, in the `backend` folder:

```bash
cd backend
docker compose up -d
```

`docker compose up -d` starts the practice Postgres database in the background.
Now tell the tool where that database is:

```bash
export DATABASE_URL="postgres://mandalika:mandalika@localhost:5433/mandalika_pos?sslmode=disable"
```

(That long string is just the address + login of the practice database. Copy
it exactly.)

Now the practice run:

```bash
go run ./cmd/migrate-firestore --input ../export.json --dry-run
```

`--dry-run` means: load everything, show a report, then **undo it all**.
Nothing is saved. You can run this as many times as you like.

When it finishes it prints a **report**. Read it carefully. You are checking
5 things ("the parity gate"):

1. **Counts match.** Each line should say `(input=N ✓)`. The number should
   equal what you wrote down in Step 1. If a line says `⚠` instead of `✓`,
   something didn't come across cleanly — don't continue, investigate.
2. **Money matches.** The report shows a total of all order amounts. It should
   match the order total from Firebase. (Tip: add one line to the dump script
   that prints the Firebase total too, so you have something to compare —
   `CUTOVER.md` and the short walkthrough show how. If unsure, ask a dev to add
   it.) If the money is off, a field name probably didn't line up — stop and
   get a developer.
3. **A few orders look right.** Pick 5–10 real orders you can recognize. In a
   database tool connected to the practice Postgres, or by asking a dev to run
   a quick query, confirm the items, total, and customer name match what
   Firebase shows for those same orders.
4. **A few shifts look right.** Same idea for cashier shifts — the cash / card
   / transfer / QRIS amounts should add up to the shift total.
5. **Read the warnings.** The report has a warnings section. One warning is
   normal and expected: it says migrated users have no usable password (see
   Step 4, point 6). Other warnings (like "unknown role") — note them and
   decide if they matter.

If anything fails: fix the export (or the source data) and run the dry-run
again. Because it's a dry-run, you can repeat this safely forever until it's
clean. **Do not move on until all 5 pass.**

---

## Step 3 — Test the offline behavior ("soak test")

The cashier app must keep working with no internet and sync up later. Before
going live, test that this still works using the **real migrated data** (the
practice database you just loaded), not fake test data.

Do this hands-on with the POS app pointed at the practice backend:

1. Open the POS app online. Confirm products / customers / promos show up.
2. Turn the internet OFF. Make a few sales, do one refund, close a shift. The
   app should accept them and show them as "pending sync."
3. Turn the internet back ON. The pending sales should sync. Check the server
   now has exactly those sales — not duplicated, not missing.
4. On the Backoffice (admin) app, edit a product. The POS app should pop a
   "data updated — resync" wall. Resync should clear it. Any sales still
   waiting should still sync fine.
5. While sales are mid-sync, force-close the POS app. Reopen it. The pending
   sales should still be there and finish syncing.

If any of these fail, that's a real software bug — stop the cutover and get a
developer. This is the last safety check before touching production.

---

## Step 4 — The real switch ("production cutover")

This is the real thing. Do it during your maintenance window. **Do the steps
in this exact order.**

1. **Freeze the Backoffice.** Tell admins: stop editing products / prices /
   promotions now until you say it's done. (If data changes mid-cutover, the
   POS apps could end up with stale info.)
2. **Drain every POS device.** On each cashier device, tap "Sync now" and
   confirm it shows 0 pending. This pushes any offline sales to the server.
   **If you skip this, those sales are lost forever.**
3. **Do a fresh export.** Repeat Step 1 now (after the freeze) so you have the
   very latest data. This `export.json` replaces the old one.
4. **Run the migration for real** (note: NO `--dry-run` this time):
   ```bash
   go run ./cmd/migrate-firestore --input export.json
   ```
   This actually saves the data into the real Postgres. If it fails partway,
   that's OK — just run the same command again. It's safe to repeat and won't
   duplicate anything.
5. **Verify.** Check the report is clean again (same 5 checks as Step 2). Log
   into the live Backoffice and look at a few orders / products to confirm
   they're really there.
6. **Tell staff about passwords.** Old users came from Firebase, which used
   "Sign in with Google" — there were never any passwords. So migrated user
   accounts **cannot log in normally**. You handle this by:
   - keeping the one admin account that was created when the backend was set
     up, and
   - re-creating / re-inviting staff accounts in the Backoffice (or sending
     password resets).
   Communicate this to staff **before** the window so nobody is surprised.
7. **Point the apps at the new backend** and do a quick smoke test: log in,
   make one test sale, open one report. Watch for errors. Done.

**If something goes badly wrong:** Firebase is still alive at this point —
nothing has been deleted. You can switch the apps back to the old setup; the
devices still have their local data. That's exactly why we don't turn Firebase
off until much later (Step 5).

---

## Step 5 — Turn Firebase off ("decommission")

**Only do this after the new system has run smoothly in production for at least
a week.** No rush. Firebase being on a bit longer costs little; turning it off
too early is dangerous.

1. In the Firebase console, check the Usage page — confirm basically no traffic
   is hitting Firebase anymore.
2. Revoke (delete) the service-account key you used for the export, so the
   robot password no longer works.
3. Remove any Firebase passwords / settings from servers, CI, and developer
   machines. (The app code itself is already clean — no Firebase left in it.)
4. In the Firebase console, disable then delete the project. Export the
   billing history first if finance needs it.
5. Securely delete `export.json` and the dump script from your machine — they
   contain customer data.
6. Delete the service-account JSON from any password manager / vault.

When this is done: the app runs entirely on the new system, and Firebase is
gone. The whole re-platform is complete.

---

## The 4 things most likely to bite you

1. **Staff can't log in** after cutover because old accounts have no password.
   This is expected — re-provision them (Step 4.6). Tell staff in advance.
2. **Numbers don't match in the dry-run.** Usually a field-name mismatch
   between the old data and the new tool. The dry-run (Step 2) exists to catch
   this *before* production. Never skip it. Get a developer if money is off.
3. **Forgot to drain the outboxes** (Step 4.2). Offline sales on devices are
   silently lost. Always confirm 0 pending on every device.
4. **Export script runs out of memory** on a huge `orders` collection. Find
   this out early in Step 1, not on cutover night.

---

## Quick reference (just the commands)

```bash
# Step 1 — export from Firebase
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
node dump-firestore.mjs > export.json

# Step 2 — practice run (safe, undoes itself)
cd backend
docker compose up -d
export DATABASE_URL="postgres://mandalika:mandalika@localhost:5433/mandalika_pos?sslmode=disable"
go run ./cmd/migrate-firestore --input ../export.json --dry-run

# Step 4 — the real run (only during the maintenance window)
go run ./cmd/migrate-firestore --input export.json
```
