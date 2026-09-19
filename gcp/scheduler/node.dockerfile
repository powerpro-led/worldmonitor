# syntax=docker/dockerfile:1
# =============================================================================
# worldmonitor — Nitric scheduler image (Cloud Run)
# =============================================================================
# Runs gcp/scheduler/main.ts, which spawns the existing scripts/seed-*.mjs
# entries (unchanged) as child processes on a Nitric schedule() trigger.
# Needs the full repo (not just scripts/) since some seed scripts import
# shared helpers from outside scripts/ — same reasoning as the root
# Dockerfile's builder stage.
#
# Pre-compiled rather than run through `npx tsx`, 2026-09-19, for the reason
# spelled out in gcp/api/node.dockerfile: the membrane binds PORT=9001 before
# the app registers its workers, Cloud Run's startup probe passes on that and
# throttles the CPU, and whatever is still compiling gets starved. This
# service registers 83 schedules, so it carries the same exposure the api
# gateway did, and the fix costs nothing here — its bundle is ~29KB, since it
# imports cadences from railway-services.json rather than route modules.
#
# The spawned seed scripts are untouched: they are already plain .mjs, run
# with bare `node` from REPO_ROOT, which gcp/scheduler/main.ts derives from
# `import.meta.url`. That derivation is exactly why the bundle is emitted
# beside its entrypoint instead of into a dist/ tree — see
# scripts/build-gcp-service-bundle.mjs.
# =============================================================================

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

COPY package.json package-lock.json ./
# BuildKit cache mount persists npm's package cache across the several
# service images `nitric up` builds in one run — see platform's fc0c2091 for
# the proven pattern (there: pnpm store) that cut a comparable multi-service
# deploy 15min->6min.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

COPY . .

# See the note on the same step in gcp/api/node.dockerfile — esbuild is a
# devDependency `npm ci` installs, and --ignore-scripts does not break it.
RUN node scripts/build-gcp-service-bundle.mjs gcp/scheduler/main.ts

CMD ["node", "gcp/scheduler/main.bundle.mjs"]
