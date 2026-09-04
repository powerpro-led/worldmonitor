import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// local-config — the per-org config broker.
//
// PLATFORM_ARCHITECTURE.md P4 / Workstream 1. An operator's local backend is a
// pure read-only Upstash mirror (P2): it ships with no data-source keys and no
// Upstash credential of its own. All it has after `worldmonitor-local login` is
// a Supabase session for THIS org's project. It calls here with that session
// and gets back the org's Upstash read-only URL + token and APP_DOMAIN, which
// it caches in ~/.worldmonitor/config.db and re-fetches hourly.
//
// One deployment per tenant org, each with its own function secrets — so
// "which org's Upstash do I get?" is answered by which project you
// authenticated against, never by anything the caller sends.
//
// DEPLOYED WITH JWT VERIFICATION ON. `supabase functions deploy` verifies by
// default; do NOT pass --no-verify-jwt for this function (unlike
// github-identity-bridge, which must be callable unauthenticated). Belt and
// braces: we re-derive the user from the token below rather than trusting the
// gateway, so a misconfigured deploy fails closed instead of leaking the token.
//
// WHY the ban check (see below): the `worldmonitor-org-gate` Auth Hook is a
// before-user-created hook — it runs once, at first signup. Dropping someone
// from the GitHub org afterwards does NOT touch their Supabase user, so a
// broker that only checked "is this JWT valid?" would never revoke anybody and
// P4's hourly re-fetch would be decorative. Checking liveness here is what
// makes the re-fetch mean something: ban or delete the user in Supabase and
// their local backend loses the Upstash token within the hour.

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, content-type",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			// The response carries a credential. Never let a proxy or the
			// browser retain it.
			"Cache-Control": "no-store",
			...CORS_HEADERS,
			...(init.headers ?? {}),
		},
	});
}

function requiredEnv(key: string): string {
	const value = Deno.env.get(key);
	if (!value) throw new Error(`Missing required env var: ${key}`);
	return value;
}

Deno.serve(async (req: Request): Promise<Response> => {
	if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
	if (req.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });

	const authHeader = req.headers.get("Authorization") ?? "";
	if (!authHeader.toLowerCase().startsWith("bearer ")) {
		return json({ error: "missing_bearer_token" }, { status: 401 });
	}

	let supabaseUrl: string;
	let anonKey: string;
	let serviceRoleKey: string;
	let upstashUrl: string;
	let upstashReadonlyToken: string;
	let appDomain: string;
	try {
		supabaseUrl = requiredEnv("SUPABASE_URL");
		anonKey = requiredEnv("SUPABASE_ANON_KEY");
		serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
		// Set per org by the deploy workflow (Workstream 5). Named WM_* so they
		// can't be confused with the platform-injected SUPABASE_* above.
		upstashUrl = requiredEnv("WM_UPSTASH_REST_URL");
		upstashReadonlyToken = requiredEnv("WM_UPSTASH_READONLY_TOKEN");
		appDomain = requiredEnv("WM_APP_DOMAIN");
	} catch (err) {
		// A provisioning fault, not a caller fault — and the message names only
		// the missing variable, never a value.
		console.error(`[local-config] misconfigured: ${(err as Error).message}`);
		return json({ error: "server_misconfigured" }, { status: 500 });
	}

	// Who is calling? Derived from the token itself rather than from a gateway
	// header, so this is correct even if the function is ever deployed with
	// --no-verify-jwt by mistake.
	const asCaller = createClient(supabaseUrl, anonKey, {
		global: { headers: { Authorization: authHeader } },
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const { data: userData, error: userErr } = await asCaller.auth.getUser();
	if (userErr || !userData?.user) {
		return json({ error: "invalid_token" }, { status: 401 });
	}
	const userId = userData.user.id;

	// Liveness / revocation check — see the header note. getUserById reflects a
	// ban or a delete immediately, whereas the caller's access token stays
	// signature-valid until it expires.
	const asAdmin = createClient(supabaseUrl, serviceRoleKey, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const { data: adminData, error: adminErr } = await asAdmin.auth.admin.getUserById(userId);
	if (adminErr || !adminData?.user) {
		console.warn(`[local-config] denied: user ${userId} no longer exists`);
		return json({ error: "access_revoked" }, { status: 403 });
	}
	const bannedUntil = (adminData.user as { banned_until?: string | null }).banned_until;
	if (bannedUntil && new Date(bannedUntil).getTime() > Date.now()) {
		console.warn(`[local-config] denied: user ${userId} is banned until ${bannedUntil}`);
		return json({ error: "access_revoked" }, { status: 403 });
	}

	// Membership needs no separate check: each org has its OWN Supabase project,
	// and the org-gate Auth Hook decides at signup who may exist in it at all.
	// Holding a live, unbanned user in this project IS membership of this org.
	return json({
		upstashUrl,
		upstashReadonlyToken,
		appDomain,
		// Advisory only — the client owns its own re-fetch cadence (P4: hourly).
		// Present so the interval can be shortened per org later without
		// shipping a new local backend.
		refreshAfterSeconds: 3600,
	});
});
