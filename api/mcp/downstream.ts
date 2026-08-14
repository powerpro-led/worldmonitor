import { BillingDenialError, throwIfBillingDenial } from './billing-denial';
import { emitTelemetry } from './telemetry';
import type {
  McpAuthContext,
  McpToolExecutionContext,
} from './types';
import { resolveApiOrigin, resolveVariantDomain, normalizeDomain, VARIANT_SLUGS } from '../../shared/domain-config.js';

/**
 * The canonical MCP API origin — a function, not a module-level constant, so
 * it's recomputed per call and picks up APP_DOMAIN changes mid-process (e.g.
 * tests calling setTestAppDomain()), same reasoning as server/cors.ts.
 */
export function resolveMcpCanonicalApiOrigin(): string {
  return resolveApiOrigin(process.env.APP_DOMAIN);
}

function variantHosts(): ReadonlySet<string> {
  const domain = process.env.APP_DOMAIN;
  return new Set(VARIANT_SLUGS.map((slug) => resolveVariantDomain(domain, slug)));
}

const SAFE_GATEWAY_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_internal_mcp_signature',
  'internal_mcp_replay_cache_unavailable',
  'insufficient_entitlement',
  'entitlement_verification_unavailable',
  'subscription_lapsed',
  'renewal_verification_pending',
  'renewal_verification_failed',
  'payload_too_large',
  'rate_limited',
]);

const SAFE_GATEWAY_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['invalid api key', 'invalid_api_key'],
  ['invalid or expired session', 'invalid_session'],
  ['api access requires an active subscription', 'api_subscription_required'],
  ['pro subscription required', 'pro_subscription_required'],
  ['unable to verify api access', 'entitlement_verification_unavailable'],
  ['method not allowed', 'method_not_allowed'],
  ['configuration', 'configuration'],
]);

type ToolFetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
};

type DownstreamResponseMarker =
  | 'json'
  | 'html'
  | 'other'
  | 'json_error'
  | 'html_error'
  | 'empty_error'
  | 'method_not_allowed'
  | 'billing_verification';

export class ToolFetchError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly safeCode: string;
  readonly responseMarker: DownstreamResponseMarker;

  constructor(
    operation: string,
    status: number,
    safeCode: string,
    responseMarker: DownstreamResponseMarker,
  ) {
    super(`${operation} HTTP ${status}: ${safeCode}`);
    this.name = 'ToolFetchError';
    this.operation = operation;
    this.status = status;
    this.safeCode = safeCode;
    this.responseMarker = responseMarker;
  }
}

type DownstreamObservation = {
  operation: string;
  tool: string;
  auth: McpAuthContext;
  execution?: McpToolExecutionContext;
};

function classifyMcpInboundHost(hostname: string): McpToolExecutionContext['inboundHostClass'] {
  hostname = hostname.toLowerCase();
  const domain = normalizeDomain(process.env.APP_DOMAIN);
  if (hostname === `api.${domain}`) return 'canonical_api';
  if (hostname === domain) return 'apex';
  if (hostname === `www.${domain}`) return 'www';
  if (variantHosts().has(hostname)) return 'variant';
  if (hostname.endsWith(`.${domain}`)) return 'worldmonitor_subdomain';
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return 'local';
  if (hostname.endsWith('.vercel.app')) return 'vercel_preview';
  return 'other';
}

export function createMcpToolExecutionContext(requestUrl: string): McpToolExecutionContext {
  const inbound = new URL(requestUrl);
  const inboundHostClass = classifyMcpInboundHost(inbound.hostname);
  const domain = normalizeDomain(process.env.APP_DOMAIN);
  const isProductionWorldMonitorHost = (
    inbound.hostname === domain
    || inbound.hostname.endsWith(`.${domain}`)
  );
  const canonicalApiOrigin = resolveMcpCanonicalApiOrigin();
  const downstreamOrigin = isProductionWorldMonitorHost
    ? canonicalApiOrigin
    : inbound.origin;
  return {
    inboundHostClass,
    downstreamOrigin,
    // Only the canonical public origin is recorded verbatim. Non-production
    // origins collapse to their bounded host class so preview names, local
    // ports, and self-hosted domains never enter telemetry.
    downstreamOriginTag: downstreamOrigin === canonicalApiOrigin
      ? canonicalApiOrigin
      : inboundHostClass,
  };
}

function contentType(response: ToolFetchResponse): string {
  return (response.headers?.get('Content-Type') ?? '').toLowerCase();
}

