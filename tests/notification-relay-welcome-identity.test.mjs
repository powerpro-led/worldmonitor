import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalResendApiKey = process.env.RESEND_API_KEY;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
  if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
  if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendApiKey;
});

// Stage 3 of the Convex/Clerk -> Supabase migration: notification-relay.cjs's
// processWelcome() reads channels via scripts/lib/notification-channels-fetch.cjs
// (Postgres, service-role client) instead of a raw Convex `/relay/channels`
// fetch, and channel identity is the Postgres row's `id` (not Convex's
// `_id`). Load the relay with both the `resend` module AND
// `./lib/notification-channels-fetch.cjs` mocked, same
// Module._load-interception pattern the `resend` mock already used.
function loadRelayWithMocks({ channels, resendSends }) {
  const relayPath = require.resolve('../scripts/notification-relay.cjs');
  delete require.cache[relayPath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, ...rest) {
    if (request === 'resend') {
      return {
        Resend: class {
          emails = {
            send: async (message) => {
              resendSends.push(message);
              return { data: { id: 'sent' }, error: null };
            },
          };
        },
      };
    }
    if (request === './lib/notification-channels-fetch.cjs') {
      return {
        fetchChannelsForUser: async () => channels,
        deactivateChannel: async () => true,
      };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  try {
    return require(relayPath);
  } finally {
    Module._load = originalLoad;
  }
}

describe('notification relay welcome identity', () => {
  it('does not deliver a delayed welcome to a replacement channel', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    process.env.RESEND_API_KEY = 'resend-key';
    const resendSends = [];
    const { processWelcome, popNextEvent } = loadRelayWithMocks({
      channels: [{
        id: 'replacement-channel-id',
        channelType: 'email',
        email: 'replacement@example.com',
        verified: true,
      }],
      resendSends,
    });

    await processWelcome({
      eventType: 'channel_welcome',
      userId: 'user-welcome',
      channelType: 'email',
      welcomeId: 'original-channel-id',
    });

    assert.equal(resendSends.length, 0, 'replacement email channel must not receive the stale welcome');

    const queueCalls = [];
    globalThis.fetch = mock.fn(async (input) => {
      const url = String(input);
      queueCalls.push(url);
      if (url.includes('/RPOP/wm%3Aevents%3Aqueue%3Awelcome-v2')) {
        return Response.json({ result: JSON.stringify({
          eventType: 'channel_welcome',
          welcomeId: 'original-channel-id',
        }) });
      }
      throw new Error(`Unexpected queue poll: ${url}`);
    });
    const queued = await popNextEvent(0);
    assert.match(queued, /original-channel-id/);
    assert.equal(queueCalls.length, 1, 'v2 welcome must not be exposed to the legacy queue consumer');
  });

  it('delivers legacy events without welcomeId and events whose welcomeId matches', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    process.env.RESEND_API_KEY = 'resend-key';
    const resendSends = [];
    const { processWelcome } = loadRelayWithMocks({
      channels: [{
        id: 'current-channel-id',
        channelType: 'email',
        email: 'current@example.com',
        verified: true,
      }],
      resendSends,
    });

    await processWelcome({
      eventType: 'channel_welcome',
      userId: 'user-welcome',
      channelType: 'email',
    });
    assert.equal(resendSends.length, 1, 'legacy event without welcomeId must still deliver');
    assert.equal(resendSends[0].to, 'current@example.com');

    await processWelcome({
      eventType: 'channel_welcome',
      userId: 'user-welcome',
      channelType: 'email',
      welcomeId: 'current-channel-id',
    });
    assert.equal(resendSends.length, 2, 'matching welcomeId must deliver to its own connection');
  });
});
