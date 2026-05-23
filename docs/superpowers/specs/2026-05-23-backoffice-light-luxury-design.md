# Backoffice Light-Luxury Polish — Design Spec

Date: 2026-05-23 · Branch: `prod-hardening` · App: `apps/backoffice`

## Goal
Give the live backoffice a deliberate **light-luxury** identity that matches the
Mandalika perfume brand and the POS, and eliminate the component drift (42
hand-rolled buttons across 10 screens; ~319 ad-hoc color/radius usages) by
moving every screen onto a shared primitives layer.

## Decisions (approved)
- **Direction:** light luxury reskin (warm neutrals + gold accent), applied across all 11 screens.
- **Warm canvas:** move off the cool `gray-*` ramp to a warm neutral ramp (paper canvas, white cards, gold accent).
- **Semantic-only colors:** color carries meaning, not decoration. Gold = primary/brand. Green = success/active. Red = destructive. Amber = warning (sparingly). No more green/blue/red buttons used decoratively.
- **Rollout:** foundation first, then migrate screen-by-screen, deploying after each batch (full deploy loop) so the look can be steered on the live site.

## Foundation

### 1. Tokens (`apps/backoffice/src/index.css`, Tailwind v4 `@theme`)
- **Keep** the existing `indigo-*` → gold override (legacy/un-migrated markup stays gold during migration).
- **Add** `gold-*` semantic alias (same hex as the gold override) for clear naming in new code.
- **Remap** the `gray-*` ramp to a refined warm-neutral ramp — this warms every existing `bg-gray-50` / `text-gray-900` / `border-gray-100` app-wide with near-zero risk (same trick the POS used for indigo→gold). Cards stay `bg-white` (white-on-warm-canvas reads luxury).
- **Add** harmonized semantic state colors: `success` (muted green), `danger` (warm red), `info`/`warning` (amber).
- Standardize one radius scale (cards `rounded-2xl`, controls `rounded-xl`, pills `rounded-lg`) and a small shadow scale.

### 2. Data-viz palette (`apps/backoffice/src/ui/chartColors.ts`)
Gold-forward sequential ramp (deep bronze → champagne) replacing `#6366f1`/violet/blue/sky in Dashboard/Reports charts and stat cards.

### 3. Primitives library (`apps/backoffice/src/ui/`)
One barrel `ui/index.ts`. Each primitive is small, single-purpose, typed:
- `Button` — variants `primary|secondary|ghost|danger`, sizes `sm|md`, `loading`, `icon`. Collapses the 42 ad-hoc buttons.
- `Input` / `Select` / `Textarea` — accept `label`, `hint`, `error`; one field style everywhere.
- `Modal` — overlay + panel + header (title/subtitle/close) + body + optional footer; sizes `sm|md|lg`.
- `Card` — white rounded-2xl warm-bordered surface.
- `Badge` — tones `gold|success|danger|neutral`.
- `IconButton` — square ghost action (edit/delete).
- `EmptyState` — icon + title + optional subtitle (the repeated "Belum ada…" block).
- `PageHeader` — title + subtitle + actions row.
- `Tabs` — segmented control (Users users/roles, etc.).

## Migration order
1. **Foundation** (tokens + `ui/`) + **App shell** (sidebar/header warm pass) + **Dashboard** (flagship) → deploy, review on live site.
2. Products · Orders · Users · Outlets.
3. Customers · Promotions · Reports · StockCount · Settings · ErrorLogs.

Each screen: replace ad-hoc buttons/fields/modals/empty-states with primitives; remove decorative non-semantic colors; fix any hardcoded indigo-blue hex.

## Constraints
- Live, selling app — keep changes reviewable, deploy in batches, no behavior changes.
- TS must stay green (`tsc -b`); Cloudflare auto-deploys on push to `prod-hardening`.
- No new heavy deps; primitives are plain React + Tailwind.
