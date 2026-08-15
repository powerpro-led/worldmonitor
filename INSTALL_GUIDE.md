# World Monitor — Self-Hosted Setup Guide

## 1. Clone (shallow)

```bash
git clone --depth 1 https://github.com/powerpro-led/worldmonitor.git
cd worldmonitor
```

## 2. Install dependencies

```bash
npm install
```

> `.nvmrc` specifies Node 24, but this installed and ran fine on Node 22.16.0 — don't block on getting the exact version.

## 3. Set up `.env.local`

Create `.env.local` in the project root (never edit `.env.example` with real values — that file is tracked by git and ships blank to every clone).

### Redis (required — this is the app's real database)

Skip Docker entirely; a free cloud Upstash Redis database is faster and simpler:

1. Go to [console.upstash.com](https://console.upstash.com), create a free Redis database
2. Copy its REST URL + token into `.env.local`:

```
UPSTASH_REDIS_REST_URL="https://your-db.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-token"
```

### Optional API keys

The app runs without any of these, but panels stay empty until set:

```
# Market quotes (paid, primary source)
INFOWAY_API_KEY=

# AI-powered features — summaries, forecasts, insights (free tier)
# Register at console.groq.com
GROQ_API_KEY=

# Live ship tracking (free)
# Register at aisstream.io
AISSTREAM_API_KEY=
RELAY_SHARED_SECRET=      # generate with: openssl rand -hex 32
WS_RELAY_URL=http://localhost:3004
VITE_WS_RELAY_URL=ws://localhost:3004
PORT=3004
```

## 4. Seed the Redis database

This runs ~156 seed scripts that pull live data (earthquakes, markets, conflicts, etc.) into Redis:

```bash
for f in scripts/seed-*.mjs; do
  echo "==> $(basename "$f")"
  node "$f"
done
```

Each script is a fresh process that reads `.env.local` independently — takes roughly 3–4 hours for the full run at default pace since it's sequential. Panels populate progressively as scripts complete; you don't need to wait for it to finish before using the app.

## 5. (Optional) Start the AIS relay for live ship tracking

Only needed if you set `AISSTREAM_API_KEY`. This is a separate long-running process (not a one-shot seed) — it also runs ~25 bonus live data loops (naval fleet tracking, tech events, chokepoint monitoring, etc.):

```bash
set -a; . ./.env.local; set +a
node scripts/ais-relay.cjs
```

Keep this running in a separate terminal/background process for as long as you want ship tracking live.

## 6. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## What we deliberately skipped (and why)

- **Docker Compose** — the full self-hosted container build failed on a transient Alpine package-mirror error unrelated to the app itself; cloud Upstash Redis is simpler anyway for local dev.
- **Supabase Auth** (sign-in) — optional for local dev; the app works fully signed-out. Sign-in is GitHub-OAuth-only and operator-issued (no self-service tier to unlock — every signed-in user gets the same full access). Skip unless you specifically want to test the signed-in path.
