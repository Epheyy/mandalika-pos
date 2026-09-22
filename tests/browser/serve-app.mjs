// Test-only dev environment: no .env loading, provider URL or real login.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const app = process.argv[2]
if (!['pos', 'backoffice'].includes(app)) throw new Error('Unknown synthetic app')
const root = path.resolve(`apps/${app}`)
const require = createRequire(path.join(root, 'package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const port = app === 'pos' ? 5183 : 5184
const record = (event) => fs.appendFileSync(path.join(process.env.A34C_RUN_DIR, 'processes.jsonl'), JSON.stringify({ kind: 'vite', app, pid: process.pid, port, event }) + '\n')
record('starting')
const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), envDir: false,
  plugins: [{
    name: 'synthetic-brand-image', enforce: 'pre',
    transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/backoffice/src/lib/brand.ts')) {
        // Replace only this decorative remote asset in the test server. Runtime
        // authoring/pricing/auth modules and the production source are unchanged.
        return code.replace('https://mandalikaperfume.co.id/wp-content/uploads/2025/02/GOLD-Tanpa-Text-Bawah.png',
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E')
      }
    },
  }],
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:59999') },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
})
await server.listen()
record('listening')
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  await server.close(); record('closed'); process.exit(0)
})
