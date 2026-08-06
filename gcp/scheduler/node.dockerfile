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
# Scaffold-only pass — built locally via `nitric build`, never deployed.
# See docs/architecture/nitric-gcp-scaffold.md.
# =============================================================================

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

CMD ["npx", "tsx", "gcp/scheduler/main.ts"]
