# SP-Promo-4 — Promo Authoring UX (outlet selector + active hours) Design

**Date:** 2026-07-06
**Branch:** `prod-hardening`
**Status:** Design approved — ready for implementation plan
**Slice:** the LAST open item in the promotion module — the authoring/UX gap where `outlet_ids` and `active_from_hour`/`active_to_hour` are **enforced by the engine but not authorable in the backoffice form**. Backoffice-form-only.

---

## Context
The promo engine already enforces outlet scoping (`outlet_ids`) and active-hours (`active_from_hour`/`active_to_hour`, `"HH:MM"` string-compared to the current time), and both persist end-to-end (write.Promotion `OutletIDs`/`ActiveFromHour`/`ActiveToHour`, read json, OpenAPI Promotion/PromotionInput). The backoffice `PromoFormModal.tsx` already authors **active days** (chip toggles) but has **no outlet selector and no active-hours inputs** — so a promo can only be all-outlets/all-hours from the UI. The user explicitly flagged the missing outlet selector. This slice adds those two field groups + a trivial save guard + the edit-populate wiring. **No backend, no OpenAPI, no migration, no POS/APK** — everything downstream already works.

## Decisions (locked during brainstorm)
1. **Outlet selector = toggle-chip multi-select** (reuse the existing "Aktif Hari" day-chip pattern for consistency), from `api.listOutlets()`. Empty = all outlets (matches engine: empty `outlet_ids` = no filter).
2. **Active hours = two `<input type="time">`** (Dari / Sampai) writing `"HH:MM"`. Empty (both blank) = no hour gate.
3. **Skip** the advisory `bundlePrice`-below-anchor warning (rare, merchant-safe, fuzzy — YAGNI for this slice).
4. **Edit-populate** must carry `outletIds` + `activeFromHour` + `activeToHour` (closes a pre-existing bug: `openEditPromo` omits `outletIds`, so editing any scoped promo silently wipes its outlet scoping).
5. Backoffice-only; deploy via Cloudflare auto-deploy on push.

---

## 1. Outlet selector (`PromoFormModal.tsx`)
- Load outlets: `const outletsQ = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])` (or match how the modal already gets its `products`/data — reuse the existing loading mechanism/props if outlets are already passed in; otherwise add the query). `api.listOutlets()` returns `Outlet[]` directly.
- Render a `<Field label="Outlet (kosong = semua outlet)">` with a chip-toggle per outlet (mirror the active-days `toggleDay` chips at ~L336): `form.outletIds?.includes(o.id)` → active style; click toggles membership in `form.outletIds`.
- A `toggleOutlet(id)` handler mirroring `toggleDay`: add/remove `id` from `form.outletIds` immutably.
- Empty `outletIds` = all outlets (no special "all" chip needed; the empty state IS "all", per the label hint).
- Place it near the other scoping fields (after "Aktif Hari" / near dates), consistent with the form's layout.

## 2. Active hours (`PromoFormModal.tsx`)
- Two `<Input type="time">` in a row: `label="Jam Aktif Dari"` → `form.activeFromHour`, `label="Sampai"` → `form.activeToHour`. Value/onChange write the raw `"HH:MM"` string (empty string when cleared).
- Label the pair "Jam Aktif (kosong = sepanjang hari)".
- **Client validation before save:** if exactly one of from/to is set → error "Isi kedua jam aktif atau kosongkan keduanya." If both set and `from > to` → error "Jam mulai harus lebih awal dari jam selesai (rentang lewat tengah malam tidak didukung)." (The engine does a plain `hm < from || hm > to` string compare, so an overnight window from>to never fires — block it at authoring rather than create a dead promo.) Surface inline + block save, consistent with the existing `tieredError`/`bundleError` gating (extend the same save-`disabled` expression).

## 3. Save guard — `maxApplications ≥ 0`
- Add `min={0}` to the bxgy `Maks/transaksi` and bundle `Maks. kelipatan` number inputs, and include a check in the save-gate error (bxgy: `bxgyConfig.maxApplications < 0`; bundle: `bundleConfig.maxApplications < 0`) → inline error + block save. (Matches the backend `validateBundle`/`validateBXGY` `MaxApplications < 0` rejections, avoiding a needless 400.)

## 4. Edit-populate (`Promotions.tsx`)
- In `openEditPromo`, `dupPromo`, `togglePromo` (the three handlers that rebuild `PromotionInput` field-by-field), add `outletIds: p.outletIds ?? []`, `activeFromHour: p.activeFromHour ?? ''`, `activeToHour: p.activeToHour ?? ''`. `activeDays` is already carried; `outletIds`/hours are the gap. This closes the latent `openEditPromo`-drops-`outletIds` bug (editing a scoped promo would otherwise save it back as all-outlets).
- Verify the three handlers against the current code; carry the fields in each (the SP-Promo-3b gap-class lesson: the edit-form-populate path must carry every authored field).

## 5. Testing & verification
- Backoffice `corepack pnpm tsc --noEmit && corepack pnpm vite build` clean.
- No backend change → no Go tests, no e2e, no migration, no APK.
- **On-device/visual (USER-PENDING):** create a promo scoped to one outlet with 09:00–17:00 hours + specific days → save → reopen (outlet chips + hours + days all populate) → dup/toggle preserve them. The engine already enforces outlet/hours/days at checkout (proven in SP-Promo-1), so "authored → enforced" needs only the visual confirm that the fields persist + round-trip.
- **Live authed smoke (optional):** POST a promo with `outletIds`/`activeFromHour`/`activeToHour` → GET → round-trip (the API already round-trips these; low value since unchanged — the on-device edit-reopen check covers it).

## 6. Model routing & rollout
Sonnet implements (form field-adds + edit-populate + client validation); **Haiku** or a light **Sonnet** review (backoffice form, no correctness-critical surface — no engine/type-gen/money/stock). Deploy = push → Cloudflare backoffice auto-deploy. No backend redeploy, no APK.

## Out of scope / deferred
- The advisory `bundlePrice`-below-anchor warning (skipped).
- `combinableWith` allowlist authoring (the engine uses only the boolean `combinable`; the allowlist is unused — YAGNI).
- `applicableVariantSizes` authoring (legacy field; the variant picker already covers scoping via `applicableVariantKeys`).
- Overnight active-hours windows (from > to) — blocked at authoring; not supported by the engine.
- Any backend/OpenAPI/engine change (all already in place).
