#!/usr/bin/env node
/**
 * Upstash-compatible Redis REST proxy.
 * Translates REST URL paths to raw Redis commands via redis npm package.
 *
 * Supports:
 *   GET  /{command}/{arg1}/{arg2}/...  → Redis command
 *   POST /                            → JSON body ["COMMAND", "arg1", ...]
 *   POST /pipeline                    → JSON body [["CMD1",...], ["CMD2",...]]
 *   POST /multi-exec                  → JSON body [["CMD1",...], ["CMD2",...]]
 *   POST /subscribe/{channel}         → real-time SSE stream (Upstash-compatible wire format)
 *
 * Env:
 *   REDIS_URL  - Redis connection string (default: redis://redis:6379)
 *   SRH_TOKEN  - Bearer token for auth (default: none)
 *   PORT       - Listen port (default: 80)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.SRH_CONNECTION_STRING || process.env.REDIS_URL || 'redis://redis:6379';
const TOKEN = process.env.SRH_TOKEN || '';
const PORT = parseInt(process.env.PORT || '80', 10);

// Redact userinfo before a connection string ever reaches stdout — REDIS_URL
// carries the Redis password (SRH_CONNECTION_STRING: redis://:<password>@host:port)
// and docker logs are readable by anyone with docker/compose access.
function maskRedisUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '<unparsable redis URL>';
  }
}

const client = createClient({ url: REDIS_URL });
client.on('error', (err) => console.error('Redis error:', err.message));
await client.connect();

// Separate connection reserved for blocking commands, so a long BLMOVE cannot
// hold up ordinary GET/SET traffic on the shared client.
const blockingClient = client.duplicate();
blockingClient.on('error', (err) => console.error('Redis (blocking) error:', err.message));
await blockingClient.connect();
console.log(`Connected to Redis at ${maskRedisUrl(REDIS_URL)}`);

function checkAuth(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return false;
  const provided = auth.slice(prefix.length);
  if (provided.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
}

// Command safety: allowlist of expected Redis commands.
// Blocks dangerous operations like FLUSHALL, CONFIG SET, DEBUG, SLAVEOF.
//
// EVAL/EVALSHA/SCRIPT are allowed. They were originally excluded when this proxy
// fronted an internet-reachable self-hosted deployment, where arbitrary Lua is a
// genuine RCE-shaped risk. This file is now dev-loop-only: the proxy binds to
// 127.0.0.1 and Redis is not published at all. Excluding them here breaks real,
// non-optional code paths -- the seed lock (scripts/_seed-utils.mjs), the
// forecast write-if-newer CAS (scripts/seed-forecasts.mjs) and api/health.js all
// issue EVAL, and every one of them would 500 against this proxy.
// If this proxy is ever exposed beyond localhost again, remove these three.
const ALLOWED_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'MGET', 'MSET', 'SCAN',
  'TTL', 'PTTL', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'EXISTS', 'TYPE',
  'HGET', 'HSET', 'HDEL', 'HGETALL', 'HMGET', 'HMSET', 'HKEYS', 'HVALS', 'HEXISTS', 'HLEN',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'LLEN', 'LTRIM',
  'SADD', 'SREM', 'SMEMBERS', 'SISMEMBER', 'SCARD',
  'ZADD', 'ZREM', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZSCORE', 'ZCARD', 'ZRANDMEMBER',
  'GEOADD', 'GEOSEARCH', 'GEOPOS', 'GEODIST',
  'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'PING', 'ECHO', 'INFO', 'DBSIZE',
  // PUBLISH only -- SUBSCRIBE is deliberately absent. SUBSCRIBE flips a RESP
  // connection into subscribe-only mode until it unsubscribes; dispatched
  // through runCommand() like any other command it would land on the SHARED
  // `client` (the same connection every GET/SET uses), permanently wedging
  // every other request through this proxy the moment one caller subscribes
  // -- confirmed live 2026-08-31 (sync-listener.mjs reconnecting every few
  // seconds re-wedged a freshly recreated container within ~1s each time).
  // Real-time subscribe is served exclusively by the dedicated POST
  // /subscribe/{channel} SSE route below, on its own connection per listener.
  'PUBLISH',
  // XADD/XRANGE back the sync:changelog stream (server/_shared/sync-notify.ts's
  // XADD, sync-listener.mjs's catch-up XRANGE) -- same real-time-sync feature
  // as the /subscribe route above, added together with it; both were missing
  // from this allowlist entirely until 2026-08-31, so the changelog catch-up
  // path 403'd against local dev even once the SUBSCRIBE wedge is fixed.
  'XADD', 'XRANGE',
  'SETNX', 'SETEX', 'PSETEX', 'GETSET',
  'APPEND', 'STRLEN', 'GETEX', 'PERSIST', 'UNLINK', 'RENAME',
  'HINCRBY', 'HINCRBYFLOAT', 'HSETNX',
  'ZINCRBY', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZCOUNT',
  'LMOVE', 'RPOPLPUSH', 'LINSERT', 'LSET', 'LPOS',
  'SINTER', 'SUNION', 'SDIFF', 'SPOP', 'SRANDMEMBER',
  'EVAL', 'EVALSHA', 'SCRIPT',
]);

// Blocking commands. These occupy their connection until they return, so they
// are dispatched on a DEDICATED client (see blockingClient below) -- issuing one
// on the shared client would stall every other request through this proxy behind
// it (head-of-line blocking), which on a single shared connection means the whole
// app. scripts/scenario-worker uses BLMOVE for its queue.
const BLOCKING_COMMANDS = new Set([
  'BLMOVE', 'BLPOP', 'BRPOP', 'BRPOPLPUSH', 'BZPOPMIN', 'BZPOPMAX',
]);

async function runCommand(args) {
  const cmd = args[0].toUpperCase();
  const blocking = BLOCKING_COMMANDS.has(cmd);
  if (!blocking && !ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`Command not allowed: ${cmd}`);
  }
  const cmdArgs = args.slice(1);
  const conn = blocking ? blockingClient : client;
  return conn.sendCommand([cmd, ...cmdArgs.map(String)]);
}

// 1 MB was sized for an internet-facing deployment. Several seed payloads are
// legitimately larger than that (intelligence:gpsjam:v2 alone is ~325 KB and
// grows with coverage), and a body-cap rejection here surfaces as an opaque 500
// mid-seed. Configurable, with a dev-appropriate 16 MB default.
const MAX_BODY_BYTES = parseInt(process.env.SRH_MAX_BODY_BYTES || String(16 * 1024 * 1024), 10);

async function readBody(req) {
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

/**
 * Upstash's REST API base64-encodes every string in a response when the caller
 * sends `Upstash-Encoding: base64` — and @upstash/redis sends that header BY
 * DEFAULT (its `responseEncoding` option defaults to "base64", and its decode()
 * unconditionally base64-decodes every string it receives). Ignoring the header
 * therefore does not degrade gracefully: the SDK decodes a value that was never
 * encoded.
 *
 * What makes this worth a comment is that the corruption is INTERMITTENT, so the
 * proxy looks correct almost all the time. The SDK's base64decode() leaves a
 * string alone when it is not valid base64, and every Redis key in this repo
 * contains ':', so keys always survive untouched. Only a value that happens to
 * BE valid base64 is silently mangled. SCAN cursors are the clearest case:
 * cursor "32208" is 5 characters, is not valid base64, and passes through — but
 * the very next page returns "3432", which decodes to 3 junk bytes, and the
 * following SCAN dies on `ERR invalid cursor`. Roughly a quarter of cursors have
 * a length divisible by 4, which is why local-sync.mjs reached page 2 of the
 * first prefix before failing. OAuth authorization codes and tokens are
 * base64url by construction and would corrupt the same way.
 *
 * Numbers, booleans and null are left alone: decode() only transforms strings,
 * so encoding a number would break the round trip rather than fix it.
 */