function successMarker(response: ToolFetchResponse): DownstreamResponseMarker {
  const type = contentType(response);
  if (type.includes('json')) return 'json';
  if (type.includes('html')) return 'html';
  return 'other';
}

function defaultSafeErrorCode(status: number): string {
  if (status === 401) return 'auth_rejected';
  if (status === 403) return 'forbidden';
  if (status === 405) return 'method_not_allowed';
  if (status === 429) return 'rate_limited';
  return 'upstream_http_error';
}

function safeGatewayErrorCode(value: unknown, status: number): string {
  if (typeof value !== 'string') return defaultSafeErrorCode(status);
  const normalized = value.trim().toLowerCase();
  if (SAFE_GATEWAY_ERROR_CODES.has(normalized)) return normalized;
  return SAFE_GATEWAY_ERROR_MESSAGES.get(normalized) ?? defaultSafeErrorCode(status);
}

async function readBoundedResponseText(
  response: ToolFetchResponse,
  maxBytes = 4096,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = typeof response.text === 'function'
      ? await response.text().catch(() => '')
      : '';
    return text.slice(0, maxBytes);
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: bytesRead + chunk.byteLength < maxBytes });
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
    text += decoder.decode();
    return text;
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function classifyFailure(
  response: ToolFetchResponse,
): Promise<{ errorCode: string; marker: DownstreamResponseMarker }> {
  if (response.status === 405) {
    return { errorCode: 'method_not_allowed', marker: 'method_not_allowed' };
  }

  const type = contentType(response);
  const detail = await readBoundedResponseText(response);
  if (!detail) {
    return {
      errorCode: defaultSafeErrorCode(response.status),
      marker: 'empty_error',
    };
  }

  if (type.includes('json')) {
    try {
      const parsed = JSON.parse(detail) as { code?: unknown; error?: unknown };
      return {
        errorCode: safeGatewayErrorCode(parsed.code ?? parsed.error, response.status),
        marker: 'json_error',
      };
    } catch {
      return {
        errorCode: defaultSafeErrorCode(response.status),
        marker: 'json_error',
      };
    }
  }

  return {
    errorCode: defaultSafeErrorCode(response.status),
    marker: type.includes('html') ? 'html_error' : 'other',
  };
}

function emitDownstreamTelemetry(
  tool: string,
  operation: string,
  auth: McpAuthContext,
  execution: McpToolExecutionContext | undefined,
  response: ToolFetchResponse,
  errorCode: string | null,
  responseMarker: DownstreamResponseMarker,
): void {
  if (!execution) return;
  emitTelemetry('mcp.downstream', {
    tool,
    auth_kind: auth.kind,
    inbound_host_class: execution.inboundHostClass,
    downstream_origin: execution.downstreamOriginTag,
    downstream_operation: operation,
    status: response.status,
    ok: response.ok,
    error_code: errorCode,
    response_marker: responseMarker,
  });
}

/**
 * Validate one MCP sibling fetch while recording only bounded routing/auth
 * diagnostics. Error response bodies are consumed solely to map a closed set
 * of gateway codes; raw text, unknown values, headers, URLs, and credentials
 * never leave this module.
 */
export async function assertMcpToolFetchOk(
  response: ToolFetchResponse,
  observation: DownstreamObservation,
): Promise<void> {
  const { operation, tool, auth, execution } = observation;
  if (response.ok) {
    emitDownstreamTelemetry(
      tool,
      operation,
      auth,
      execution,
      response,
      null,
      successMarker(response),
    );
    return;
  }

  try {
    throwIfBillingDenial(response, operation);
  } catch (error) {
    if (error instanceof BillingDenialError) {
      emitDownstreamTelemetry(
        tool,
        operation,
        auth,
        execution,
        response,
        error.billingCode,
        'billing_verification',
      );
    }
    throw error;
  }

  const failure = await classifyFailure(response);
  emitDownstreamTelemetry(
    tool,
    operation,
    auth,
    execution,
    response,
    failure.errorCode,
    failure.marker,
  );
  throw new ToolFetchError(
    operation,
    response.status,
    failure.errorCode,
    failure.marker,
  );
}

export function downstreamErrorTags(
  error: unknown,
): Record<string, string> {
  if (error instanceof BillingDenialError) {
    return {
      downstream_operation: error.operation,
      downstream_status: String(error.status),
      downstream_error_code: error.billingCode,
      downstream_response_marker: 'billing_verification',
    };
  }
  if (error instanceof ToolFetchError) {
    return {
      downstream_operation: error.operation,
      downstream_status: String(error.status),
      downstream_error_code: error.safeCode,
      downstream_response_marker: error.responseMarker,
    };
  }
  return {};
}
