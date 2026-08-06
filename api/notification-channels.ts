/**
 * Notification channel management edge function.
 *
 * GET  /api/notification-channels → { channels, alertRules }
 * POST /api/notification-channels → various actions (see below)
 *
 * Authenticates the caller via Supabase bearer token, then calls
 * `server/_shared/{notification-channels,alert-rules,telegram-pairing}.ts`
 * directly — Postgres, service-role client.
 *
 * Stage 3 of the Convex/Clerk -> Supabase migration: this endpoint used to
 * forward every action to Convex's `/relay/notification-channels` HTTP
 * action (RELAY_SHARED_SECRET) and negotiate a "durable welcome scheduling"
 * capability with it (that negotiation existed only because Convex and
 * Vercel deploy independently — with the write and the welcome-queue publish
 * now in the same request, there's nothing to negotiate). The PRO-entitlement
 * gate that used to 403 this endpoint is also dropped — see
 * `server/_shared/notification-channels.ts`'s module doc for why (Convex's
 * `entitlements` table has had nothing writing to it since Stage 1, so the
 * gate had degenerated into "reject every write"). Any signed-in user now
 * gets full access, consistent with every other Stage 1/2/3 surface.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureEdgeException, captureSilentError } from './_sentry-edge.js';
import {
  beginStandaloneIdempotency,
  completeStandaloneIdempotency,
  getIdempotencyKey,
} from './_idempotency.js';
import { assertNotificationWebhookRegistrationUrlSafe } from './_notification-webhook-ssrf';
import { validateBearerToken } from '../server/auth-session';
import {
  deleteChannel,
  getChannels,
  NotificationChannelsError,
  setChannel,
  setWebPushChannel,
  type ChannelType,
} from '../server/_shared/notification-channels';
import {
  AlertRulesError,
  getAlertRules,
  setAlertRules,
  setDigestSettings,
  setNotificationConfig,
  setQuietHours,
} from '../server/_shared/alert-rules';
import { createPairingToken, TelegramPairingError } from '../server/_shared/telegram-pairing';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

// Every server/_shared/* call this handler makes is injectable, same
// convention as api/user-prefs.ts / api/followed-countries.ts (Stage 2) —
// lets tests exercise NETWORK/CONFIG failure paths without a live Postgres
// connection.
type NotificationChannelsDeps = {
  validateBearerToken: typeof validateBearerToken;
  fetch: typeof fetch;
  getChannels: typeof getChannels;
  setChannel: typeof setChannel;
  setWebPushChannel: typeof setWebPushChannel;
  deleteChannel: typeof deleteChannel;
  createPairingToken: typeof createPairingToken;
  getAlertRules: typeof getAlertRules;
  setAlertRules: typeof setAlertRules;
  setDigestSettings: typeof setDigestSettings;
  setQuietHours: typeof setQuietHours;
  setNotificationConfig: typeof setNotificationConfig;
};

function createDefaultNotificationChannelsDeps(): NotificationChannelsDeps {
  return {
    validateBearerToken,
    fetch: (...args) => globalThis.fetch(...args),
    getChannels,
    setChannel,
    setWebPushChannel,
    deleteChannel,
    createPairingToken,
    getAlertRules,
    setAlertRules,
    setDigestSettings,
    setQuietHours,
    setNotificationConfig,
  };
}

let notificationChannelsDeps = createDefaultNotificationChannelsDeps();

export function __setNotificationChannelsDepsForTests(
  overrides: Partial<NotificationChannelsDeps> | null,
): void {
  notificationChannelsDeps = overrides
    ? { ...createDefaultNotificationChannelsDeps(), ...overrides }
    : createDefaultNotificationChannelsDeps();
}

// AES-256-GCM encryption using Web Crypto (matches Node crypto.cjs decrypt format).
// Format stored: v1:<base64(iv[12] || tag[16] || ciphertext)>
async function encryptSlackWebhook(webhookUrl: string): Promise<string> {
  const rawKey = process.env.NOTIFICATION_ENCRYPTION_KEY;
  if (!rawKey) throw new Error('NOTIFICATION_ENCRYPTION_KEY not set');
  const keyBytes = Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(webhookUrl);
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encoded));
  const ciphertext = result.slice(0, -16);
  const tag = result.slice(-16);
  const payload = new Uint8Array(12 + 16 + ciphertext.length);
  payload.set(iv, 0);
  payload.set(tag, 12);
  payload.set(ciphertext, 28);
  const binary = Array.from(payload, (b) => String.fromCharCode(b)).join('');
  return `v1:${btoa(binary)}`;
}

/**
 * Allow-list of hostnames every major browser's push service uses.
 *
 * A PushSubscription's endpoint URL is assigned by the browser's push
 * platform — users can't pick it. That means we CAN safely constrain
 * accepted endpoints to known push-service hosts and reject anything else
 * before it hits storage (and later the relay's outbound fetch). Without
 * this allow-list the relay's sendWebPush() becomes a server-side-request
 * primitive for any signed-in user: they could submit
 * `https://internal.example.com/admin` as their endpoint and the relay
 * would faithfully POST to it.
 *
 * Sources (verified 2026-04-18):
 *   - Chrome / Edge / Brave:  fcm.googleapis.com
 *   - Firefox:                updates.push.services.mozilla.com
 *   - Safari (macOS 13+):     web.push.apple.com
 *   - Windows Notification:   *.notify.windows.com (wns2-*, etc.)
 *
 * If a future browser ships a new push service we'll need to widen this
 * list — fail-closed is the right default.
 */
function isAllowedPushEndpointHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'fcm.googleapis.com') return true;
  if (h === 'updates.push.services.mozilla.com') return true;
  if (h === 'web.push.apple.com') return true;
  if (h.endsWith('.web.push.apple.com')) return true;
  if (h.endsWith('.notify.windows.com')) return true;
  return false;
}

async function publishWelcome(userId: string, channelType: string, welcomeId?: string): Promise<void> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('[notification-channels] publishWelcome: UPSTASH env vars missing — welcome not queued');
    return;
  }
  // welcomeId (the channel row's id) lets the relay's processWelcome refuse
  // to deliver a delayed/duplicate welcome to a connection that's since been
  // replaced (e.g. the user re-links a different channel between this
  // publish and the relay consuming it) — see notification-relay.cjs.
  const msg = JSON.stringify({ eventType: 'channel_welcome', userId, channelType, welcomeId });
  try {
    const res = await notificationChannelsDeps.fetch(
      `${UPSTASH_URL}/lpush/wm:events:queue/${encodeURIComponent(msg)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${UPSTASH_TOKEN}`,
          'User-Agent': 'worldmonitor-edge/1.0',
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      throw new Error(`publishWelcome: Upstash LPUSH returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[notification-channels] publishWelcome LPUSH failed:', (err as Error).message);
    await captureSilentError(err, {
      tags: { route: 'api/notification-channels', step: 'publish-welcome' },
    });
  }
}

async function publishFlushHeld(userId: string, variant: string): Promise<void> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const msg = JSON.stringify({ eventType: 'flush_quiet_held', userId, variant });
  try {
    await notificationChannelsDeps.fetch(`${UPSTASH_URL}/lpush/wm:events:queue/${encodeURIComponent(msg)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'User-Agent': 'worldmonitor-edge/1.0' },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn('[notification-channels] publishFlushHeld LPUSH failed:', (err as Error).message);
    await captureSilentError(err, {
      tags: { route: 'api/notification-channels', step: 'publish-flush-held', severity: 'warn' },
    });
  }
}

function json(body: unknown, status: number, cors: Record<string, string>, noCache = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(noCache ? { 'Cache-Control': 'no-store' } : {}),
      ...cors,
    },
  });
}

