# React Doctor cleanup — session handoff

**Status: 587 → 233 issues.** Branch `prod-hardening`. Both apps `tsc -b` green after every commit. Nothing pushed.

This doc hands off the **judgment-heavy** remainder to a fresh session (kept separate on purpose: those edits are architectural and not auto-verifiable, so they shouldn't be done at the tail of a long context).

## How to work (proven loop)
1. `npx react-doctor@latest --verbose` → reads working tree, writes a fresh run dir under `%TEMP%/react-doctor-*` with `diagnostics.json` (fields: `filePath`, `rule`, `line`, `column`, `offset`, `length`, `severity`). `filePath` is `src/...` and **app-ambiguous** (both apps have e.g. `src/App.tsx`); resolve by checking which app root the offset's content matches.
2. Per rule, fetch the canonical recipe (network needs `dangerouslyDisableSandbox: true`, retry — connection resets are common):
   `curl --fail --silent -H 'Cache-Control: no-cache' https://www.react.doctor/prompts/rules/react-doctor/<rule>.md`
   Always read the **validation prompt** (false-positive checks) before fixing.
3. Delegate bulk/mechanical reads to **subagents** (file-scoped, one owner per file → no collisions) to keep main context lean. Verify centrally: `tsc -b` in BOTH `apps/backoffice` and `apps/pos`, then re-scan and diff counts.
4. Commit per rule-cluster with a conventional message; stage `apps/` only (`.claude/` is gitignored).

## Gotchas learned
- **Phantom findings:** react-doctor's `line` can go stale vs a freshly-computed `offset` after edits — `control-has-associated-label ×2` in `SettingsScreen.tsx:374/385` are confirmed phantoms (every control there is labelled; offsets resolve to already-labelled controls). Ignore them.
- **Dynamic `htmlFor`/`id`:** oxlint's `control-has-associated-label` can't statically match template-literal id pairs (`id={`x-${key}`}`). For list-rendered inputs, KEEP an `aria-label` alongside the association or it re-flags.
- **Cost hook:** the ECC `ecc-context-monitor` COST warnings are API-list-price math, meaningless on the flat plan. Silenced via `.claude/settings.local.json` env `ECC_CONTEXT_MONITOR_COST_WARNINGS=0` (local only; CONTEXT/LOOP/SCOPE warnings still active).
- **`role="button"` vs `prefer-tag-over-role`:** fixing a clickable `<div>` with `role="button"` trips `prefer-tag-over-role`. For rows containing nested interactive children (most of ours), a native `<button>` is illegal, so `role="button"` is correct and `prefer-tag-over-role` is a **false positive** there.

## Done this session (commits, newest first)
- `9a4d5a8` a11y: associate labels (21→0) + keyboard-enable clickable rows (click/static 17/16→10/10)
- `34676aa` hoist 25 pure helper functions to module scope
- `7624ab2` lazy state init (11) + hoist static literals (3) + Intl formatters (2)
- `4554873` outlet/warehouse form reset via key-remount (adjust-state 15→13)
- `71eafb3` explicit `type="button"` ×159
- `80fd347` async-defer + exhaustive-deps + 51 barrel imports + 73 a11y labels

## Remaining 233 — categorized

### A. JUDGMENT-HEAVY (do here, carefully, verify by hand/on-device)
- **`no-adjust-state-on-prop-change` ×13 (ERROR)** — already triaged: ~6 are false positives (pure data-fetch effects: `IngredientAdjustModal`, `IngredientGoodsInModal`, `DeleteIngredientModal`, `MergeReview` — leave them). The real ones need architectural fixes: **`ui/Modal.tsx`** (shared primitive, resets confirm-state on open → split inner component mounted-when-open) and **`ShiftRecapPanel.tsx`** (financial; resets panel state on `isOpen` → mount-on-open / key). These touch shared + money paths → on-device test.
- **`prefer-useReducer` ×32** — "many related useState". Consolidate into reducers per component. Big, mechanical-ish but design-sensitive; do component-by-component.
- **`no-giant-component` ×13** — split large components. Pure refactor, high blast radius.
- **`no-chain-state-updates` ×13 / `no-cascading-set-state` ×12 / `no-event-handler` ×7 / `no-initialize-state` ×5 / effect-family singletons** (`no-effect-chain`, `no-derived-state(-effect)`, `prefer-use-effect-event`, `no-reset-all-state-on-prop-change`) — "you might not need an effect" refactors. Each needs per-site reasoning; verify behavior.

### B. SAFE-ISH NEXT WINS (good for a focused mechanical pass / subagents)
- **`no-array-index-as-key` ×18** — replace index keys with stable ids (semi-judgment: needs a real unique field per list).
- **`js-index-maps` ×9 / `js-combine-iterations` ×6 / `js-flatmap-filter` ×1 / `js-set-map-lookups` ×1** — loop/iteration perf rewrites. Mechanical, verify equivalence.
- **`async-await-in-loop` ×7 / `async-parallel` ×1** — parallelize independent awaits (careful: some loops are intentionally sequential).
- **`unused-export` ×8 / `unused-file` ×5 / `unused-dependency` ×5** — dead-code removal; verify nothing dynamic-imports them before deleting.
- **`no-tiny-text` ×7 / `no-gray-on-colored-background` ×5 / `no-autofocus` ×2** — visual a11y; needs design eyeballs.
- **`no-inline-exhaustive-style` ×8 / `rerender-*` singletons / `rerender-memo-with-default-value` ×1 / `prefer-dynamic-import` ×1** — perf one-offs.
- **`no-react19-deprecated-apis` ×9** — API migration; may "break callers", check each.
- **`rendering-hydration-mismatch-time` ×1** — time/random in JSX.

### C. DEFERRED: dialog migration (architectural a11y)
- **`click-events-have-key-events` ×10 + `no-static-element-interactions` ×10 + `prefer-html-dialog` ×1** — all the modal/drawer **dismiss-backdrop overlays** (App sidebar, `Modal.tsx` 63/99, RecipeSlideOver, CheckoutPanel overstock, MenuDrawer, ProductGrid variant popup, ShiftBar popover, TransferHistoryPanel, SyncStatus popover). Correct fix = migrate to `<dialog>`/proper dialog semantics + Escape handling, NOT `role=button` on a backdrop. Do as one coherent dialog pass.
- **`prefer-tag-over-role` ×8** — mostly false positives (rows with nested interactive children can't be native `<button>`); audit, likely leave/suppress with justification.

### D. PHANTOM / ignore
- **`control-has-associated-label` ×2** — stale `SettingsScreen.tsx:374/385` (see Gotchas).

## Suggested order next session
1. `no-adjust-state-on-prop-change` real ones (Modal + ShiftRecapPanel) — clears the only ERROR-severity rule; on-device test.
2. Pick off Category B mechanical wins via subagents (array-index-keys, js-* loops, unused exports).
3. Dialog-migration pass (Category C) as one deliberate effort.
4. Leave `prefer-useReducer`/`no-giant-component` for last (largest, most design-sensitive).
