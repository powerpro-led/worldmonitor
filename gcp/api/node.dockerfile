# syntax=docker/dockerfile:1
# =============================================================================
# worldmonitor — Nitric API gateway image (Cloud Run)
# =============================================================================
# gcp/api/routes.generated.ts imports each Vercel Edge handler directly from
# its .ts source — the same files the current Vercel deployment builds from.
#
# Until 2026-09-19 this image ran them with `npx tsx gcp/api/main.ts`, i.e. it
# compiled that whole TypeScript graph from source on every container start.
# That is what made cold starts return 500: Cloud Run's STARTUP TCP probe
# passes ~12s in, as soon as Nitric's membrane binds PORT=9001 and long before
# the app has registered a worker; Cloud Run then throttles the instance's CPU
# because the probe passed and nothing is being served yet; and the app, now
# on a fraction of a vCPU, never finished compiling ~105 route modules. The
# request died with `error handling request: http server not registered` and
# no app stdout at all. Deploy-time starts always worked because that phase
# gets full CPU.
#
# So the TypeScript is compiled ONCE here, at image build time, into a single
# ESM bundle. Measured on this entrypoint's graph (warm cache, unthrottled):
# `npx tsx` 2.82s to reach worker registration vs. 0.72s for `node` on the
# bundle. See scripts/build-gcp-service-bundle.mjs for why the bundle is
# emitted next to its entrypoint rather than into a dist/ tree, and why
# dependencies stay external.
#
# Unrelated, easily confused: docker/build-handlers.mjs's esbuild output (the
# gitignored api/**/*.js bundles) belongs to Vercel's OWN deploy pipeline.
# This image has never consumed those and still doesn't.
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

# esbuild is a devDependency and `npm ci` above installs it (no --omit=dev).
# --ignore-scripts is fine for it: since 0.16 the binary ships inside the
# platform package (@esbuild/linux-x64, a static Go binary that runs on musl),
# and the install script only validates it.
RUN node scripts/build-gcp-service-bundle.mjs gcp/api/main.ts

EXPOSE 9001
CMD ["node", "gcp/api/main.bundle.mjs"]