interface PostBody {
  action?: string;
  channelType?: string;
  email?: string;
  webhookEnvelope?: string;
  webhookLabel?: string;
  variant?: string;
  enabled?: boolean;
  eventTypes?: string[];
  sensitivity?: string;
  channels?: string[];
  // web_push subscription triple (Phase 6)
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  userAgent?: string;
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: string;
  digestMode?: string;
  digestHour?: number;
  digestTimezone?: string;
  aiDigestEnabled?: boolean;
  // Optional ISO-3166 alpha-2 country-scope; server/_shared re-validates + normalizes.
  countries?: string[];
  // Optional watchlist ticker-scope (#4922 U3); server/_shared re-validates + normalizes.
  tickers?: string[];
}

/** Maps thrown NotificationChannelsError/AlertRulesError/TelegramPairingError to an HTTP response. */
async function handleBackendError(
  err: unknown,
  action: string,
  userId: string,
  cors: Record<string, string>,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (err instanceof NotificationChannelsError || err instanceof TelegramPairingError) {
    if (err instanceof NotificationChannelsError && err.kind === 'MISSING_FIELD') {
      return json({ error: err.message }, 400, cors);
    }
    console.warn(`[notification-channels] POST ${action} backend unavailable:`, err.message);
    captureSilentError(err, {
      tags: { route: 'api/notification-channels', action, user_id: userId, kind: err.kind },
      fingerprint: ['api/notification-channels', action, err.kind],
      ctx,
      level: 'warning',
    });
    return json({ error: 'Service unavailable' }, 503, { ...cors, 'Retry-After': '5' });
  }
  if (err instanceof AlertRulesError) {
    if (
      err.kind === 'INCOMPATIBLE_DELIVERY' ||
      err.kind === 'TICKERS_LIMIT_EXCEEDED' ||
      err.kind === 'COUNTRIES_LIMIT_EXCEEDED' ||
      err.kind === 'INVALID_INPUT'
    ) {
      return json({ error: err.kind === 'INVALID_INPUT' ? 'Validation failed' : err.kind, message: err.message }, 400, cors);
    }
    console.warn(`[notification-channels] POST ${action} backend unavailable:`, err.message);
    captureSilentError(err, {
      tags: { route: 'api/notification-channels', action, user_id: userId, kind: err.kind },
      fingerprint: ['api/notification-channels', action, err.kind],
      ctx,
      level: 'warning',
    });
    return json({ error: 'Service unavailable' }, 503, { ...cors, 'Retry-After': '5' });
  }
  console.error(`[notification-channels] POST ${action} error:`, err);
  captureEdgeException(err, { handler: 'notification-channels', action }, ctx);
  return json({ error: 'Operation failed' }, 500, cors);
}

