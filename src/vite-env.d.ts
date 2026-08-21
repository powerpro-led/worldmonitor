/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_WS_API_URL?: string;
  // Synthesized at build time from the server-side APP_DOMAIN env var — see
  // vite.config.ts's `define` block and shared/domain-config.js.
  readonly VITE_APP_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
