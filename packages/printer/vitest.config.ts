import { defineConfig } from 'vitest/config'

// Golden tests format dates with toLocaleString, which follows the process timezone. Set it here, before any
// worker starts, so every worker inherits it (src/test/setupTz.ts asserts it took effect).
process.env.TZ = 'Asia/Jakarta'

export default defineConfig({
  test: { setupFiles: ['./src/test/setupTz.ts'] },
})
