# Mandalika POS â€” development and production-readiness planning

This project is in development/polishing, not declared production-ready.
Start with [MASTER_AUDIT_HANDOFF.md](MASTER_AUDIT_HANDOFF.md), the current
[readiness plan](docs/PRODUCTION_READINESS_PLAN.md)
and [canonical A01â€“A44 tracker](docs/AUDIT_COVERAGE_TRACKER.md).
Use [CHATGPT_CODEX_WORKFLOW.md](CHATGPT_CODEX_WORKFLOW.md) for review/execution.
Legacy deployment notes and phase completion claims are historical evidence;
they do not close current audit findings or grant deployment authority.

## Deterministic JS/TS quality gate

Use the repository's Node22 CI line and pnpm9.15.0 (declared in packageManager):

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
corepack pnpm quality:ci
```

This installs the frozen lockfile, runs POS/Backoffice/sync/printer tests,
checks all six packages' source types plus excluded app tests/browser harnesses,
builds both apps and verifies TypeScript OpenAPI regeneration. `gen:check` compares
against the current schema and restores its original bytes, so dirty local source
is supported without comparing unrelated changes to HEAD. `quality` runs the same
checks after installation; `quality:ci` is the canonical fresh-checkout entry point.

`.github/workflows/quality.yml` runs on PRs/pushes and is reused by Android release.
Signing waits for quality, backend, PostgreSQL and browser gates at the same
caller SHA; no signing secrets are forwarded to these jobs. React Doctor remains separate and advisory. This baseline does not run
opt-in PostgreSQL or browser scenarios, qualify native/OTA artifacts, configure
branch protection or close the wider production-release gates. See the canonical
A34 tracker entry for remaining work.

## Original scaffold notes (historical)

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