function encodeBase64Deep(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(encodeBase64Deep);
  return value;
}

function wantsBase64(req) {
  return String(req.headers['upstash-encoding'] || '').toLowerCase() === 'base64';
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');

  // Errors are NOT encoded — the SDK reads body.error as a plain message.
  const enc = wantsBase64(req) ? encodeBase64Deep : (v) => v;

  if (!checkAuth(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    // POST / — single command
    if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
      const body = JSON.parse(await readBody(req));
      const result = await runCommand(body);
      res.writeHead(200);
      res.end(JSON.stringify({ result: enc(result) }));
      return;
    }

    // POST /pipeline — batch commands
    if (req.method === 'POST' && req.url === '/pipeline') {
      const commands = JSON.parse(await readBody(req));
      const results = [];
      for (const cmd of commands) {
        try {
          const result = await runCommand(cmd);
          results.push({ result: enc(result) });
        } catch (err) {
          results.push({ error: err.message });
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify(results));
      return;
    }

    // POST /multi-exec — transaction
    if (req.method === 'POST' && req.url === '/multi-exec') {
      const commands = JSON.parse(await readBody(req));
      const multi = client.multi();
      for (const cmd of commands) {
        const cmdName = cmd[0].toUpperCase();
        if (!ALLOWED_COMMANDS.has(cmdName)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: `Command not allowed: ${cmdName}` }));
          return;
        }
        multi.sendCommand(cmd.map(String));
      }
      const results = await multi.exec();
      res.writeHead(200);
      res.end(JSON.stringify(results.map((r) => ({ result: enc(r) }))));
      return;
    }

    // POST /subscribe/{channel} — real-time pub/sub over SSE, matching
    // Upstash's own wire format exactly (see sync-listener.mjs's decodeFrame(),
    // verified live against real Upstash 2026-08-23):
    //   data: subscribe,<channel>,<subscriber count>\n\n   (sent once, on subscribe)
    //   data: message,<channel>,<raw PUBLISH message>\n\n  (per publish)
    //
    // Runs on ITS OWN connection (client.duplicate()), opened fresh per SSE
    // request and torn down on disconnect -- never the shared `client`. See
    // ALLOWED_COMMANDS's own comment on SUBSCRIBE for why that isolation is
    // load-bearing, not just tidiness.
    if (req.method === 'POST' && req.url.startsWith('/subscribe/')) {
      const channel = decodeURIComponent(req.url.slice('/subscribe/'.length));
      if (!channel) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No channel specified' }));
        return;
      }

      const sub = client.duplicate();
      sub.on('error', (err) => console.error(`Redis (subscribe:${channel}) error:`, err.message));
      await sub.connect();

      let closed = false;
      const cleanup = async () => {
        if (closed) return;
        closed = true;
        try { await sub.unsubscribe(channel); } catch { /* connection may already be gone */ }
        try { await sub.disconnect(); } catch { /* already closed */ }
      };
      req.on('close', cleanup);
      res.on('close', cleanup);

      await sub.subscribe(channel, (message) => {
        if (closed) return;
        res.write(`data: message,${channel},${message}\n\n`);
      });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: subscribe,${channel},1\n\n`);
      return; // left open -- an SSE stream, not a request/response pair
    }

    // GET / — welcome
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200);
      res.end('"Welcome to Serverless Redis HTTP!"');
      return;
    }

    // GET /{command}/{args...} — REST style
    if (req.method === 'GET') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result: enc(result) }));
      return;
    }

    // POST /{command}/{args...} — Upstash-compatible path-based POST
    // Used by setCachedJson(): POST /set/<key>/<value>/EX/<ttl>
    if (req.method === 'POST') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result: enc(result) }));
      return;
    }

    // OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Redis REST proxy listening on 0.0.0.0:${PORT}`);
});
