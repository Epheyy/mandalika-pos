# SP-CRM-5b — POS Segment Display (Design)

Date: 2026-06-08 · Branch: `prod-hardening` · Module: Customers (Pelanggan) / CRM · **POS + APK**

## Context

SP-CRM-5a (rev `00053-ckl`, migrations →0029) shipped the configurable segment engine: segment
rules are stored + editable, the segment is computed server-side, and `customer.segment`
(`{id,name,color}` or null) is already emitted on the **POS-facing reads** (`/sync/customers/lookup`
+ the sync bootstrap). The backoffice already swapped its tier column/badge for the segment. The POS
cashier still shows the old spend-tier via `getCustomerTier(totalSpent)`
(`apps/pos/src/cashier/pricing.ts`), displayed in `CustomerPicker.tsx`.

SP-CRM-5b is the POS half: show the **segment** in the cashier picker instead of the spend-tier,
retire `getCustomerTier`, and remove the now-orphaned "Sistem Tier" toggle from the backoffice
Loyalitas settings. Because the segment is already on the reads, **there is no backend, migration,
OpenAPI, or TS-client change** — this is a pure frontend (backoffice settings) + POS (APK) sprint.

**Verified facts (grounding):**
- `getCustomerTier(spent)` (`pricing.ts:166`) is the hardcoded spend ladder; used by `CustomerPicker`
  for the selected customer and the dropdown rows, gated by the `loyaltyEnabled` prop
  (`loyalty.enabled`), NOT `tierEnabled`.
- `tierEnabled` is now **orphaned**: it only ever gated the backoffice tier column (removed in 5a);
  the POS tier was gated by `loyaltyEnabled`. (User decision: drop the toggle.)
- The POS `Customer` type (`components['schemas']['Customer']`) now carries `segment` (from 5a's
  shared `customerObj`), so the picker can read `customer.segment` directly.

## Goals

1. POS cashier `CustomerPicker` shows the customer's **segment** (selected-customer line + dropdown
   rows), as a small colored chip, **decoupled from `loyaltyEnabled`** (segment is RFM, not loyalty).
2. Retire `getCustomerTier` from the POS.
3. Remove the orphaned "Sistem Tier" toggle from the backoffice Loyalitas settings.

## Non-goals

- Any backend / migration / OpenAPI / TS-client change (segment already on the reads).
- The loyalty **points** system (`loyaltyEnabled` and the points/conditions UI stay as-is).
- Removing the `tierEnabled` field from the schema (left as a harmless vestigial — no migration churn;
  a later cleanup can drop it).
- SP-CRM-6 (lifecycle/interaction log), SP-CRM-7 (points ledger), SP-CRM-Merge.

## Key decisions (locked with the user)

| Decision | Choice | Rationale |
|---|---|---|
| `tierEnabled` toggle | **Drop** the "Sistem Tier" UI toggle; segments always shown | It's orphaned post-5a; per-segment `is_active` already gives granular control. |
| `tierEnabled` field | **Leave** as a vestigial schema field (no migration) | Avoids loyalty-schema churn; cleanup later if desired. |
| POS segment display | **Small colored chip** (name + color), decoupled from `loyaltyEnabled` | Color conveys at-a-glance standing (red=Hilang, green=Setia); segment ≠ loyalty. Points stays gated by `loyaltyEnabled`. |
| POS color map | A tiny POS-side token→class map (mirrors backoffice `tagColors`) | The POS and backoffice don't share a UI lib; ~8 lines is acceptable. |
| Surface | POS cashier picker only; backoffice settings toggle removal | The detail/list already show segments (5a). |

## POS changes (`apps/pos/src/cashier/`) — reaches devices via APK

### `segmentColors.ts` (new, small)
A token→Tailwind-class map for the 8 palette tokens (amber/blue/green/red/purple/gray/pink/teal) +
a `segmentChipClasses(color)` helper with a gray fallback — mirrors
`apps/backoffice/src/screens/customers/tagColors.ts`. (Kept POS-local; the apps don't share a UI lib.)

### `CustomerPicker.tsx`
- **Selected customer view:** today the tier shows inside the `{loyaltyEnabled && (...)}` block as
  `· {getCustomerTier(totalSpent)} · {points} poin`. Pull the segment OUT of that block: render
  `selectedCustomer.segment` as a small colored chip (when present) regardless of `loyaltyEnabled`;
  keep `· {points} poin` gated by `loyaltyEnabled`.
- **Dropdown rows:** replace `{loyaltyEnabled && ` · ${getCustomerTier(c.totalSpent)}`}` with a small
  segment chip / `· {c.segment.name}` shown when `c.segment` is present (independent of `loyaltyEnabled`).
- Remove the `getCustomerTier` import.

### `pricing.ts`
- Remove the `getCustomerTier` function (verify no other importers first; the picker is the only one).

## Backoffice change (`apps/backoffice/src/screens/Customers.tsx`) — push/Cloudflare, no APK

- Remove the **"Sistem Tier"** toggle block from the Loyalitas → Pengaturan Umum settings card and
  drop the "tier ON/OFF" mention from the status line. Leave `DEFAULT_LOYALTY.tierEnabled` and the
  `loyaltyForm.tierEnabled` field intact (the save still sends it; backend accepts it; vestigial). Do
  NOT touch the points (`enabled`) toggle, `pointsPerThousand`, `redemptionRate`, or the Kondisi
  (conditions) UI.

## Rollout

1. Push `prod-hardening` → Cloudflare auto-builds the backoffice (the toggle removal lands immediately;
   harmless even before the APK).
2. **APK** (user-gated): dispatch `android-release.yml` (gh CLI not installed locally → Actions UI or
   REST with the git credential-manager token). Install + on-device check, then fleet rollout. Old
   devices keep showing the spend-tier until updated — acceptable (cosmetic), no data impact.

## Testing & verification

- **Build gates:** `apps/pos` `tsc -b` + `vite build`; `apps/backoffice` `tsc -b` + `vite build`. No
  backend gates (nothing backend changed); no `make gen-check` (no openapi change).
- **APK + on-device (user-gated):** new APK — attach a customer in the cashier flow → the picker shows
  the **segment chip** (e.g. "Juara"/"Berisiko"); confirm no tier text remains; points still shows only
  when the loyalty points system is on.
- **No backend live-check** — segment-on-the-POS-reads was already verified in SP-CRM-5a (18/18). I can
  optionally re-confirm `/sync/customers/lookup` returns `segment` (one authed call) but it's unchanged.
- **Visual (backoffice, user-pending):** the Loyalitas settings no longer show "Sistem Tier".

## Risks & mitigations

- **APK + on-device verification required** — the only way the POS change reaches devices; the cashier
  picker behavior can't be fully proven without a device.
- **Vestigial `tierEnabled` field** stays in the loyalty schema/payload (unused) — flagged; a future
  cleanup can remove it from the schema + a migration if desired.
- **Small POS color map duplicates the backoffice palette tokens** — acceptable (no shared UI lib);
  keep the token list in sync with `tagColors.ts` (same 8 tokens the backend validates).
- During APK rollout, not-yet-updated devices show the old spend-tier — cosmetic, no degradation.

## Files touched (anticipated)

- `apps/pos/src/cashier/segmentColors.ts` (new — palette → chip classes)
- `apps/pos/src/cashier/CustomerPicker.tsx` (segment chip; drop getCustomerTier import)
- `apps/pos/src/cashier/pricing.ts` (remove `getCustomerTier`)
- `apps/backoffice/src/screens/Customers.tsx` (remove the "Sistem Tier" toggle + status mention)
- (no backend, no `packages/`, no migration, no openapi)
