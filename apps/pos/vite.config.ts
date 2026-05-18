import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite stamps `crossorigin` on the emitted module/css tags. Inside the
// Capacitor Android WebView (served from https://localhost by the local
// asset loader) that turns asset loads into CORS requests the loader does
// not answer, so the module is blocked and React never mounts — a silent
// white screen (release WebViews have console logging disabled). Stripping
// the attribute keeps it a normal same-origin fetch. Harmless on web.
function stripCrossorigin(): Plugin {
  return {
    name: 'strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(=("|')[^"']*\2)?/g, '')
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stripCrossorigin()],
  server: { port: 5173 },
})
