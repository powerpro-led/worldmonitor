export const DEFAULT_APP_DOMAIN: string;

export function normalizeDomain(rawDomain: string | undefined | null): string;
export function isLocalDomain(rawDomain: string | undefined | null): boolean;
export function resolveProtocol(rawDomain: string | undefined | null): 'http' | 'https';
export function resolveAppOrigin(rawDomain: string | undefined | null): string;
export function resolveWwwOrigin(rawDomain: string | undefined | null): string;
export function resolveApiOrigin(rawDomain: string | undefined | null): string;
export function resolveCookieDomain(rawDomain: string | undefined | null): string | null;
export function buildDomainOriginPattern(rawDomain: string | undefined | null): RegExp | null;

export const TAURI_ORIGIN_PATTERNS: readonly RegExp[];
export const DEV_LOCALHOST_ORIGIN_PATTERNS: readonly RegExp[];

export function buildAllowedOriginPatterns(
  rawDomain: string | undefined | null,
  options?: { includeDevPatterns?: boolean; extraPatterns?: RegExp[] },
): RegExp[];

export const VARIANT_SLUGS: readonly ['tech', 'finance', 'commodity', 'happy', 'energy'];

export function resolveVariantDomain(rawDomain: string | undefined | null, slug: string): string;
export function resolveVariantOrigin(rawDomain: string | undefined | null, slug: string): string;
export function resolveVariantOrigins(rawDomain: string | undefined | null): Record<string, string>;
export function resolveAbacusOrigin(rawDomain: string | undefined | null): string;
export function resolveProxyOrigin(rawDomain: string | undefined | null): string;
export function resolveSubdomainOrigin(rawDomain: string | undefined | null, subdomain: string): string;

export function buildCspFrameSrcOrigins(rawDomain: string | undefined | null): string[];
export function buildCspFrameAncestorsOrigins(
  rawDomain: string | undefined | null,
  options?: { includeVariants?: boolean },
): string[];
export function buildCspFormActionOrigins(rawDomain: string | undefined | null): string[];
