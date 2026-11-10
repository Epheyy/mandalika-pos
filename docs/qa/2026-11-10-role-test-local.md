# Role test on a local copy (2026-11-10)

**Owner request:** "for role testing i authorize you to create one test account for each roles", then "Yes, local copy".

Claude cannot create accounts or sign in with passwords on the deployed backend (`run.app`, `pages.dev`: not test-labelled hosts), so the test ran on a local copy.

## Setup

- **Code:** `origin/prod-hardening` at `fe40c69c`.
- **Database:** Postgres and Redis from `backend/docker-compose.yml`, run as compose project `roletest`, so it is a fresh volume; the older `backend` volume was stopped, not wiped.
- **Seed:** `go run ./cmd/seed`, plus `backend/sample_seed.sql`, which provides outlet A ("Mandalika Coffee — Pusat") and a small catalogue.
- **Servers:** backend `:8080`, Backoffice `:5174`, POS `:5173` (web build).
- **Accounts**, created through the admin API. Passwords live only in the gitignored `backend/.env` of that worktree.

  | Account | Role | Permissions | Outlet |
  |---|---|---|---|
  | `admin@mandalika.local` | admin | none (admin bypass) | — |
  | `manager.uji@mandalika.local` | manager | all 14 offered in the Backoffice picker | A |
  | `supervisor.uji@mandalika.local` | manager | custom role "Supervisor Uji": view_dashboard, view_transactions, view_reports, process_refund | A |
  | `kasir.uji@mandalika.local` | cashier | none | A |

- **Extras:** a second outlet, "Outlet Uji B", plus one fixture order per outlet: `UJI-A-1` (Rp 10.000) and `UJI-B-1` (Rp 77.000).

## Passed

- **API matrix, 28 checks, 0 mismatches:**
  - Admin-only routes (`/users`, `/custom-roles`, `/error-logs`, `/admin/erp/*`) refuse manager, supervisor and cashier with 403.
  - Each permission-gated route opens only for holders: products, customers, promotions, outlets, inventory, settings, OTA publish, requisitions, stock counts, sync review, reports, refunds.
  - The cashier is refused on every gated route.
- **Outlet isolation:** for manager, supervisor and cashier of outlet A:
  - `X-Outlet-Id: <outlet B>` → 403.
  - `GET /orders?outletId=all` returns only `UJI-A-1`.
  - `GET /orders/<UJI-B-1>` → 404.
- **Backoffice:**
  - The cashier is refused at sign-in.
  - The supervisor sees only Ringkasan and Laporan. Its dashboard counts only outlet A (Rp 10.000).
  - Deep links to Produk, Pengguna, Pengaturan, Inventori, Pelanggan and Log Kesalahan show "Akses tidak diizinkan".
  - The manager sees every screen except Log Kesalahan and Integrasi ERP.
- **POS:**
  - The cashier sees "Butuh izin refund" on History instead of a refund action. "Permintaan Barang" is absent, and the terminal outlet is locked.
  - The supervisor gets the refund path, held only by "Buka shift dulu".

## Findings (owner decision or fix)

1. **MEDIUM:** a manager of outlet A with `manage_outlets` can edit outlet B's details. `PUT /outlets/{B}` → 200; the name change was reverted afterwards.
   - Outlet B's giveaway settings are refused (403), so outlet scoping is inconsistent.
   - Decide whether `manage_outlets` is head-office only. If it is, grant it only to head-office users, or scope `PUT /outlets/{id}` to the caller's outlet.
2. **MEDIUM:** a removed permission keeps working until the access token expires (`JWT_ACCESS_TTL_MIN`, default 15 minutes).
   - Measured: an old token still read `/reports/summary` after `view_reports` was removed; a fresh login was refused at once.
   - The same mechanism applies to a deleted user's live token; that case was not tested.
   - Options: a shorter TTL; a revocation check in Redis; re-reading permissions per request.
3. **LOW:** "Pengguna" shows for a manager with `manage_users`, but the server allows only admin.
   - The screen opens with "Gagal memuat pengguna. insufficient role" (raw English) and a "Tambah" button that cannot work.
   - Either hide Pengguna from non-admins or let `manage_users` holders use `/users`.
4. **LOW (decision):** Backoffice refunds are admin-only (`Orders.tsx:128`), even though the API accepts `process_refund` holders. Managers can refund only on the POS. Decide whether the Backoffice should follow `process_refund`.
5. **LOW (by design, noted):** any signed-in role, including a cashier token, can read its own outlet's data through the API, though the Backoffice never shows a cashier these screens. This covers:
   - dashboard figures (`/reports/dashboard?trend=day`, deliberately auth-only per `server.go`)
   - orders, app settings, shifts, stock counts, cash flows and discount codes
6. **LOW (copy):** the Backoffice cashier refusal is in English: "This account is a cashier. Use the POS app to sign in."
7. **Noted from code, not tested:** custom roles are templates. The user table has no link to a custom role, so editing a role later does not change the users who were given it.

## Not covered

- The real tablet with a cashier login, which needs the owner to create the account live and sign in.
- The manager account on the POS.
- Receive-approval PIN roles.
- Actually executing refunds, shift closes and cash movements per role. Their gates were checked; the actions were not run.
- Load.
