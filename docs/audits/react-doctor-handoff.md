# React Doctor cleanup — session handoff

**Status: 587 → 233 → 143 issues** (score 41 → improving). Branch `prod-hardening`. Both apps `tsc -b` green after every commit. Nothing pushed.

This session cleared all the **safe, auto-verifiable mechanical** work (errors, dead code, keys, loop perf, React-19 migration, lazy-init). What remains is **judgment-heavy / architectural** and is kept separate on purpose: those edits are not auto-verifiable and several need on-device testing, so they shouldn't be rushed at the tail of a long context.

## How to work (proven loop)
1. `npx react-doctor@latest --json --scope full --yes > rd-scan.json` → structured diagnostics (fields: `filePath`, `plugin`, `rule`, `severity`, `message`, `line`, `column`). `filePath` is `src/...` and **app-ambiguous** (both apps have e.g. `src/App.tsx`, `src/auth.tsx`); resolve with `ls apps/*/src/<path>` or grep. **Delete `rd-scan.json` when done — it's untracked repo-root noise.**
   - Group by rule/file with a tiny node script over the JSON (see git history of this file / prior commands).
2. Per rule, fetch the canonical recipe (network needs `dangerouslyDisableSandbox: true`, **retry 2-3× — connection resets are common**, and many newer rules 404 = engine prompt table lags them, fall back to judgment):
   `curl --fail --silent -H 'Cache-Control: no-cache' https://www.react.doctor/prompts/rules/<plugin>/<rule>.md`
   Always read the **Validation prompt** (false-positive checks) before fixing.
3. Delegate bulk/mechanical reads to **subagents** (file-scoped, one owner per file → no write collisions). Subagents skip per-fix typecheck; the parent runs `tsc -b` in BOTH `apps/backoffice` and `apps/pos` after the fan-out, then re-scans and diffs counts.
4. Commit per rule-cluster with a conventional message; stage `apps/` only (`.claude/` is gitignored).

## Gotchas learned
- **Phantom findings:** `control-has-associated-label ×2` (`SettingsScreen.tsx`) are stale offsets — every control there is labelled. Ignore.
- **Dynamic `htmlFor`/`id`:** oxlint's `control-has-associated-label` can't match template-literal id pairs; KEEP an `aria-label` alongside list-rendered inputs.
- **`role="button"` vs `prefer-tag-over-role`:** for rows with nested interactive children a native `<button>` is illegal, so `role="button"` is correct and `prefer-tag-over-role` is a **false positive** there (×7, mostly these).
- **Cost hook:** ECC `ecc-context-monitor` COST warnings are API-list-price math, meaningless on the flat plan. Silenced via `.claude/settings.local.json` env `ECC_CONTEXT_MONITOR_COST_WARNINGS=0`.

## Done — session 2 (commits, newest first; all on `prod-hardening`, unpushed)
- `639eef5` perf: lazy-init 5 POS card settings from localStorage (no-initialize-state ×5, drop mount effect) + hoist surat-jalan `Th` style (no-inline-exhaustive-style ×2)
- `a2136ba` refactor: migrate `useContext` → React 19 `use()` across 9 files (no-react19-deprecated-apis ×9); both apps on react 19.2.6
- `7ad6b0c` perf: single-pass `flatMap` loops + precomputed lookup Maps (js-combine-iterations / js-flatmap-filter / js-index-maps / js-set-map-lookups; ~17). `Products` `key.indexOf('|')` left as FP (string search, not array membership)
- `13715b8` fix: replace array-index keys with stable ids (no-array-index-as-key ×18); editable ingredient rows got a `makeRow()`/`rowId` factory
- `7c0d6f7` refactor: remove 4 dead files + needless exports (unused-export/file); capacitor deps + `gen-source.cjs` left as FPs
- `57b3494` fix: mount Modal/ShiftRecap body on open (no-adjust-state-on-prop-change — the only ERROR rule; the 7 real instances). Cleared incidental no-chain/no-cascading too.