export default async function handler(req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      },
    });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const session = await notificationChannelsDeps.validateBearerToken(token);
  if (!session.valid || !session.userId) return json({ error: 'Unauthorized' }, 401, corsHeaders);
  const userId = session.userId;

  const idempotencyRequest = req.method === 'POST' ? req.clone() : null;

  if (req.method === 'GET') {
    try {
      const [channels, alertRules] = await Promise.all([notificationChannelsDeps.getChannels(userId), notificationChannelsDeps.getAlertRules(userId)]);
      return json({ channels, alertRules }, 200, corsHeaders, true);
    } catch (err) {
      return handleBackendError(err, 'get', userId, corsHeaders, ctx);
    }
  }

  if (req.method === 'POST') {
    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    const idempotencyKey = getIdempotencyKey(req);
    const idempotency = idempotencyKey
      ? await beginStandaloneIdempotency({
        request: idempotencyRequest ?? req,
        pathname: '/api/notification-channels',
        scope: `user:${userId}`,
        idempotencyKey,
        corsHeaders,
      })
      : null;
    if (
      idempotency &&
      idempotency.kind !== 'proceed' &&
      idempotency.kind !== 'disabled'
    ) {
      return idempotency.response;
    }
    const finish = (response: Response): Promise<Response> =>
      completeStandaloneIdempotency(idempotency, response);

    const { action } = body;

    try {
      if (action === 'create-pairing-token') {
        const result = await notificationChannelsDeps.createPairingToken(userId, body.variant);
        return finish(json(result, 200, corsHeaders));
      }

      if (action === 'set-channel') {
        const { channelType, email, webhookEnvelope, webhookLabel } = body;
        if (!channelType) return finish(json({ error: 'channelType required' }, 400, corsHeaders));
        if (channelType !== 'telegram' && channelType !== 'slack' && channelType !== 'email' && channelType !== 'webhook') {
          return finish(json({ error: 'discord/web_push channels must be set via their own flow' }, 400, corsHeaders));
        }

        if (webhookEnvelope) {
          try {
            await assertNotificationWebhookRegistrationUrlSafe(webhookEnvelope);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Webhook URL is not allowed';
            return finish(json({ error: message }, 400, corsHeaders));
          }
        }

        let encryptedWebhookEnvelope: string | undefined;
        if (webhookEnvelope !== undefined) {
          try {
            encryptedWebhookEnvelope = await encryptSlackWebhook(webhookEnvelope);
          } catch {
            return finish(json({ error: 'Encryption unavailable' }, 503, corsHeaders));
          }
        }

        const { isNew, id } = await notificationChannelsDeps.setChannel(userId, channelType, {
          email,
          webhookLabel: webhookLabel !== undefined ? String(webhookLabel).slice(0, 100) : undefined,
          webhookEnvelope: encryptedWebhookEnvelope,
        });
        if (isNew) ctx.waitUntil(publishWelcome(userId, channelType, id));
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'set-web-push') {
        const { endpoint, p256dh, auth, userAgent } = body;
        if (!endpoint || !p256dh || !auth) {
          return finish(json({ error: 'endpoint, p256dh, auth required' }, 400, corsHeaders));
        }
        // SSRF defence. The relay later POSTs to whatever endpoint we
        // persist here, so an unvalidated user-submitted URL is a
        // server-side-request primitive bounded only by the relay's
        // network egress. Browsers always produce endpoints at one of a
        // small set of push-service hosts (FCM, Mozilla, Apple, Windows
        // Notification Service); anything else is either an exotic
        // browser (rare) or an attack. Allow-list the known hosts and
        // reject everything else.
        try {
          const u = new URL(endpoint);
          if (u.protocol !== 'https:') {
            return finish(json({ error: 'endpoint must be https' }, 400, corsHeaders));
          }
          if (!isAllowedPushEndpointHost(u.hostname)) {
            return finish(json(
              { error: 'endpoint host is not a recognised push service' },
              400,
              corsHeaders,
            ));
          }
        } catch {
          return finish(json({ error: 'invalid endpoint' }, 400, corsHeaders));
        }
        const { isNew, id } = await notificationChannelsDeps.setWebPushChannel(userId, {
          endpoint,
          p256dh,
          auth,
          userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : undefined,
        });
        if (isNew) ctx.waitUntil(publishWelcome(userId, 'web_push', id));
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'delete-channel') {
        const { channelType } = body;
        if (!channelType) return finish(json({ error: 'channelType required' }, 400, corsHeaders));
        await notificationChannelsDeps.deleteChannel(userId, channelType as ChannelType);
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'set-alert-rules') {
        const { variant, enabled, eventTypes, sensitivity, channels, aiDigestEnabled, countries, tickers } = body;
        if (!variant || enabled === undefined || !Array.isArray(eventTypes) || !Array.isArray(channels)) {
          return finish(json({ error: 'MISSING_REQUIRED_FIELDS' }, 400, corsHeaders));
        }
        if (tickers !== undefined && !Array.isArray(tickers)) {
          return finish(json({ error: 'TICKERS_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        if (countries !== undefined && !Array.isArray(countries)) {
          return finish(json({ error: 'COUNTRIES_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        await notificationChannelsDeps.setAlertRules(userId, variant, {
          enabled,
          eventTypes,
          channels: channels as ChannelType[],
          sensitivity: sensitivity as 'all' | 'high' | 'critical' | undefined,
          aiDigestEnabled,
          countries,
          tickers,
        });
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'set-quiet-hours') {
        const VALID_OVERRIDE = new Set(['critical_only', 'silence_all', 'batch_on_wake']);
        const { variant, quietHoursEnabled, quietHoursStart, quietHoursEnd, quietHoursTimezone, quietHoursOverride, countries } = body;
        if (!variant || quietHoursEnabled === undefined) {
          return finish(json({ error: 'variant and quietHoursEnabled required' }, 400, corsHeaders));
        }
        if (quietHoursOverride !== undefined && !VALID_OVERRIDE.has(quietHoursOverride)) {
          return finish(json({ error: 'invalid quietHoursOverride' }, 400, corsHeaders));
        }
        await notificationChannelsDeps.setQuietHours(userId, variant, {
          quietHoursEnabled,
          quietHoursStart,
          quietHoursEnd,
          quietHoursTimezone,
          quietHoursOverride: quietHoursOverride as 'critical_only' | 'silence_all' | 'batch_on_wake' | undefined,
          countries,
        });
        // If quiet hours were disabled or override changed away from batch_on_wake,
        // flush any held events so they're delivered rather than expiring silently.
        const abandonsBatch = !quietHoursEnabled || quietHoursOverride !== 'batch_on_wake';
        if (abandonsBatch) ctx.waitUntil(publishFlushHeld(userId, variant));
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'set-digest-settings') {
        const VALID_DIGEST_MODE = new Set(['realtime', 'daily', 'twice_daily', 'weekly']);
        const { variant, digestMode, digestHour, digestTimezone, countries } = body;
        if (!variant || !digestMode || !VALID_DIGEST_MODE.has(digestMode)) {
          return finish(json({ error: 'variant and valid digestMode required' }, 400, corsHeaders));
        }
        if (countries !== undefined && !Array.isArray(countries)) {
          return finish(json({ error: 'COUNTRIES_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        await notificationChannelsDeps.setDigestSettings(userId, variant, {
          digestMode: digestMode as 'realtime' | 'daily' | 'twice_daily' | 'weekly',
          digestHour,
          digestTimezone,
          countries,
        });
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      // Atomic update of (digestMode, sensitivity) and any subset of the alert-rule
      // fields. The UI's delivery-mode change flow uses this to avoid the two-call
      // race against the cross-field validator.
      if (action === 'set-notification-config') {
        const VALID_SENSITIVITY = new Set(['all', 'high', 'critical']);
        const VALID_DIGEST_MODE = new Set(['realtime', 'daily', 'twice_daily', 'weekly']);
        const { variant, enabled, eventTypes, sensitivity, channels, aiDigestEnabled, digestMode, digestHour, digestTimezone, countries, tickers } = body;
        if (!variant) return finish(json({ error: 'variant required' }, 400, corsHeaders));
        if (sensitivity !== undefined && !VALID_SENSITIVITY.has(sensitivity)) {
          return finish(json({ error: 'invalid sensitivity' }, 400, corsHeaders));
        }
        if (digestMode !== undefined && !VALID_DIGEST_MODE.has(digestMode)) {
          return finish(json({ error: 'invalid digestMode' }, 400, corsHeaders));
        }
        if (countries !== undefined && !Array.isArray(countries)) {
          return finish(json({ error: 'COUNTRIES_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        if (tickers !== undefined && !Array.isArray(tickers)) {
          return finish(json({ error: 'TICKERS_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        await notificationChannelsDeps.setNotificationConfig(userId, variant, {
          enabled,
          eventTypes,
          sensitivity: sensitivity as 'all' | 'high' | 'critical' | undefined,
          channels: channels as ChannelType[] | undefined,
          aiDigestEnabled,
          digestMode: digestMode as 'realtime' | 'daily' | 'twice_daily' | 'weekly' | undefined,
          digestHour,
          digestTimezone,
          countries,
          tickers,
        });
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      return finish(json({ error: 'Unknown action' }, 400, corsHeaders));
    } catch (err) {
      return finish(await handleBackendError(err, action ?? 'unknown', userId, corsHeaders, ctx));
    }
  }

  return json({ error: 'Method not allowed' }, 405, corsHeaders);
}
