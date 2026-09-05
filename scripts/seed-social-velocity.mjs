#!/usr/bin/env node

/**
 * Social Velocity seed — Reddit r/worldnews + r/geopolitics "hot" posts scored
 * by log(score) × upvote-ratio × recency-decay, top 30 stored under
 * intelligence:social:reddit:v1 so the existing GetSocialVelocity RPC serves
 * them without changes.
 *
 * Ported from the startSocialVelocitySeedLoop() that used to live inside
 * scripts/ais-relay.cjs (P14 Phase 2 loop-extraction pass — see
 * PLATFORM_ARCHITECTURE.md). Reddit fetching moved verbatim to the shared
 * scripts/_reddit-hot.cjs. The 500 ms inter-subreddit spacing is kept.
 *
 * This one is HAND-ROLLED rather than built on runSeed() because it writes a
 * bespoke seed-meta shape — `status: 'ok' | 'error'` + `errorReason` — that
 * api/health.js's classifyKey reads to raise SEED_ERROR immediately on a Reddit
 * fetch failure (rather than waiting for the canonical key to age past
 * maxStaleMin). That behavior is pinned by tests/social-velocity-seed-health.test.mjs
 * and has no runSeed equivalent; same approach as scripts/seed-gas-storage-countries.mjs.
 * No @notification-source tag — this loop never called publishNotificationEvent.
 */

import { createRequire } from 'node:module';
import {
  acquireLockSafely,
  atomicPublish,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
} from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const { fetchRedditHotListing } = require('./_reddit-hot.cjs');
const { normalizeDomain } = require('./_domain-config.cjs');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:social:reddit:v1';
const SEED_META_KEY = 'seed-meta:intelligence:social-reddit';
// 12h — STRICTLY > api/health.js's SEED_META.socialVelocity.maxStaleMin
// (540min / 9h) so a dead cron surfaces STALE_SEED for the 9h–12h window
// before the key expires to EMPTY. Same value the relay loop used.
const CACHE_TTL = 43_200;
const META_TTL = 604_800; // 7 days
const LOCK_DOMAIN = 'intelligence:social-velocity';
const LOCK_TTL_MS = 10 * 60 * 1000;
const REDDIT_SUBREDDITS = ['worldnews', 'geopolitics'];
const SOURCE_VERSION = 'social-reddit';

function socialVelocityMetaErrorReason(reason) {
  return String(reason || 'unknown').replace(/\s+/g, ' ').slice(0, 240);
}

async function setSeedMeta(payload) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', SEED_META_KEY, JSON.stringify(payload), 'EX', META_TTL]]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    console.warn(`[SocialVelocity] seed-meta write failed: HTTP ${resp.status}`);
    return false;
  }
  return true;
}

async function writeFailureMeta(reason) {
  return setSeedMeta({
    fetchedAt: Date.now(),
    recordCount: 0,
    sourceVersion: SOURCE_VERSION,
    status: 'error',
    errorReason: socialVelocityMetaErrorReason(reason),
  });
}

async function writeHealthyMeta(recordCount) {
  try {
    const ok = await setSeedMeta({
      fetchedAt: Date.now(),
      recordCount,
      sourceVersion: SOURCE_VERSION,
      status: 'ok',
    });
    if (!ok) {
      console.warn('[SocialVelocity] Healthy seed-meta write failed; preserving canonical payload state');
    }
    return ok;
  } catch (e) {
    console.warn('[SocialVelocity] Healthy seed-meta write threw:', e?.message || e);
    return false;
  }
}

async function fetchRedditHot(subreddit, failures) {
  const { ok, status, posts, source } = await fetchRedditHotListing(subreddit, {
    limit: 25,
    legacyUserAgent: `WorldMonitor/1.0 (contact: info@${normalizeDomain(process.env.APP_DOMAIN)})`,
  });
  if (!ok) {
    const failure = `r/${subreddit} HTTP ${status} (${source})`;
    failures.push(failure);
    console.warn(`[SocialVelocity] Reddit ${failure}`);
    return [];
  }
  return posts;
}

export async function main() {
  const startedAt = Date.now();
  const runId = `social-velocity:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[SocialVelocity] Lock held, skipping');
    return;
  }

  console.log('[SocialVelocity] Fetching...');
  try {
    const nowSec = Date.now() / 1000;
    const allPosts = [];
    const seenUrls = new Set();
    const fetchFailures = [];
    for (const sub of REDDIT_SUBREDDITS) {
      await new Promise((r) => setTimeout(r, 500));
      const posts = await fetchRedditHot(sub, fetchFailures);
      for (const p of posts) {
        // Deduplicate cross-subreddit reposts of the same article URL.
        const articleUrl = p.url || '';
        const isExternal = articleUrl && !articleUrl.includes('reddit.com');
        if (isExternal && seenUrls.has(articleUrl)) continue;
        if (isExternal) seenUrls.add(articleUrl);
        const ageSec = Math.max(1, nowSec - (p.created_utc || nowSec));
        const recencyFactor = Math.exp(-ageSec / (6 * 3600));
        const velocityScore = Math.log1p(p.score || 1) * (p.upvote_ratio || 0.5) * recencyFactor * 100;
        allPosts.push({
          id: String(p.id || ''),
          title: String(p.title || '').slice(0, 300),
          subreddit: sub,
          url: `https://reddit.com${p.permalink || ''}`,
          score: p.score || 0,
          upvoteRatio: p.upvote_ratio || 0,
          numComments: p.num_comments || 0,
          velocityScore: Math.round(velocityScore * 10) / 10,
          createdAt: Math.round((p.created_utc || nowSec) * 1000),
        });
      }
    }

    if (!allPosts.length) {
      console.warn('[SocialVelocity] No posts — extending TTL, next cron tick retries');
      try { await extendExistingTtl([CANONICAL_KEY], CACHE_TTL); } catch {}
      const reason = fetchFailures.length
        ? `empty_reddit_response: ${fetchFailures.join('; ')}`
        : 'empty_reddit_response';
      try { await writeFailureMeta(reason); } catch {}
      return;
    }

    allPosts.sort((a, b) => b.velocityScore - a.velocityScore);
    const top = allPosts.slice(0, 30);
    const payload = { posts: top, fetchedAt: Date.now() };

    let published = false;
    try {
      const result = await atomicPublish(CANONICAL_KEY, payload, null, CACHE_TTL, {
        envelopeMeta: {
          fetchedAt: Date.now(),
          recordCount: top.length,
          sourceVersion: SOURCE_VERSION,
          schemaVersion: 1,
          state: 'OK',
        },
      });
      published = !result?.skipped;
    } catch (e) {
      console.error('[SocialVelocity] Canonical write threw:', e?.message || e);
    }

    if (published) {
      await writeHealthyMeta(top.length);
      logSeedResult('intelligence:social-velocity', top.length, Date.now() - startedAt);
      console.log(`[SocialVelocity] Seeded ${top.length} posts`);
    } else {
      console.error('[SocialVelocity] Canonical write failed. Marking seed-meta error.');
      try { await extendExistingTtl([CANONICAL_KEY], CACHE_TTL); } catch {}
      try { await writeFailureMeta('canonical_write_failed'); } catch {}
      throw new Error('canonical write failed');
    }
  } catch (e) {
    console.warn('[SocialVelocity] Seed error:', e?.message || e, '— extending TTL, next cron tick retries');
    try { await extendExistingTtl([CANONICAL_KEY], CACHE_TTL); } catch {}
    try { await writeFailureMeta(`seed_error: ${e?.message || e}`); } catch {}
    throw e;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-social-velocity.mjs')) {
  main().catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
