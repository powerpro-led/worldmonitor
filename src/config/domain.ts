/**
 * Single client-side entry point for domain-derived values in browser code.
 *
 * `shared/domain-config.js` deliberately reads no env vars itself — every
 * runtime passes in its own raw domain string. For the browser bundle,
 * that's `import.meta.env.VITE_APP_DOMAIN`, synthesized at build time from
 * the server-side `APP_DOMAIN` env var (see vite.config.ts's `define`
 * block). Reading it once here, instead of scattering
 * `import.meta.env.VITE_APP_DOMAIN` across every `src/` file that needs a
 * domain, keeps the sweep's completeness auditable: after migrating a file
 * off a hardcoded domain literal, it should import from here, not from
 * `shared/domain-config.js` directly.
 */
import {
  normalizeDomain,
  resolveAppOrigin,
  resolveWwwOrigin,
  resolveApiOrigin,
  resolveCookieDomain,
  resolveVariantOrigin,
  resolveVariantOrigins,
  resolveSubdomainOrigin,
  isLocalDomain,
  VARIANT_SLUGS,
} from '../../shared/domain-config.js';
import { resolveVariantMetaUrl } from './variant-meta';

// import.meta.env itself (not just the VITE_APP_DOMAIN key) can be undefined
// outside an actual Vite dev/build/vitest context — e.g. this module gets
// pulled in transitively when running node:test files via plain tsx. Same
// defensive pattern as services/runtime.ts's own ENV wrapper.
export const RAW_APP_DOMAIN: string | undefined = (() => {
  try {
    return import.meta.env.VITE_APP_DOMAIN;
  } catch {
    return undefined;
  }
})();

export const APP_DOMAIN = normalizeDomain(RAW_APP_DOMAIN);
export const IS_LOCAL_DOMAIN = isLocalDomain(RAW_APP_DOMAIN);
export const APP_ORIGIN = resolveAppOrigin(RAW_APP_DOMAIN);
export const WWW_ORIGIN = resolveWwwOrigin(RAW_APP_DOMAIN);
export const API_ORIGIN = resolveApiOrigin(RAW_APP_DOMAIN);
export const COOKIE_DOMAIN = resolveCookieDomain(RAW_APP_DOMAIN);
export const VARIANT_ORIGINS = resolveVariantOrigins(RAW_APP_DOMAIN);

export function getVariantOrigin(slug: string): string {
  return resolveVariantOrigin(RAW_APP_DOMAIN, slug);
}

export function getVariantMetaUrl(variant: string): string {
  return resolveVariantMetaUrl(RAW_APP_DOMAIN, variant);
}

export function getSubdomainOrigin(subdomain: string): string {
  return resolveSubdomainOrigin(RAW_APP_DOMAIN, subdomain);
}

export { VARIANT_SLUGS };
