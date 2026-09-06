import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListTelegramFeedRequest,
  ListTelegramFeedResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

// The Telegram feed used to be pulled live over HTTP from the AIS relay
// (`${WS_RELAY_URL}/telegram/feed`). P14 Phase 2 tail / decision P18 moved the
// MTProto poller out to the per-org `scripts/seed-telegram.mjs` `--once` job,
// which writes a rolling window of the last N messages into this Redis key.
// This handler now reads that key (mirror-aware via getCachedJson) and does
// the topic/channel/limit filtering the relay's `GET /telegram` route did.
const FEED_KEY = 'intelligence:telegram-feed:v1';

interface TelegramFeedItem {
  id?: string | number;
  channel?: string;
  channelId?: string | number;
  channelName?: string;
  channelTitle?: string;
  text?: string;
  timestamp?: string | number;
  timestampMs?: string | number;
  ts?: string | number;
  mediaUrls?: unknown[];
  sourceUrl?: unknown;
  url?: unknown;
  topic?: string;
}

interface TelegramFeedCache {
  enabled?: boolean;
  updatedAt?: string | null;
  count?: number;
  items?: TelegramFeedItem[];
}

function toTimestampMs(value: string | number | undefined): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value >= 1e12 ? value : value * 1000;
  }
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric >= 1e12 ? numeric : numeric * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toText(value: unknown): string {
  return value == null ? '' : String(value);
}

function toHttpUrl(value: unknown): string {
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
 * ListTelegramFeed serves OSINT messages from the mirrored
 * `intelligence:telegram-feed:v1` rolling window (written by
 * scripts/seed-telegram.mjs).
 */
export const listTelegramFeed: IntelligenceServiceHandler['listTelegramFeed'] = async (
  _ctx: ServerContext,
  req: ListTelegramFeedRequest,
): Promise<ListTelegramFeedResponse> => {
  let cache: TelegramFeedCache | null;
  try {
    cache = (await getCachedJson(FEED_KEY, true)) as TelegramFeedCache | null;
  } catch (error) {
    return { enabled: false, messages: [], count: 0, error: `telegram feed unavailable: ${String(error)}` };
  }

  if (!cache || !Array.isArray(cache.items)) {
    // Key absent = the per-org Telegram poll job has not written yet (or is
    // disabled). Not a hard error — a distinct "not synced" state.
    return { enabled: false, messages: [], count: 0, error: 'telegram feed not synced' };
  }

  const limit = Math.max(1, Math.min(200, req.limit || 50));
  const topic = (req.topic || '').trim().toLowerCase();
  const channel = (req.channel || '').trim().toLowerCase();

  const filtered = cache.items
    .filter((item) => {
      if (topic && String(item.topic || '').toLowerCase() !== topic) return false;
      if (channel && String(item.channel || '').toLowerCase() !== channel) return false;
      return true;
    })
    .slice(0, limit);

  const messages = filtered.map((message) => ({
    id: toText(message.id),
    channelId: toText(message.channelId),
    channelName: toText(message.channelName || message.channelTitle || message.channel),
    text: toText(message.text),
    timestampMs: toTimestampMs(message.timestampMs ?? message.timestamp ?? message.ts),
    mediaUrls: Array.isArray(message.mediaUrls) ? message.mediaUrls.map(toHttpUrl).filter(Boolean) : [],
    sourceUrl: toHttpUrl(message.sourceUrl || message.url),
    topic: toText(message.topic),
  }));

  return {
    enabled: cache.enabled ?? true,
    messages,
    count: messages.length,
    error: '',
  };
};
