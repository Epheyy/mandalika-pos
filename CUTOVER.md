# Phase F — Firestore → Postgres Cutover Runbook

Final phase of the re-platform (`.claude/plans/so-this-entire-thing-mellow-lake.md`).
Goal: production on Go/Postgres, Firebase decommissioned.

The app code is already Firebase-free (Phase D removed every import). Phase F
moves the **data** and retires the Firebase **project + credentials**.

---

## 0. Tooling delivered

- `backend/cmd/migrate-firestore` — idempotent loader: Firestore JSON export →
  Postgres, one transaction, `--dry-run` rolls back.
- `backend/internal/fsmigrate` — collection→table map (plan §2), deterministic
  UUIDv5 ids (cross-doc FKs resolve, re-runnable), parity + spot-check report.

Collection → table map:

| Firestore collection | Postgres table(s) |
|----------------------|-------------------|
| `outlets` | `outlets` |
| `categories` | `categories` |
| `products` (+`variants[]`) | `products`, `product_variants` |
| `bundles` (+`items[]`) | `bundles`, `bundle_items` |
| `customers` | `customers` |
| `loyaltyConditions` | `loyalty_conditions` |
| `promotions` | `promotions` |
| `discountCodes` | `discount_codes` |
| `customRoles` | `custom_roles`, `custom_role_permissions` |
| `users` (+`permissions[]`) | `users`, `user_permissions` |
| `shifts` | `shifts` |
| `orders` (+`items[]`) | `orders`, `order_items` |
| `stockCounts` (+`items[]`) | `stock_counts`, `stock_count_items` |
| `cashFlows` | `cash_flows` |
| `syncLogs` | `sync_logs` |
| `devices` | `devices` |
| `appSettings` (singleton) | `app_settings` (id=1, UPDATE) |
| `loyaltySettings` (singleton) | `loyalty_settings` (id=1, UPDATE) |

---

## 1. Export from Firestore

Run once against the production Firebase project (Node + `firebase-admin`,
service-account key with Datastore read). Produces the single JSON the loader
expects: one key per collection (array of docs, each with its `id`), plus
`appSettings` / `loyaltySettings` singleton objects.

```js
// dump-firestore.mjs — node dump-firestore.mjs > export.json
import admin from 'firebase-admin'
import { readFileSync } from 'node:fs'

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))),
})
const db = admin.firestore()

const COLLECTIONS = [
  'outlets', 'categories', 'products', 'bundles', 'customers',
  'loyaltyConditions', 'promotions', 'discountCodes', 'customRoles',
  'users', 'shifts', 'orders', 'stockCounts', 'cashFlows', 'syncLogs',
  'devices',
]

const out = {}
for (const c of COLLECTIONS) {
  const snap = await db.collection(c).get()
  out[c] = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  process.stderr.write(`${c}: ${out[c].length}\n`)
}
// settings/* are single docs, not a collection
const app = await db.doc('settings/app').get()
const loyalty = await db.doc('settings/loyalty').get()
out.appSettings = app.exists ? app.data() : null
out.loyaltySettings = loyalty.exists ? loyalty.data() : null

process.stdout.write(JSON.stringify(out))
```

> Adjust collection names if production differs. Timestamps export as
> `{_seconds,_nanoseconds}`, ISO strings, or epoch numbers — the loader handles
> all three.

Keep `export.json` off git and delete it after cutover (contains PII).

---

## 2. Staging dry-run + parity

Bring up a clean staging Postgres (schema auto-migrates on connect):

```bash
cd backend
docker compose up -d
export DATABASE_URL="postgres://mandalika:mandalika@localhost:5433/mandalika_pos?sslmode=disable"

go run ./cmd/migrate-firestore --input ../export.json --dry-run
```

The report prints per-collection `rows` vs `input` (✓ / ⚠ mismatch) and
`SUM(orders.total)` / `SUM(shifts.total_sales)`.

**Parity gate (plan §11 cutover):**
1. Every collection: `rows == input` (✓). Investigate any ⚠.
2. `SUM(orders.total)` matches the Firestore figure (compute the same sum in
   the dump script and compare).
3. Spot-check 5–10 orders by `order_number`: items, totals, customer link.
4. Spot-check shift totals (`total_sales`, cash/card/transfer/qris split).
5. Read the warnings block — note the migrated-users password caveat (§4).

`--dry-run` rolls back, so iterate the export/script until parity is clean.

---

## 3. Offline-sync soak (plan §11)

Before production cutover, on staging (Go + migrated data):

1. POS app online → confirm reference snapshot pulls (products/customers/promos).
2. Kill network → take N orders + 1 refund + close shift (outbox queues).
3. Restore network → outbox flushes in order; server has exactly N orders
   (idempotency key dedupe); POS reconciles to canonical totals.
4. Backoffice edit a product → POS raises the sync wall → Resync clears it;
   queued sales still flush during the wall.
5. Kill the app mid-queue → relaunch → outbox survives, resumes.

All five are existing Phase C/E behaviors; this soak validates them against
**migrated** data, not synthetic seed.

---

## 4. Production cutover

Maintenance window (POS offline-tolerant, but freeze Backoffice writes):

1. Freeze Backoffice (no reference-data edits during the window).
2. Drain POS outboxes (every device "Sync now", confirm 0 pending).
3. Final Firestore export (step 1) — fresh, post-freeze.
4. Apply against production Postgres:
   ```bash
   go run ./cmd/migrate-firestore --input export.json   # no --dry-run
   ```
   Re-runnable: deterministic ids + `ON CONFLICT` → safe to repeat if it fails
   partway.
5. Verify parity report = clean; spot-check live via the Go API / Backoffice.
6. **Users:** migrated users carry an unusable password hash (Firebase auth was
   Google-popup, no passwords). Either keep the Phase A seeded admin and
   re-provision staff via Backoffice, or issue password resets. Communicate
   before the window.
7. Point production clients at the Go backend; smoke `login` + a sale + a
   report. Monitor.

Rollback: clients still have local snapshots; if the Go path fails, revert the
client config — Firebase is not yet decommissioned at this point (do §5 only
after a stable soak in production).

---

## 5. Decommission Firebase

After production is stable on Go/Postgres (recommend ≥1 week soak):

1. Confirm zero Firebase traffic (Firebase console → Usage).
2. Revoke/delete the `firebase-admin` service-account key used for export.
3. Remove Firebase env/secrets from CI, hosting, and developer machines —
   nothing in this repo still reads them (verified: `grep -ri firebase
   apps packages backend --include='*.ts' --include='*.go'` → none).
4. Firebase console → disable, then delete the project (export billing first).
5. Securely delete local `export.json` / dump artifacts (PII).
6. Remove the Firebase service-account JSON from any password manager / vault.

Exit criterion met: production on Go/Postgres, Firebase off.