### Confirmed false positives (do NOT "fix" — verified this session)
- **`no-adjust-state-on-prop-change ×6`** — pure async data-fetch effects (`api.get…().then(setState)`): `MergeReview`, `DeleteIngredientModal`, `IngredientAdjustModal`, `IngredientGoodsInModal`. Legit per the rule's own validation prompt.
- **`deslop/unused-dependency ×5`** — `@capacitor/android|ios|preferences|status-bar`, `@capacitor-community/bluetooth-le`. Native packages auto-registered into the Android APK build (confirmed `apps/pos/capacitor.config.ts` + `android/`). Removing breaks the APK.
- **`deslop/unused-file ×1`** — `apps/pos/assets/gen-source.cjs`. Manual build/asset script (referenced in `NATIVE.md` / `STORE_LISTING.md`), intentionally not an app entry point.
- **`js-set-map-lookups ×1`** — `Products.tsx` `key.indexOf('|')` is a string-separator search, not array membership.
- **`prefer-tag-over-role ×7`** — see Gotchas (rows with nested interactive children).
- **`control-has-associated-label ×2`** — phantom (see Gotchas).
- Likely FP: **`rendering-hydration-mismatch-time ×1`** (`ShiftRecapPanel` `new Date()` in JSX) — Vite SPA, no SSR, so no hydration. Verify there's no SSR path, then ignore (or hoist `new Date()` out of render for purity).

## Remaining 143 — all judgment-heavy / architectural

### Suggested order
1. **Dialog migration (architectural a11y pass).** `click-events-have-key-events ×10` + `no-static-element-interactions ×10` (co-located, same lines) + `prefer-html-dialog ×1`. All are **dismiss-on-backdrop overlays**: App sidebar (`App.tsx:133`), `ui/Modal.tsx:60` & `:96`, POS `CheckoutPanel:452`, `MenuDrawer:137`, `ProductGrid:363` (variant popup), `ShiftBar:99`, `TransferHistoryPanel:49`, `SyncStatus:83`, backoffice `RecipeSlideOver:45`. Correct fix = migrate to `<dialog>` / proper dialog semantics + Escape handling, NOT `role=button` on a backdrop (that trips `prefer-tag-over-role`). Do as ONE coherent pass. **POS checkout/cashier modals are a money path → on-device test focus/dismiss after.** `ui/Modal.tsx` is shared — fix it once and most of the rest may follow.
2. **Effect-family ("you might not need an effect").** `no-cascading-set-state ×11`, `no-chain-state-updates ×9`, `no-event-handler ×5` (SettingsScreen:92, IngredientAdjust/GoodsIn modals, MovementSummary:77, SyncStatus:43 — "fake event handler via state+effect"), plus singletons `no-derived-state`, `no-derived-state-effect`, `prefer-use-effect-event`. Each needs per-site reasoning; verify behavior. Move logic into handlers / derive during render.
3. **`async-await-in-loop ×7` + `async-parallel ×1` — DEFERRED, handle with care.** Parallelizing API calls in inventory/money paths is risky given the known **Neon free-tier connection limits** (see project memory `neon-stale-connection-transient`). Sites: `Products.tsx` (4: ~192/368/398/430 — bulk create/import), `Users.tsx:116` (CSV import), `ingredients/DaftarTab.tsx` (122/175 — category refetch in loop), `TransferTab.tsx:300` (async-parallel). Per-site: ONLY parallelize genuinely-independent reads; leave ordered/rate-limited writes sequential. Likely several stay as-is.
4. **Visual a11y (needs design eyeballs).** `no-gray-on-colored-background ×5`, `no-tiny-text ×2`, `no-autofocus ×2`. Contrast / font-size / autofocus — judgment + design review.
5. **Rerender micro-opts (per-site, low value).** `rerender-state-only-in-handlers ×4`, `jsx-no-jsx-as-prop ×1` (OutletFormModal:132), `jsx-no-new-function-as-prop ×1` (ProductGrid:353), `rerender-memo-with-default-value ×1` (ReceiveTransferPanel:44), `rerender-lazy-ref-init ×1` (printer.tsx:55 — `useRef(createTransport())`; skipped this session because the lazy-ref null pattern would force 7 non-null assertions), `prefer-dynamic-import ×1` (Dashboard recharts → React.lazy + Suspense, decent bundle win).
6. **Largest, most design-sensitive — do LAST, component-by-component:**
   - **`prefer-useReducer ×32`** — consolidate many related `useState` into reducers per component.
   - **`no-giant-component ×13`** — split large components. High blast radius; pure refactor.
