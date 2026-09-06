// @ts-check
import { readJsonFromUpstash } from './_upstash-json.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

// The Telegram feed was pulled live over HTTP from the AIS relay
// (`${WS_RELAY_URL}/telegram/feed`). P14 Phase 2 tail / decision P18 moved the
// MTProto poller to the per-org `scripts/seed-telegram.mjs` `--once` job, which
// writes a rolling window of the last N messages into this Redis key. This
// route now reads that key (sidecar/mirror-aware via readJsonFromUpstash) and
// does the topic/channel/limit filtering the relay's `GET /telegram` route did.
const FEED_KEY = 'intelligence:telegram-feed:v1';

const EPOCH_ISO = new Date(0).toISOString();

/**
 * @typedef {{
 *   id?: string | number;
 *   channel?: string;
 *   channelId?: string | number;
 *   channelName?: string;
 *   channelTitle?: string;
 *   sourceUrl?: string;
 *   url?: string;
 *   timestamp?: string | number;
 *   timestampMs?: string | number;
 *   ts?: string | number;
 *   text?: string;
 *   topic?: string;
 *   tags?: unknown[];
 *   earlySignal?: boolean;
 *   mediaUrls?: unknown[];
 * }} RawTelegramMessage
 */

/**
 * @typedef {{
 *   enabled?: boolean;
 *   source?: string;
 *   earlySignal?: boolean;
 *   updatedAt?: string | null;
 *   count?: number;
 *   messages?: RawTelegramMessage[];
 *   items?: RawTelegramMessage[];
 * }} RawTelegramFeedResponse
 */

/**
 * @typedef {{
 *   id: string;
 *   source: 'telegram';
 *   channel: string;
 *   channelTitle: string;
 *   url: string;
 *   ts: string;
 *   text: string;
 *   topic: string;
 *   tags: string[];
 *   earlySignal: boolean;
 *   mediaUrls: string[];
 * }} TelegramFeedItem
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return value == null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toHttpUrl(value) {
  const raw = toText(value).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toIsoTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return EPOCH_ISO;
    return new Date(value >= 1e12 ? value : value * 1000).toISOString();
  }
  const raw = toText(value).trim();
  if (!raw) return EPOCH_ISO;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric >= 1e12 ? numeric : numeric * 1000).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : EPOCH_ISO;
}

/**
 * @param {unknown[] | undefined} values
 * @param {(value: unknown) => string} mapper
 * @returns {string[]}
 */
function toTextArray(values, mapper = toText) {
  if (!Array.isArray(values)) return [];
  return values.map(mapper).filter(Boolean);
}

/**
 * @param {RawTelegramMessage} message
 * @returns {TelegramFeedItem}
 */
function normalizeTelegramMessage(message) {
  const channel = toText(message.channel ?? message.channelName ?? message.channelTitle).trim();
  const channelTitle = toText(message.channelTitle ?? message.channelName ?? message.channel).trim();
  const ts = toIsoTimestamp(message.timestampMs ?? message.timestamp ?? message.ts);
  const text = toText(message.text).trim();
  const id = toText(message.id).trim() || `${channel || 'telegram'}:${ts}:${text.slice(0, 32)}`;

  return {
    id,
    source: 'telegram',
    channel,
    channelTitle: channelTitle || channel,
    url: toHttpUrl(message.sourceUrl ?? message.url),
    ts,
    text,
    topic: toText(message.topic).trim(),
    tags: toTextArray(message.tags),
    earlySignal: Boolean(message.earlySignal),
    mediaUrls: toTextArray(message.mediaUrls, toHttpUrl),
  };
}

/**
 * @param {RawTelegramFeedResponse} parsed
 */
function normalizeTelegramFeed(parsed) {
  const rawMessages = Array.isArray(parsed.messages)
    ? parsed.messages
    : Array.isArray(parsed.items)
      ? parsed.items
      : [];
  const items = rawMessages.map(normalizeTelegramMessage);
  return {
    source: toText(parsed.source).trim() || 'telegram',
    earlySignal: Boolean(parsed.earlySignal),
    enabled: parsed.enabled !== false,
    count: items.length,
    updatedAt: parsed.updatedAt ?? null,
    items,
  };
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const topic = (url.searchParams.get('topic') || '').trim().toLowerCase();
  const channel = (url.searchParams.get('channel') || '').trim().toLowerCase();

  let cache;
  try {
    cache = /** @type {RawTelegramFeedResponse | null} */ (await readJsonFromUpstash(FEED_KEY));
  } catch (error) {
    return jsonResponse({
      error: 'Telegram feed unavailable',
      details: error?.message || String(error),
    }, 503, { 'Cache-Control': 'no-store', ...corsHeaders });
  }

  const rawItems = cache && Array.isArray(cache.items) ? cache.items : [];
  const filtered = rawItems
    .filter((item) => {
      if (topic && String(item.topic || '').toLowerCase() !== topic) return false;
      if (channel && String(item.channel || '').toLowerCase() !== channel) return false;
      return true;
    })
    .slice(0, limit);

  const normalized = normalizeTelegramFeed({
    source: 'telegram',
    earlySignal: true,
    // Key absent = the per-org Telegram poll job has not written yet (or is
    // disabled) — a distinct "not synced" state, not a hard error.
    enabled: cache ? cache.enabled !== false : false,
    updatedAt: cache?.updatedAt ?? null,
    items: filtered,
  });

  const cacheControl = normalized.count === 0
    ? 'public, max-age=0, s-maxage=15, stale-while-revalidate=10'
    : 'public, max-age=30, s-maxage=120, stale-while-revalidate=60, stale-if-error=120';

  return jsonResponse(normalized, 200, { 'Cache-Control': cacheControl, ...corsHeaders });
}
