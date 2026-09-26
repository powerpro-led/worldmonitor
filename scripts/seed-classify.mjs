#!/usr/bin/env node

/**
 * @notification-source: domain
 *   The publishNotificationEvent() call in this file builds payload.title from
 *   the classified headline plus structured fields (source / link / publishedAt
 *   / importanceScore / corroborationCount). It carries NO payload.description —
 *   the LLM only assigns a level+category, it does not emit free-form RSS text.
 *   Enforced by tests/notification-relay-payload-audit.test.mjs.
 *
 * AI Classification seed — batch-classify list-feed-digest titles by threat
 * level + category via an LLM, cache each verdict under
 * classify:sebuf:v6:<hash> (so the digest serves pre-classified items and the
 * client fires zero classify-event RPCs), and roll the per-country
 * critical/high counts up into news:threat:summary:v1.
 *
 * Ported verbatim (the CLASSIFY_* constants, the CLASSIFY_SYSTEM_PROMPT, the
 * whole relay* importance-score block, the THREAT_COUNTRY_* attribution tables,
 * classifyCacheKey, the CLASSIFY_LLM_PROVIDERS fallback chain, and the
 * per-variant / per-batch loop bodies) from the startClassifySeedLoop() that
 * used to live inside scripts/ais-relay.cjs — P14 Phase 2 loop-extraction pass
 * (see PLATFORM_ARCHITECTURE.md session 64). Identifiers keep their relay*
 * names so tests/importance-score-parity.test.mjs can still locate the scorer
 * by name and eval it against the TS digest scorer.
 *
 * Deviations from the relay loop:
 *   1. HAND-ROLLED (export async function main() + acquireLockSafely), not
 *      runSeed() — the primary output is N individual classify:sebuf: cache
 *      keys, the news:threat:summary:v1 canonical write is CONDITIONAL (skipped
 *      on quiet news periods), and rss_alert notifications are emitted mid-run
 *      per LLM batch. None of that fits runSeed's one-canonical-key + afterPublish
 *      model, and its ~4-min fetch-phase deadline is far short of this loop's
 *      ~12-min inter-variant stagger. Same call as seed-social-velocity.mjs.
 *   2. The relay's `classifyInFlight` module flag becomes a Redis lock
 *      (acquireLockSafely, TTL > the ~12-min run) so a 15-min tick that overruns
 *      is skipped rather than doubled.
 *   3. news:threat:summary:v1 goes out via atomicPublish (+ its fast-path
 *      sync-notify nudge) instead of the relay's bare envelopeWrite; its TTL is
 *      raised 1200s -> 7200s so it clears api/health.js's
 *      SEED_META.newsThreatSummary.maxStaleMin (60min) STRICTLY, per
 *      tests/seed-ttl-outlives-staleness-fleet.test.mjs (the relay's 1200s was a
 *      relay-cadence artifact and the relay is exempt from that test).
 *   4. `seed-meta:classify` is DROPPED — a repo-wide grep finds no reader
 *      outside the relay's own boot-seed freshness gate (it is not in
 *      api/health.js's SEED_META map). `seed-meta:news:threat-summary` is still
 *      written, unconditionally, every run — health treats newsThreatSummary as
 *      EMPTY-tolerant but STALE-sensitive.
 *   5. The inline Upstash helpers (upstashCommand/SetNx/Lpush/Del +
 *      publishNotificationEvent) are the same copy seed-corridor-risk.mjs /
 *      seed-weather-alerts.mjs carry; upstashMGet / upstashSet are added in the
 *      same style (no _seed-utils equivalent for a raw pipelined GET / SET).
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  atomicPublish,
  writeSeedMeta,
  logSeedResult,
  acquireLockSafely,
  releaseLock,
  gcpApiGatewayAuthHeaders,
} from './_seed-utils.mjs';
import { resolveApiOrigin, resolveAppOrigin } from './_domain-config.mjs';

const require = createRequire(import.meta.url);
const notificationDedup = require('./shared/notification-dedup.cjs');
const { buildDedupMaterial, recordDedupOutcome } = notificationDedup;
// classifySetNxResult is consumed inside upstashSetNx below.
const { classifySetNxResult } = notificationDedup;

loadEnvFile(import.meta.url);

// ─────────────────────────────────────────────────────────────
const CLASSIFY_CACHE_TTL = 86400;
const CLASSIFY_SKIP_TTL = 1800;
const CLASSIFY_BATCH_SIZE = 50;
const CLASSIFY_VARIANTS = ['full', 'tech', 'finance', 'happy', 'commodity'];
const CLASSIFY_VARIANT_STAGGER_MS = 3 * 60 * 1000;

const LOCK_DOMAIN = 'news:classify';
// 20min — comfortably above the 5-variant loop's 4 x 3min inter-variant
// stagger plus fetch/LLM time, and above the 15-min cron cadence so an
// overrunning run makes the next tick a no-op (replaces `classifyInFlight`).
const LOCK_TTL_MS = 20 * 60 * 1000;

// Relay gates — active only when RELAY_GATES_READY=1 (see Appendix E of
// docs/internal/news-alerts-enhancements-from-trendradar.md). When set, this
// cron is the sole authoritative source of rss_alert events and the client
// /api/notify path is suppressed via VITE_RELAY_GATES_READY on the Vercel side.
const RELAY_GATES_READY = process.env.RELAY_GATES_READY === '1';
const RELAY_RECENCY_MS = 15 * 60 * 1000; // 15 min — matches client-side recency gate

// ── Importance score parity with digest ──────────────────────────────────────
// Source-tier data loaded from scripts/shared/source-tiers.json, kept
// byte-identical to repo-root shared/source-tiers.json by
// tests/edge-functions.test.mjs and cross-checked in
// tests/importance-score-parity.test.mjs. Formula constants +
// relayComputeImportanceScore mirror list-feed-digest.ts; parity is enforced by
// tests/importance-score-parity.test.mjs.
const RELAY_SOURCE_TIERS = require('./shared/source-tiers.json');

function relayGetSourceTier(sourceName) {
  return RELAY_SOURCE_TIERS[sourceName] ?? 4;
}

// Derived from the tier map so the tier-4 gate and the tier map stay in lockstep.
const RELAY_TIER4_SOURCES = new Set(
  Object.entries(RELAY_SOURCE_TIERS).filter(([, t]) => t === 4).map(([s]) => s),
);

const RELAY_SCORE_WEIGHTS = { severity: 0.55, sourceTier: 0.2, corroboration: 0.15, recency: 0.1 };
const RELAY_SEVERITY_SCORES = { critical: 100, high: 75, medium: 50, low: 25, info: 0 };
const RELAY_DIPLOMACY_KEYWORDS = [
  'ceasefire', 'truce', 'armistice', 'treaty', 'accord', 'pact', 'diplomatic',
  'diplomacy', 'mediate', 'mediator', 'negotiation', 'negotiations', 'negotiate',
  'normalization', 'normalisation',
];
const RELAY_FLASHPOINT_SCORING_KEYWORDS = [
  'iran', 'tehran', 'russia', 'moscow', 'china', 'beijing', 'taiwan', 'ukraine', 'kyiv',
  'north korea', 'pyongyang', 'israel', 'gaza', 'west bank', 'syria', 'damascus',
  'yemen', 'hezbollah', 'hamas', 'kremlin', 'pentagon', 'nato', 'wagner',
];
const RELAY_DIPLOMACY_FLASHPOINT_PAIRS = [
  ['iran', 'deal'],
  ['iran', 'talks'],
  ['iran', 'ceasefire'],
  ['iran', 'treaty'],
  ['iran', 'accord'],
  ['iran', 'peace'],
  ['israel', 'ceasefire'],
  ['israel', 'truce'],
  ['israel', 'accord'],
  ['gaza', 'ceasefire'],
  ['gaza', 'truce'],
  ['ukraine', 'ceasefire'],
  ['ukraine', 'talks'],
  ['russia', 'talks'],
  ['russia', 'treaty'],
  ['hamas', 'truce'],
  ['hezbollah', 'truce'],
  ['syria', 'ceasefire'],
  ['china', 'talks'],
  ['china', 'accord'],
  ['taiwan', 'talks'],
  ['yemen', 'ceasefire'],
  ['north korea', 'talks'],
  ['pyongyang', 'talks'],
];
const RELAY_DIPLOMACY_FLASHPOINT_BOOST = 18;
const RELAY_ENTITY_CORROBORATION_SCORE_PER_SOURCE = 4;

function relayNormalizeScoringText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Word-start containment in normalized text. Mirrors
// shared/brief-filter.js:containsKeywordToken — prevents 'pact' inside
// 'impact' (false positive) while still matching 'iran' inside
// 'iranian' (demonym preserved). PR #3909 review (P2). Keeps this cron
// aligned with digest under tests/importance-score-parity.test.mjs.
function relayContainsKeywordToken(text, kw) {
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}`).test(text);
}

function relayHasAnySignal(text, keywords) {
  return keywords.some((kw) => relayContainsKeywordToken(text, kw));
}

function relayHasDiplomacyFlashpointSignal(title) {
  if (!title) return false;
  const text = relayNormalizeScoringText(title);
  if (
    RELAY_DIPLOMACY_FLASHPOINT_PAIRS.some(([entity, action]) =>
      relayContainsKeywordToken(text, entity) && relayContainsKeywordToken(text, action),
    )
  ) {
    return true;
  }
  return relayHasAnySignal(text, RELAY_DIPLOMACY_KEYWORDS) &&
    relayHasAnySignal(text, RELAY_FLASHPOINT_SCORING_KEYWORDS);
}

function relayDiplomacyFlashpointBoost(title) {
  return relayHasDiplomacyFlashpointSignal(title) ? RELAY_DIPLOMACY_FLASHPOINT_BOOST : 0;
}

function relayEntityCorroborationScore(count) {
  const finite = Number.isFinite(count) ? Number(count) : 0;
  return Math.min(Math.max(finite, 0), 5) * RELAY_ENTITY_CORROBORATION_SCORE_PER_SOURCE;
}

// Mirrors computeImportanceScore() in list-feed-digest.ts with ONE intentional
// deviation: this scorer defensively returns 0 for unknown severity levels
// (`?? 0` on the lookup); the TS digest returns NaN. This defensiveness is
// exercised in tests/importance-score-parity.test.mjs "unknown severity" case.
// Caller responsibility: pass defined values; the publish site defaults
// corroborationCount → 1 and publishedAt → Date.now() when upstream omits them.
function relayComputeImportanceScore(level, source, corroborationCount, publishedAt, context = {}) {
  const tier = relayGetSourceTier(source);
  const tierScore = tier === 1 ? 100 : tier === 2 ? 75 : tier === 3 ? 50 : 25;
  const corroborationScore = Math.min(corroborationCount, 5) * 20;
  const ageMs = Date.now() - publishedAt;
  const recencyScore = Math.max(0, 1 - ageMs / (24 * 60 * 60 * 1000)) * 100;
  const base = Math.round(
    (RELAY_SEVERITY_SCORES[level] ?? 0) * RELAY_SCORE_WEIGHTS.severity +
    tierScore * RELAY_SCORE_WEIGHTS.sourceTier +
    corroborationScore * RELAY_SCORE_WEIGHTS.corroboration +
    recencyScore * RELAY_SCORE_WEIGHTS.recency,
  );
  return Math.round(
    base +
    relayDiplomacyFlashpointBoost(context.title) +
    relayEntityCorroborationScore(context.entityCorroborationCount),
  );
}

const CLASSIFY_VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const CLASSIFY_VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

const CLASSIFY_SYSTEM_PROMPT = `You classify news headlines by threat level and category.
Return ONLY a JSON array, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Guidelines for LEVEL assignment (geopolitical scope required for critical):
- critical: Active military strikes with international implications, geopolitical mass-casualty events (10+ killed in conflict/terrorism/state action), ceasefire agreements/collapses, nuclear incidents, pandemic declarations, coups, strait/waterway closures
- high: Armed conflict updates, major diplomatic actions, sanctions packages, significant natural disasters, blockades, terrorist attacks, domestic mass-casualty events (mass shootings, industrial disasters)
- medium: Ongoing conflict analysis, economic impact reports, protest movements, regional policy changes, military exercises
- low: Diplomatic meetings, trade discussions, humanitarian aid, election updates, peacekeeping deployments
- info: Opinion/editorial pieces, analysis/explainer articles, historical retrospectives, lifestyle, entertainment, routine local news, tutorials

Key distinction: "critical" requires GEOPOLITICAL scope — events that destabilize international order, threaten cross-border security, or disrupt global systems. Domestic tragedies are "high" unless they trigger international diplomatic responses.
- "8 children killed in mass shooting in Louisiana" → domestic mass-casualty, not geopolitical → high
- "23 killed in fireworks factory explosion in India" → industrial accident → high
- "700 killed in Sudan drone strikes" → geopolitical mass-casualty in active civil war → critical
- "Iran closes Strait of Hormuz" → global trade disruption → critical
- "Guardian view on ceasefire: need real peace" → editorial → info
- "Trump's obsession with energy" → opinion/analysis → info
- "Man killed his estranged wife" → domestic crime → info
- "How to Crack the SAM Database in Kali Linux" → tutorial → info

Input: numbered lines "index|Title"
Output: [{"i":0,"l":"high","c":"conflict"}, ...]

Focus: geopolitical events, conflicts, disasters, diplomacy.
Classify by real-world event severity, not headline sentiment.`;

const NEWS_THREAT_SUMMARY_KEY = 'news:threat:summary:v1';
// 7200s (2h) — STRICTLY above api/health.js's SEED_META.newsThreatSummary
// maxStaleMin (60min / 3600s) per tests/seed-ttl-outlives-staleness-fleet.test.mjs.
// The relay used 1200s ("aligns with relay cadence"); a 15-min cron with a 2h
// last-good window is the standard shape.
const NEWS_THREAT_SUMMARY_TTL = 7200;
const NEWS_THREAT_SUMMARY_META_KEY = 'seed-meta:news:threat-summary';
const NEWS_THREAT_SUMMARY_META_TTL = 604800; // 7 days

// Country name → ISO2 for threat-summary geo-attribution (inline to avoid an
// ESM import graph just for this table).
const THREAT_COUNTRY_NAME_TO_ISO2 = {
  'afghanistan':'AF','albania':'AL','algeria':'DZ','angola':'AO','argentina':'AR',
  'armenia':'AM','australia':'AU','austria':'AT','azerbaijan':'AZ','bahrain':'BH',
  'bangladesh':'BD','belarus':'BY','belgium':'BE','bolivia':'BO','brazil':'BR',
  'burkina faso':'BF','burma':'MM','cambodia':'KH','cameroon':'CM','canada':'CA',
  'chad':'TD','chile':'CL','china':'CN','colombia':'CO','congo':'CG',
  'costa rica':'CR','croatia':'HR','cuba':'CU','cyprus':'CY',
  'czech republic':'CZ','czechia':'CZ',
  'democratic republic of the congo':'CD','dr congo':'CD','drc':'CD',
  'denmark':'DK','djibouti':'DJ','dominican republic':'DO',
  'ecuador':'EC','egypt':'EG','el salvador':'SV','eritrea':'ER',
  'estonia':'EE','ethiopia':'ET','finland':'FI','france':'FR',
  'georgia':'GE','germany':'DE','ghana':'GH','greece':'GR',
  'guatemala':'GT','guinea':'GN','haiti':'HT','honduras':'HN','hungary':'HU',
  'iceland':'IS','india':'IN','indonesia':'ID','iran':'IR','iraq':'IQ',
  'ireland':'IE','israel':'IL','italy':'IT','ivory coast':'CI',
  'jamaica':'JM','japan':'JP','jordan':'JO','kazakhstan':'KZ',
  'kenya':'KE','kosovo':'XK','kuwait':'KW','kyrgyzstan':'KG',
  'laos':'LA','latvia':'LV','lebanon':'LB','libya':'LY','lithuania':'LT',
  'mali':'ML','mauritania':'MR','mexico':'MX','moldova':'MD',
  'mongolia':'MN','montenegro':'ME','morocco':'MA','mozambique':'MZ',
  'myanmar':'MM','namibia':'NA','nepal':'NP','netherlands':'NL',
  'new zealand':'NZ','nicaragua':'NI','niger':'NE','nigeria':'NG',
  'north korea':'KP','north macedonia':'MK','norway':'NO',
  'oman':'OM','pakistan':'PK','palestine':'PS','panama':'PA',
  'paraguay':'PY','peru':'PE','philippines':'PH','poland':'PL',
  'portugal':'PT','qatar':'QA','romania':'RO','russia':'RU','rwanda':'RW',
  'saudi arabia':'SA','senegal':'SN','serbia':'RS','sierra leone':'SL',
  'singapore':'SG','slovakia':'SK','slovenia':'SI','somalia':'SO',
  'south africa':'ZA','south korea':'KR','south sudan':'SS','spain':'ES',
  'sri lanka':'LK','sudan':'SD','sweden':'SE','switzerland':'CH',
  'syria':'SY','taiwan':'TW','tajikistan':'TJ','tanzania':'TZ',
  'thailand':'TH','togo':'TG','tunisia':'TN','turkey':'TR',
  'turkmenistan':'TM','uganda':'UG','ukraine':'UA',
  'united arab emirates':'AE','uae':'AE',
  'united kingdom':'GB','uk':'GB','united states':'US','usa':'US',
  'uruguay':'UY','uzbekistan':'UZ','venezuela':'VE','vietnam':'VN',
  'yemen':'YE','zambia':'ZM','zimbabwe':'ZW',
  // Key aliases
  'tehran':'IR','moscow':'RU','beijing':'CN','kyiv':'UA','pyongyang':'KP',
  'tel aviv':'IL','gaza':'PS','damascus':'SY','sanaa':'YE','houthi':'YE',
  'kremlin':'RU','pentagon':'US','nato':'','irgc':'IR','hezbollah':'LB',
  'hamas':'PS','taliban':'AF','riyadh':'SA','ankara':'TR',
};
// Sort by name length desc so longer multi-word names match first (used for tie-breaking same position)
const THREAT_COUNTRY_NAME_ENTRIES = Object.entries(THREAT_COUNTRY_NAME_TO_ISO2)
  .filter(([name, iso2]) => name.length >= 3 && iso2.length === 2)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, iso2]) => ({ name, iso2, regex: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));

// Returns the single primary affected country — the country appearing immediately after a
// locative preposition or attack verb, which marks the grammatical object/affected entity.
// Returns [] when no such pattern fires (no attribution is better than wrong attribution).
// "UK and US launch strikes on Yemen" → ['YE']
// "US strikes on Yemen condemned by Iran" → ['YE'] (Iran is a reactor, not affected)
// "Yemen says UK and US strikes hit Hodeidah" → [] (Hodeidah is a city, skip)
// "Russia invades Ukraine" → ['UA']
const AFFECTED_PREFIX_RE = /\b(in|on|against|at|into|across|inside|targeting|toward[s]?|invad(?:es?|ed|ing)|attack(?:s|ed|ing)?|bomb(?:s|ed|ing)?|hitt?(?:ing|s)?|strik(?:es?|ing))\s+(?:the\s+)?/gi;
function matchCountryNamesInText(text) {
  const lower = text.toLowerCase();
  let match;
  AFFECTED_PREFIX_RE.lastIndex = 0;
  while ((match = AFFECTED_PREFIX_RE.exec(lower)) !== null) {
    const afterPfx = lower.slice(match.index + match[0].length);
    for (const { name, iso2 } of THREAT_COUNTRY_NAME_ENTRIES) {
      if (afterPfx.startsWith(name) && (afterPfx.length === name.length || /\W/.test(afterPfx[name.length]))) {
        return [iso2];
      }
    }
  }
  return [];
}

// v6: bumped in lockstep with server/worldmonitor/intelligence/v1/_shared.ts and
// server/worldmonitor/news/v1/list-feed-digest.ts. This cron maintains its own
// inline helper because .ts modules cannot be required from here without the
// build step; the prefix-audit static-analysis test
// (tests/news-classify-cache-prefix-audit.test.mjs) cross-checks every
// `classify:sebuf:vN` literal in the repo against the canonical version.
function classifyCacheKey(title) {
  const hash = createHash('sha256').update(title.toLowerCase()).digest('hex').slice(0, 16);
  return `classify:sebuf:v6:${hash}`;
}

// LLM provider fallback chain — mirrors seed-insights.mjs LLM_PROVIDERS.
// Order: ollama → openrouter → groq (canonical chain since #4944, mirrors
// server/_shared/llm.ts: DeepSeek V4 Flash primary with reasoning disabled,
// groq openai/gpt-oss-20b as the free-tier/outage fallback).
const CLASSIFY_LLM_PROVIDERS = [
  {
    name: 'ollama',
    envKey: 'OLLAMA_API_URL',
    apiUrlFn: (baseUrl) => new URL('/v1/chat/completions', baseUrl).toString(),
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
    headers: (_key) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA };
      const apiKey = process.env.OLLAMA_API_KEY;
      if (apiKey) h.Authorization = `Bearer ${apiKey}`;
      return h;
    },
    extraBody: { think: false },
    timeout: 30000,
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    // OPENROUTER_MODEL env var overrides, mirrors GROQ_MODEL below.
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': resolveAppOrigin(process.env.APP_DOMAIN), 'X-Title': 'World Monitor', 'User-Agent': CHROME_UA }),
    extraBody: { reasoning: { enabled: false } },
    timeout: 30000,
  },
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    // llama-3.3-70b-versatile retired from Groq's catalog (2026-08-18). gpt-oss-20b
    // is a reasoning model — reasoning_effort: 'low' avoids it spending the
    // classify budget (titles.length * 40) entirely on hidden reasoning and
    // returning empty content. GROQ_MODEL env var overrides.
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA }),
    extraBody: { reasoning_effort: 'low' },
    timeout: 30000,
  },
];

function classifyFetchLlmSingle(titles, _apiKey, apiUrl, model, headers, extraBody, timeout) {
  return new Promise((resolve) => {
    const sanitized = titles.map((t) => t.replace(/[\n\r]/g, ' ').replace(/\|/g, '/').slice(0, 200).trim());
    const prompt = sanitized.map((t, i) => `${i}|${t}`).join('\n');
    const bodyStr = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: titles.length * 40,
      ...extraBody,
    });

    const parsed = new URL(apiUrl);
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.request(parsed, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout,
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return resolve(null);
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          const raw = json?.choices?.[0]?.message?.content?.trim();
          if (!raw) return resolve(null);
          const match = raw.match(/\[[\s\S]*\]/);
          if (!match) return resolve(null);
          resolve(JSON.parse(match[0]));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(bodyStr);
  });
}

async function classifyFetchLlm(titles) {
  for (const provider of CLASSIFY_LLM_PROVIDERS) {
    const envVal = process.env[provider.envKey];
    if (!envVal) continue;

    const apiUrl = provider.apiUrlFn ? provider.apiUrlFn(envVal) : provider.apiUrl;
    const model = typeof provider.model === 'function' ? provider.model() : provider.model;
    const headers = provider.headers(envVal);

    const result = await classifyFetchLlmSingle(titles, envVal, apiUrl, model, headers, provider.extraBody || {}, provider.timeout);
    if (result) {
      return result;
    }
    console.warn(`[Classify] ${provider.name} failed, trying next provider...`);
  }
  return null;
}

// ─── Upstash helpers ─────────────────────────────────────────────────────────
// upstashMGet / upstashSet: raw pipelined GET / SET, no _seed-utils equivalent.
// upstashCommand / SetNx / Lpush / Del / publishNotificationEvent: the same
// inline-Upstash copy seed-corridor-risk.mjs / seed-weather-alerts.mjs carry.

async function upstashCommand(cmd, path = '') {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Upstash ${Array.isArray(cmd[0]) ? 'pipeline' : cmd[0]} failed: HTTP ${resp.status}`);
  return resp.json();
}

async function upstashSet(key, value, ttlSeconds) {
  try {
    const result = await upstashCommand(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
    return result?.result === 'OK';
  } catch { return false; }
}

async function upstashMGet(keys) {
  if (!keys.length) return [];
  try {
    const parsed = await upstashCommand(keys.map((k) => ['GET', k]), '/pipeline');
    return parsed.map((r) => {
      if (!r?.result) return null;
      try { return JSON.parse(r.result); } catch { return null; }
    });
  } catch {
    return keys.map(() => null);
  }
}

function notifyHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function upstashSetNx(key, value, ttlSeconds) {
  try {
    const result = await upstashCommand(['SET', key, value, 'NX', 'EX', String(ttlSeconds)]);
    return classifySetNxResult(result?.result);
  } catch { return 'error'; }
}

async function upstashLpush(key, value) {
  try {
    const result = await upstashCommand(['LPUSH', key, value]);
    return typeof result?.result === 'number' && result.result > 0;
  } catch { return false; }
}

async function upstashDel(key) {
  try {
    const result = await upstashCommand(['DEL', key]);
    return result?.result === 1;
  } catch { return false; }
}

async function publishNotificationEvent({ eventType, payload, severity, variant, dedupTtl = 1800 }) {
  try {
    // Include variant in the dedup key so each variant can independently publish
    // the same title (e.g. finance and world users both get an alert for the
    // same headline).
    const variantSuffix = variant ? `:${variant}` : '';
    const dedupMaterial = buildDedupMaterial(eventType, payload?.title, payload?.coalesceKey);
    const dedupKey = `wm:notif:scan-dedup:${eventType}${variantSuffix}:${notifyHash(dedupMaterial)}`;
    const dedupResult = await upstashSetNx(dedupKey, '1', dedupTtl);
    const dedupDecision = recordDedupOutcome(dedupResult, {
      surface: 'seed-classify',
      eventType,
      severity,
      fallbackKey: dedupKey,
      fallbackTtlSeconds: dedupTtl,
      emitTelemetry: ({ line }) => console.warn(line),
    });
    if (!dedupDecision.shouldPublish) {
      if (!dedupDecision.isDuplicate) return;
      console.log(`[Notify] Dedup hit — ${eventType}: ${String(payload.title ?? '').slice(0, 60)}`);
      return;
    }
    const msg = JSON.stringify({ eventType, payload, severity: dedupDecision.severity, ...(variant ? { variant } : {}), publishedAt: Date.now() });
    const ok = await upstashLpush('wm:events:queue', msg);
    if (ok) {
      console.log(`[Notify] Queued ${dedupDecision.severity} event: ${eventType} — ${String(payload.title ?? '').slice(0, 60)}`);
    } else {
      console.warn(`[Notify] LPUSH failed for ${eventType} — rolling back dedup key`);
      await upstashDel(dedupKey);
    }
  } catch (e) {
    console.warn(`[Notify] publishNotificationEvent error (${eventType}):`, e?.message || e);
  }
}

// ─── Per-variant classify ────────────────────────────────────────────────────

async function seedClassifyForVariant(variant, seenTitles) {
  // API_BASE_URL override matches every other warm-ping seeder's convention
  // — see seed-military-maritime-news.mjs's own comment on this same gap.
  const apiBase = process.env.API_BASE_URL || resolveApiOrigin(process.env.APP_DOMAIN);
  const digestUrl = `${apiBase}/api/news/v1/list-feed-digest?variant=${variant}&lang=en`;
  let digest;
  try {
    const resp = await new Promise((resolve, reject) => {
      const req = https.get(digestUrl, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, ...gcpApiGatewayAuthHeaders() },
        timeout: 15000,
      }, resolve);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    if (resp.statusCode !== 200) { resp.resume(); return { total: 0, classified: 0, skipped: 0 }; }
    const body = await new Promise((resolve) => {
      let d = '';
      resp.on('data', (c) => { d += c; });
      resp.on('end', () => resolve(d));
    });
    digest = JSON.parse(body);
  } catch {
    return { total: 0, classified: 0, skipped: 0 };
  }

  // Map of title → item metadata; recency gate: skip articles older than 6h
  const RECENCY_GATE_MS = 6 * 60 * 60 * 1000;
  const now6h = Date.now() - RECENCY_GATE_MS;
  const allTitles = new Map();
  if (digest?.categories) {
    for (const bucket of Object.values(digest.categories)) {
      for (const item of bucket?.items ?? []) {
        if (!item?.title) continue;
        if (item.publishedAt && item.publishedAt < now6h) continue; // stale item
        if (!allTitles.has(item.title)) {
          allTitles.set(item.title, {
            source: item.source ?? variant,
            publishedAt: item.publishedAt ?? Date.now(),
            corroborationCount: item.corroborationCount ?? 1,
            link: item.link ?? '',
          });
        }
      }
    }
  }
  if (allTitles.size === 0) return { total: 0, classified: 0, skipped: 0 };

  const titleArr = [...allTitles.keys()];
  const cacheKeys = titleArr.map((t) => classifyCacheKey(t));

  const cached = await upstashMGet(cacheKeys);
  const misses = [];
  // byCountry accumulates threat counts while title+level are in scope
  const byCountry = {};
  const emptyLevel = () => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

  for (let i = 0; i < titleArr.length; i++) {
    const hit = cached[i];
    if (!hit) {
      misses.push(titleArr[i]);
      continue;
    }
    // Attribute cached hits while we still have the title
    let parsed = hit;
    if (typeof hit === 'string') { try { parsed = JSON.parse(hit); } catch { continue; } }
    const level = parsed?.level;
    if (!CLASSIFY_VALID_LEVELS.includes(level)) continue;
    if (seenTitles.has(titleArr[i])) continue;
    seenTitles.add(titleArr[i]);
    for (const code of matchCountryNamesInText(titleArr[i])) {
      if (!byCountry[code]) byCountry[code] = emptyLevel();
      byCountry[code][level]++;
    }
  }

  if (misses.length === 0) return { total: titleArr.length, classified: 0, skipped: 0, byCountry };

  let classified = 0;
  let skipped = 0;

  for (let b = 0; b < misses.length; b += CLASSIFY_BATCH_SIZE) {
    const chunk = misses.slice(b, b + CLASSIFY_BATCH_SIZE);
    const llmResult = await classifyFetchLlm(chunk);

    if (!Array.isArray(llmResult)) {
      for (const title of chunk) {
        await upstashSet(classifyCacheKey(title), { level: '_skip', timestamp: Date.now() }, CLASSIFY_SKIP_TTL);
        skipped++;
      }
      continue;
    }

    const classifiedSet = new Set();
    for (const entry of llmResult) {
      const idx = entry?.i;
      if (typeof idx !== 'number' || idx < 0 || idx >= chunk.length) continue;
      if (classifiedSet.has(idx)) continue;
      const level = CLASSIFY_VALID_LEVELS.includes(entry?.l) ? entry.l : null;
      const category = CLASSIFY_VALID_CATEGORIES.includes(entry?.c) ? entry.c : null;
      if (!level || !category) continue;
      classifiedSet.add(idx);
      await upstashSet(classifyCacheKey(chunk[idx]), { level, category, timestamp: Date.now() }, CLASSIFY_CACHE_TTL);
      classified++;
      // Attribute newly classified title to country stats (global dedup via seenTitles)
      if (!seenTitles.has(chunk[idx])) {
        seenTitles.add(chunk[idx]);
        for (const code of matchCountryNamesInText(chunk[idx])) {
          if (!byCountry[code]) byCountry[code] = emptyLevel();
          byCountry[code][level]++;
        }
      }
      // Notifications are outside the seenTitles guard — each variant publishes
      // independently, protected by the variant-scoped Redis scan-dedup key.
      if (level === 'critical' || level === 'high') {
        const meta = allTitles.get(chunk[idx]) ?? {
          source: variant,
          publishedAt: Date.now(),
          corroborationCount: 1,
          link: '',
        };
        // Relay gates: when RELAY_GATES_READY is set this cron enforces the
        // source-tier and recency checks the client path previously handled.
        if (RELAY_GATES_READY) {
          if (RELAY_TIER4_SOURCES.has(meta.source ?? '')) continue;
          const ageMs = Date.now() - (meta.publishedAt ?? 0);
          if (meta.publishedAt && ageMs > RELAY_RECENCY_MS) continue;
        }
        // Recompute importanceScore from the post-LLM level. Publishing the
        // digest's pre-LLM keyword-based score would leak a stale value —
        // see docs/internal/scoringDiagnostic.md §2.
        const importanceScore = relayComputeImportanceScore(
          level,
          meta.source,
          meta.corroborationCount ?? 1,
          meta.publishedAt ?? Date.now(),
          {
            title: chunk[idx],
            classSource: 'llm',
            // This cron has only exact story-merge corroboration. Entity
            // corroboration is a separate digest-side signal computed from
            // flashpoint+diplomacy buckets; do not proxy source count here.
            entityCorroborationCount: 0,
          },
        );
        publishNotificationEvent({
          eventType: 'rss_alert',
          payload: {
            title: chunk[idx],
            source: meta.source,
            link: meta.link,
            publishedAt: meta.publishedAt,
            importanceScore,
            corroborationCount: meta.corroborationCount ?? 1,
          },
          severity: level,
          variant,
        }).catch(e => console.warn('[Notify] Classify publish error:', e?.message));
      }
    }

    for (let i = 0; i < chunk.length; i++) {
      if (!classifiedSet.has(i)) {
        await upstashSet(classifyCacheKey(chunk[i]), { level: '_skip', timestamp: Date.now() }, CLASSIFY_SKIP_TTL);
        skipped++;
      }
    }
  }

  return { total: titleArr.length, classified, skipped, byCountry };
}

export async function main() {
  const t0 = Date.now();
  const runId = `classify:${t0}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[Classify] Lock held, skipping');
    return;
  }

  try {
    const hasAnyProvider = CLASSIFY_LLM_PROVIDERS.some((p) => !!process.env[p.envKey]);
    if (!hasAnyProvider) {
      console.log('[Classify] Skipped — no LLM provider keys configured');
      return;
    }

    let totalClassified = 0;
    let totalSkipped = 0;
    const mergedByCountry = {};
    const seenTitles = new Set();
    for (let v = 0; v < CLASSIFY_VARIANTS.length; v++) {
      if (v > 0) await new Promise((r) => setTimeout(r, CLASSIFY_VARIANT_STAGGER_MS));
      try {
        const stats = await seedClassifyForVariant(CLASSIFY_VARIANTS[v], seenTitles);
        totalClassified += stats.classified;
        totalSkipped += stats.skipped;
        console.log(`[Classify] ${CLASSIFY_VARIANTS[v]}: ${stats.total} titles, ${stats.classified} classified, ${stats.skipped} skipped`);
        for (const [code, counts] of Object.entries(stats.byCountry || {})) {
          if (!mergedByCountry[code]) mergedByCountry[code] = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
          for (const lvl of ['critical', 'high', 'medium', 'low', 'info']) {
            mergedByCountry[code][lvl] += counts[lvl] || 0;
          }
        }
      } catch (e) {
        console.warn(`[Classify] ${CLASSIFY_VARIANTS[v]} error:`, e?.message || e);
      }
    }

    const countryCount = Object.keys(mergedByCountry).length;
    // seed-meta is written unconditionally every run — health treats
    // newsThreatSummary as EMPTY-tolerant but STALE-sensitive, so a quiet news
    // period (0 countries → no canonical write) must still refresh the meta key.
    await writeSeedMeta(NEWS_THREAT_SUMMARY_KEY, countryCount, NEWS_THREAT_SUMMARY_META_KEY, NEWS_THREAT_SUMMARY_META_TTL);
    if (countryCount > 0) {
      await atomicPublish(
        NEWS_THREAT_SUMMARY_KEY,
        { byCountry: mergedByCountry, generatedAt: Date.now() },
        null,
        NEWS_THREAT_SUMMARY_TTL,
        {
          envelopeMeta: {
            fetchedAt: Date.now(),
            recordCount: countryCount,
            sourceVersion: 'news-threat-summary',
            schemaVersion: 1,
            state: 'OK',
          },
        },
      );
      console.log(`[Classify] Threat summary written for ${countryCount} countries`);
    }

    logSeedResult('news:classify', totalClassified, Date.now() - t0);
    console.log(`[Classify] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${totalClassified} classified, ${totalSkipped} skipped`);
  } catch (e) {
    console.warn('[Classify] Seed error:', e?.message || e);
    throw e;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-classify.mjs')) {
  main().catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
