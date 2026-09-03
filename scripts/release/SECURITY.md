# Security notes — worldmonitor-local bundle

## The bundle is org-neutral

This release carries **no** Supabase or Upstash values. `dist/` is built with
`VITE_SUPABASE_*` unset, and the standalone backend injects your org's Supabase
URL + publishable key into the dashboard HTML at request time
(`window.__WM_RUNTIME_CONFIG`) from its own `.env`. One artifact serves any
number of organisations; each supplies its own `org.env`.

## What lands in `.env` on an operator's machine

| Value | Sensitivity |
| --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | **Public.** The anon/publishable key already ships in any normally-built web bundle. RLS on the `worldmonitor` schema is what protects the data; the key alone grants nothing. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_READONLY_TOKEN` | **Read-only.** Can read the shared cache (derived-public feeds — news, markets, conflict events; no PII). Per-user `brief:` data is scoped by each operator's own login token, not this one. Optional. |
| `OPENROUTER_API_KEY` | **Not collected by the installer.** Each operator adds their own key if they want local AI-summary panels. The org's shared key never touches an operator machine. |

The installer never prompts for, and `org.env` must never contain, the Upstash
**full** (read/write) token or any other write credential to shared infrastructure.

## `/api/health` needs no credentials locally

Under `LOCAL_API_MODE=tauri-sidecar` the health endpoint computes its verdict
from the local SQLite mirror and never reads or writes shared Redis.

## Loopback only

The backend listens on `127.0.0.1` and every `/api/*` request requires the
per-machine transport token in `~/.worldmonitor/local-api-token` (0600).

## Reporting

Security issues: contact the repository owner directly rather than opening a
public issue.
