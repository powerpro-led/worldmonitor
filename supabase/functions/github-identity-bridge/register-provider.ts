// ─────────────────────────────────────────────────────────────────────────────
// VENDORED COPY — platform is the source of truth (PLATFORM_ARCHITECTURE.md P9).
//
// Upstream: worldmonitor/platform  tools/supabase/functions/github-identity-bridge/register-provider.ts
// Synced from platform @ bafbfb15916c1db973f96a60564f99196c4e4428
//   (2026-09-04, WorldMonitor session 57 / Workstream 2).
//
// Not a deployed function — a one-shot admin script the multi-org deploy
// workflow (Workstream 5) runs once per tenant AFTER the function is deployed
// and its secrets are set (the issuer URL must resolve):
//   deno run --allow-net --allow-env register-provider.ts
// Byte-for-byte from upstream apart from this header.
// ─────────────────────────────────────────────────────────────────────────────

// Registers (or confirms already-registered) the `custom:github-bridge` OIDC
// provider on the live Supabase project, so `auth.custom_oauth_providers`
// has a reproducible, reviewable source instead of a one-off dashboard click.
//
// Run manually, against the live project, only after secrets are set and the
// github-identity-bridge function is deployed (the issuer URL must already
// be resolvable). Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, plus
// BRIDGE_CLIENT_ID / BRIDGE_CLIENT_SECRET matching what was set as function
// secrets (see docs/plans/2026-07-31-github-identity-bridge.md).
//
//   deno run --allow-net --allow-env register-provider.ts
//
import { createClient } from "jsr:@supabase/supabase-js@2";

function requiredEnv(key: string): string {
	const value = Deno.env.get(key);
	if (!value) throw new Error(`Missing required env var: ${key}`);
	return value;
}

// Everything executable lives inside main(), gated by import.meta.main below —
// top-level throws (including ones surfaced transitively via top-level await)
// crash serverless introspection/bundling when this file sits alongside a
// deployed function, so nothing here may run just from being imported.
async function main() {
	const supabaseUrl = requiredEnv("SUPABASE_URL");
	const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
	const clientId = requiredEnv("BRIDGE_CLIENT_ID");
	const clientSecret = requiredEnv("BRIDGE_CLIENT_SECRET");
	const issuer = `${supabaseUrl}/functions/v1/github-identity-bridge`;
	const identifier = "custom:github-bridge";

	const supabase = createClient(supabaseUrl, serviceRoleKey);

	// deno-lint-ignore no-explicit-any
	const admin = (supabase.auth.admin as any).customProviders;
	if (!admin) {
		throw new Error(
			"supabase.auth.admin.customProviders is not present on this supabase-js version — " +
				"check the installed @supabase/supabase-js@2 release notes for the current custom-provider admin API shape before proceeding.",
		);
	}

	const providerPayload = {
		provider_type: "oidc",
		identifier,
		name: "GitHub identity bridge",
		client_id: clientId,
		client_secret: clientSecret,
		issuer,
		scopes: ["openid", "email", "profile"],
		pkce_enabled: true,
		// GitHub only returns `email` from `GET /user` when the account has a
		// public email set — most don't. Identity here is `sub` (GitHub user
		// id), which is always present, so email must not be required.
		email_optional: true,
	};

	const { data, error } = await admin.createProvider(providerPayload);

	if (error) {
		const alreadyExists = /already exists|duplicate|unique/i.test(error.message ?? "");
		if (alreadyExists) {
			console.log(`Provider "${identifier}" already registered — attempting update instead.`);
			const updateResult = await admin.updateProvider(identifier, providerPayload);
			if (updateResult.error) throw updateResult.error;
			console.log(`Updated provider "${identifier}":`, updateResult.data);
			return;
		}
		throw error;
	}

	console.log(`Registered provider "${identifier}":`, data);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		Deno.exit(1);
	});
}
