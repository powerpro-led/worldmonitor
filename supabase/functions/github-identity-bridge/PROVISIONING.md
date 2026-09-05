# github-identity-bridge — per-org provisioning

Run once per tenant org, against that org's Supabase project, as part of
`deploy-org.yml` (Workstream 5). Everything here is idempotent — re-running an
org's deploy re-applies it safely.

**Context:** the bridge is a custom OIDC provider (`custom:github-bridge`) that
lets an operator sign in with the GitHub token their VS Code session already
holds, instead of a fresh OAuth consent screen. It is **per-tenant-project by
construction** — issuer URL, service-role key, and provider registration are all
project-scoped, so there is no shared deployment (P9). See
`PLATFORM_ARCHITECTURE.md` P9 and the upstream design doc
`platform/docs/plans/2026-07-31-github-identity-bridge.md`.

## Prerequisites

- `supabase` CLI, authenticated (`SUPABASE_ACCESS_TOKEN` from the org's GH
  Environment), linked to the org's project: `supabase link --project-ref <ref>`.
- `deno` on the runner (for `register-provider.ts`). Not needed for deploy.
- Node with `jose` (already a repo dependency) for the keypair step.

## Function secrets (5)

| Secret | What | How to generate |
|---|---|---|
| `OIDC_SIGNING_PRIVATE_KEY_JWK` | RS256 private key, JWK JSON string. Signs the ID token Supabase verifies via JWKS. | see keypair step below |
| `OIDC_SIGNING_KID` | Key id. **Must match** the `kid` inside the JWK — `/jwks` and the ID token header both read this env var, not the JWK's own field. | see keypair step below |
| `TICKET_SIGNING_SECRET` | Symmetric HS256 secret for the internal ticket + auth-code JWTs (server-only, never browser-visible, never Supabase-verified). | `openssl rand -hex 32` |
| `BRIDGE_CLIENT_ID` | OAuth client id the provider registration and the function agree on. Opaque; pick any unguessable value. | `openssl rand -hex 16` |
| `BRIDGE_CLIENT_SECRET` | OAuth client secret, checked server-to-server on `POST /token`. | `openssl rand -hex 32` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **not** in this list — Supabase
injects them into every Edge Function automatically (reserved `SUPABASE_` prefix).

### Keypair step

```bash
node --input-type=module -e '
import { generateKeyPair, exportJWK } from "jose";
import { randomUUID } from "node:crypto";
const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.alg = "RS256"; jwk.use = "sig";
const kid = randomUUID();
jwk.kid = kid;
process.stdout.write(JSON.stringify({
  OIDC_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(jwk),
  OIDC_SIGNING_KID: kid,
}));
' > bridge-oidc-key.json
```

Store `bridge-oidc-key.json`'s two values (plus the three `openssl` secrets) in
the org's GH Environment. Rotating the key = regenerate, re-set both secrets,
redeploy; old ID tokens (1h TTL) keep verifying only if the old `kid` stays in
`/jwks`, which it does not — so rotate during a quiet window or accept a ≤1h
sign-in blip.

## Deploy sequence (per org)

```bash
# 1. SQL — creates worldmonitor.link_bridge_identity_if_needed (idempotent).
#    Every WorldMonitor object in this project lives in the `worldmonitor`
#    schema, not `public` (S57 correction — see the migration's own header).
supabase db push          # applies supabase/migrations/*, incl. 20260904130000_github_identity_bridge.sql

# 1b. Expose the schema — step 1 (pipeline_config's migration) already does
#     this via `alter role authenticator set pgrst.db_schemas = ...` +
#     `notify pgrst, 'reload schema'`, confirmed working against a real hosted
#     Supabase project (S57) — no dashboard/Management-API step needed. Listed
#     here only so a `db push` run that skips 20260904120000_pipeline_config.sql
#     (a partial re-apply, a future migration reorder) doesn't silently leave
#     the bridge's `.rpc()` call 404ing with PGRST106 "Invalid schema".

# 2. Function secrets
supabase secrets set \
  OIDC_SIGNING_PRIVATE_KEY_JWK="$(jq -r .OIDC_SIGNING_PRIVATE_KEY_JWK bridge-oidc-key.json)" \
  OIDC_SIGNING_KID="$(jq -r .OIDC_SIGNING_KID bridge-oidc-key.json)" \
  TICKET_SIGNING_SECRET="$TICKET_SIGNING_SECRET" \
  BRIDGE_CLIENT_ID="$BRIDGE_CLIENT_ID" \
  BRIDGE_CLIENT_SECRET="$BRIDGE_CLIENT_SECRET"

# 3. Deploy the function — MUST be unauthenticated (it is an OIDC provider;
#    the browser hits /authorize with no Supabase JWT). Contrast local-config,
#    which is deployed WITH jwt verification.
supabase functions deploy github-identity-bridge --no-verify-jwt

# 4. Register the provider row (auth.custom_oauth_providers). Idempotent:
#    creates, or updates if it already exists.
SUPABASE_URL="https://<ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
BRIDGE_CLIENT_ID="$BRIDGE_CLIENT_ID" \
BRIDGE_CLIENT_SECRET="$BRIDGE_CLIENT_SECRET" \
deno run --allow-net --allow-env supabase/functions/github-identity-bridge/register-provider.ts
```

## Post-deploy — Supabase Auth config (once per org, not scripted yet)

- Add the operator client's redirect target to the project's **Redirect URLs**
  allow-list. GoTrue silently ignores an explicit `redirectTo` that is not
  allow-listed and falls back to Site URL — which reintroduces the
  "blank page after sign-in" bug the upstream doc records (2026-07-31).
- The exact URL depends on how the operator bundle initiates the flow
  (`worldmonitor-local login` / the dashboard). Pin it when Workstream 3's LLM
  modal / login wiring lands; until then this is a manual dashboard step in the
  new-org runbook.

## Smoke check

```bash
curl -s https://<ref>.supabase.co/functions/v1/github-identity-bridge/.well-known/openid-configuration | jq .
curl -s https://<ref>.supabase.co/functions/v1/github-identity-bridge/jwks | jq '.keys[0].kid'
```

Discovery should return the four endpoints; the `jwks` `kid` must equal
`OIDC_SIGNING_KID`. A full sign-in round trip can only be exercised from the
operator client — first real end-to-end test is a Workstream 5 gate.
