# syntax=docker/dockerfile:1
# =============================================================================
# worldmonitor — Nitric API gateway image (Cloud Run)
# =============================================================================
# gcp/api/routes.generated.ts imports each Vercel Edge handler directly from
# its .ts source (same files the current Vercel deployment builds from), and
# runs them via `tsx` at container start rather than a pre-bundling step —
# tsx compiles TS on the fly, so there's no separate build artifact to keep
# in sync with docker/build-handlers.mjs's esbuild output (that script
# produces the gitignored api/**/*.js bundles Vercel's OWN deploy pipeline
# uses; this image doesn't consume them).
#
# Scaffold-only pass — built locally via `nitric build`, never deployed.
# See docs/architecture/nitric-gcp-scaffold.md.
# =============================================================================

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

COPY package.json package-lock.json ./
# BuildKit cache mount persists npm's package cache across the several
# service images `nitric up` builds in one run (api/scheduler/every script
# reuse this same base) — see platform's fc0c2091 for the proven pattern
# (there: pnpm store) that cut a comparable multi-service deploy 15min->6min.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

COPY . .

EXPOSE 9001
CMD ["npx", "tsx", "gcp/api/main.ts"]
