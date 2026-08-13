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
