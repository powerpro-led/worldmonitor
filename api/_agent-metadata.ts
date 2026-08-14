/**
 * Shared helpers for the host-derived agent-readiness discovery documents:
 * the RFC 9728 protected-resource metadata (`oauth-protected-resource.ts`) and
 * the RFC 8414 authorization-server metadata (`oauth-authorization-server.ts`).
 *
 * Both derive their `resource`/`issuer` + endpoint origin from the request Host
 * so PRM and AS metadata stay self-consistent per host (apex, www, api, variant
 * subdomains). The Host header is client-controlled, so `resolveMetadataOrigin`
 * validates it against the configured APP_DOMAIN apex + single-level subdomain
 * allowlist and falls back to the apex for anything else. Without this, a
 * spoofed `Host: evil.com` would be reflected into `issuer`/`token_endpoint` —
 * metadata a non-Host-aware downstream cache could serve to an agent, pointing
 * its token exchange at an attacker origin.
 */
import { normalizeDomain, resolveAppOrigin } from '../shared/domain-config.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveMetadataOrigin(req: Request): string {
  const domain = normalizeDomain(process.env.APP_DOMAIN);
  // apex + exactly one DNS label (www, api, tech, finance, …). Rejects
  // `evil.com`, `<domain>.evil.com`, `evil<domain>`, and any host carrying a port.
  const allowedHost = new RegExp(`^(?:[a-z0-9-]+\\.)?${escapeRegExp(domain)}$`);
  const fallbackOrigin = resolveAppOrigin(process.env.APP_DOMAIN);
  const url = new URL(req.url);
  const host = (req.headers.get('host') ?? url.host).toLowerCase();
  return allowedHost.test(host) ? `https://${host}` : fallbackOrigin;
}

/**
 * These documents are read-only. Answer CORS preflights, allow GET/HEAD, and
 * reject everything else with a spec-correct 405 + Allow. Returns null when the
 * request should proceed to the metadata handler.
 */
export function guardMetadataMethod(req: Request): Response | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' },
    });
  }
  return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, HEAD, OPTIONS' } });
}
