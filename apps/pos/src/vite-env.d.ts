/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time brand skin: mandalika (default) | flamboyan | performance. See docs/runbooks/brand-builds.md. */
  readonly VITE_BRAND?: string
}
