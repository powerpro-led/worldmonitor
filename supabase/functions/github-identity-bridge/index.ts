// ─────────────────────────────────────────────────────────────────────────────
// VENDORED COPY — platform is the source of truth (PLATFORM_ARCHITECTURE.md P9).
//
// Upstream: worldmonitor/platform  tools/supabase/functions/github-identity-bridge/index.ts
// Synced from platform @ bafbfb15916c1db973f96a60564f99196c4e4428
//   (2026-09-04, WorldMonitor session 57 / Workstream 2).
//
// The bridge is generic, env-parameterized and frozen. To update: re-copy from
// upstream verbatim and bump the SHA above. Do NOT diverge here for feature
// work. Revisit "extract to a shared repo + pin a tag" only if the bridge
// starts changing more than ~quarterly.
//
// The multi-org deploy workflow (Workstream 5) deploys this to EACH tenant's
// Supabase project with `supabase functions deploy --no-verify-jwt` — it is an
// OIDC provider and MUST be reachable unauthenticated (unlike local-config,
// which keeps JWT verification on). Its companion SQL function ships as
// supabase/migrations/20260904130000_github_identity_bridge.sql.
//
// Deviations from upstream: this header; the fn_link_bridge_identity_if_needed
// path reference below points at the migration instead of the platform repo's
// declarative-schema file. Otherwise byte-for-byte.
// Platform-repo doc references (docs/plans/2026-07-31-github-identity-bridge.md)
// are left intact — that design doc lives upstream.
// ─────────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SignJWT, importJWK, jwtVerify, type JWTPayload } from "npm:jose@6";
import { createClient } from "jsr:@supabase/supabase-js@2";

// A minimal custom OIDC identity provider so Supabase Auth (registered as
// `custom:github-bridge`) can sign users in using a GitHub access token the
// caller already holds, instead of running a fresh GitHub OAuth consent flow.
//
// Supabase's custom-provider flow is a real OAuth/OIDC redirect: the browser
// is relayed through this function's `authorize_endpoint`, back to Supabase's
// own callback, which then calls `token_endpoint` server-to-server. The
// `authorize` hit is a bare browser GET with no custom headers, so the
// caller's GitHub token can't be handed over at that point directly — instead
// a short-lived "ticket" is minted up front via a direct API call to
// `/tickets`, then threaded through as a `ticket` query param on the
// `signInWithOAuth` call, which Supabase forwards to `authorize_endpoint`.
//
// See docs/plans/2026-07-31-github-identity-bridge.md for the full design
// and the accepted-risk decisions around token verification.

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, content-type",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(init.headers ?? {}) },
	});
}

function requiredEnv(key: string): string {
	const value = Deno.env.get(key);
	if (!value) throw new Error(`Missing required env var: ${key}`);
	return value;
}

function issuerUrl(): string {
	return `${requiredEnv("SUPABASE_URL")}/functions/v1/github-identity-bridge`;
}

// Ticket (pre-auth hand-off) and authorization code are both short-lived,
// server-only JWTs — never seen by the browser's own logic, never verified
// by Supabase — so they share one symmetric secret, distinct from the
// asymmetric key used for the externally-verified OIDC ID token below.
function internalSigningKey(): Promise<Uint8Array> {
	return Promise.resolve(new TextEncoder().encode(requiredEnv("TICKET_SIGNING_SECRET")));
}

function oidcSigningKey() {
	const jwk = JSON.parse(requiredEnv("OIDC_SIGNING_PRIVATE_KEY_JWK"));
	return importJWK(jwk, "RS256");
}

function base64url(bytes: Uint8Array): string {
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest)) === challenge;
}

// GoTrue links identities purely by exact (provider, provider_id) -- it has
// no notion of "this GitHub account is the same real person as that other
// provider's identity". Left alone, an operator who already has a Supabase
// user under a different provider (typically native `github` OAuth from a
// browser) gets a second, permanently separate user the first time they use
// the bridge. Before minting a ticket, pre-link a custom:github-bridge
// identity onto that existing user (mirroring the documented manual
// backfill) so GoTrue's own lookup resolves to it instead of creating a
// duplicate. See supabase/migrations/20260904130000_github_identity_bridge.sql
// for what this does and deliberately does not do (already-diverged
// accounts still need a human), and
// docs/plans/2026-07-31-github-identity-bridge.md's "Bug" section
// (2026-08-22) for the real-world case this closes.
//
// Best-effort: a failure here logs and falls through to the existing
// behavior (GoTrue mints/reuses a bridge-only identity as it does today)
// rather than blocking sign-in over a linking optimization.
async function linkExistingIdentityIfAny(
	gh: { id: number; login?: string; email?: string | null; name?: string | null; avatar_url?: string | null },
): Promise<void> {
	try {
		const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
		const { data, error } = await supabase.rpc("link_bridge_identity_if_needed", {
			p_github_id: String(gh.id),
			p_login: gh.login ?? null,
			p_email: gh.email ?? null,
			p_name: gh.name ?? gh.login ?? null,
			p_avatar_url: gh.avatar_url ?? null,
		});
		if (error) throw error;
		if (data === "linked") console.log(`linked bridge identity for github id ${gh.id} to existing user`);
	} catch (error) {
		console.error("link_bridge_identity_if_needed failed (continuing sign-in unlinked):", error);
	}
}

// --- POST /tickets — direct API call, not a browser navigation. Verifies a
// live GitHub token and mints a 60s ticket carrying the GitHub identity. ---
async function handleTickets(req: Request): Promise<Response> {
	const auth = req.headers.get("authorization");
	const githubToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
	if (!githubToken) return json({ error: "missing_token" }, { status: 401 });

	const ghRes = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "github-identity-bridge" },
	});
	if (!ghRes.ok) return json({ error: "invalid_github_token" }, { status: 401 });
	const gh = await ghRes.json();
	if (!gh?.id) return json({ error: "invalid_github_token" }, { status: 401 });

	await linkExistingIdentityIfAny(gh);

	// name/avatar_url: carried through the whole chain (ticket -> code -> ID
	// token) purely so consuming apps can render a real profile instead of a
	// blank placeholder. Not used for identity at any point — sub (GitHub
	// user id) is and remains the only identity-bearing claim. name falls
	// back to login since GitHub's /user only returns a display name when
	// the account has one set (same "most fields are optional" shape as the
	// email field below).
	const ticket = await new SignJWT({
		login: gh.login,
		email: gh.email ?? undefined,
		name: gh.name ?? gh.login,
		avatar_url: gh.avatar_url ?? undefined,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(String(gh.id))
		.setIssuedAt()
		.setExpirationTime("60s")
		.sign(await internalSigningKey());

	return json({ ticket });
}

function errorRedirect(redirectUri: string, state: string | null, error: string, description?: string): Response {
	const redirect = new URL(redirectUri);
	redirect.searchParams.set("error", error);
	if (description) redirect.searchParams.set("error_description", description);
	if (state) redirect.searchParams.set("state", state);
	return new Response(null, { status: 302, headers: { Location: redirect.toString(), ...CORS_HEADERS } });
}

// --- GET /authorize — the OIDC authorization_endpoint Supabase's server
// relays the browser to. Validates the ticket, issues a short-lived
// self-contained code (no server-side storage needed), redirects back. ---
async function handleAuthorize(req: Request): Promise<Response> {
	const params = new URL(req.url).searchParams;
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const state = params.get("state");
	const codeChallenge = params.get("code_challenge");
	const codeChallengeMethod = params.get("code_challenge_method");
	const ticket = params.get("ticket");
	const responseType = params.get("response_type");

	// redirect_uri must be Supabase's own callback for this project — never
	// redirect to an arbitrary caller-supplied URL (open-redirect guard).
	const expectedRedirectPrefix = `${requiredEnv("SUPABASE_URL")}/auth/v1/callback`;
	if (!redirectUri || !redirectUri.startsWith(expectedRedirectPrefix)) {
		return json({ error: "invalid_request", error_description: "redirect_uri not allowed" }, { status: 400 });
	}

	if (clientId !== requiredEnv("BRIDGE_CLIENT_ID")) return errorRedirect(redirectUri, state, "unauthorized_client");
	if (responseType !== "code") return errorRedirect(redirectUri, state, "unsupported_response_type");
	if (codeChallengeMethod && codeChallengeMethod !== "S256") {
		return errorRedirect(redirectUri, state, "invalid_request", "unsupported code_challenge_method");
	}
	if (!ticket) return errorRedirect(redirectUri, state, "access_denied", "missing ticket");

	let identity: JWTPayload;
	try {
		({ payload: identity } = await jwtVerify(ticket, await internalSigningKey()));
	} catch {
		return errorRedirect(redirectUri, state, "access_denied", "invalid or expired ticket");
	}

	const code = await new SignJWT({
		login: identity.login,
		email: identity.email,
		name: identity.name,
		avatar_url: identity.avatar_url,
		code_challenge: codeChallenge ?? null,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(identity.sub!)
		.setIssuedAt()
		.setExpirationTime("2m")
		.sign(await internalSigningKey());

	const redirect = new URL(redirectUri);
	redirect.searchParams.set("code", code);
	if (state) redirect.searchParams.set("state", state);
	return new Response(null, { status: 302, headers: { Location: redirect.toString(), ...CORS_HEADERS } });
}

async function mintIdToken(
	identity: { sub: string; login?: unknown; email?: unknown; name?: unknown; avatar_url?: unknown },
): Promise<string> {
	return new SignJWT({
		login: identity.login,
		email: identity.email,
		email_verified: Boolean(identity.email),
		name: identity.name,
		avatar_url: identity.avatar_url,
		// Custom OIDC providers have no attribute_mapping mechanism (confirmed
		// against Supabase's own docs) -- GoTrue copies ID token claims into
		// user_metadata verbatim, under whatever names they arrive with. These
		// two extra aliases exist purely so consuming apps that expect
		// Supabase's *native* GitHub provider's field-naming convention
		// (user_name = login, full_name = display name) get a profile that
		// looks the same regardless of which sign-in path was used.
		user_name: identity.login,
		full_name: identity.name,
	})
		.setProtectedHeader({ alg: "RS256", kid: requiredEnv("OIDC_SIGNING_KID") })
		.setSubject(identity.sub)
		.setIssuer(issuerUrl())
		.setAudience(requiredEnv("BRIDGE_CLIENT_ID"))
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(await oidcSigningKey());
}

// --- POST /token — Supabase calls this server-to-server after the browser
// redirect completes. Verifies client_secret + PKCE, mints the real ID token. ---
async function handleToken(req: Request): Promise<Response> {
	const contentType = req.headers.get("content-type") ?? "";
	const body: Record<string, string> = contentType.includes("application/json")
		? await req.json()
		: Object.fromEntries((await req.formData()).entries()) as Record<string, string>;

	const { grant_type, code, client_id, client_secret, code_verifier } = body;

	if (grant_type !== "authorization_code") return json({ error: "unsupported_grant_type" }, { status: 400 });
	if (client_id !== requiredEnv("BRIDGE_CLIENT_ID") || client_secret !== requiredEnv("BRIDGE_CLIENT_SECRET")) {
		return json({ error: "invalid_client" }, { status: 401 });
	}
	if (!code) return json({ error: "invalid_request", error_description: "missing code" }, { status: 400 });

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(code, await internalSigningKey()));
	} catch {
		return json({ error: "invalid_grant", error_description: "invalid or expired code" }, { status: 400 });
	}

	const codeChallenge = payload.code_challenge as string | null;
	if (codeChallenge) {
		if (!code_verifier || !(await pkceMatches(code_verifier, codeChallenge))) {
			return json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, { status: 400 });
		}
	}

	const idToken = await mintIdToken({
		sub: payload.sub!,
		login: payload.login,
		email: payload.email,
		name: payload.name,
		avatar_url: payload.avatar_url,
	});
	return json({ access_token: idToken, id_token: idToken, token_type: "Bearer", expires_in: 3600 });
}

function handleDiscovery(): Response {
	const iss = issuerUrl();
	return json({
		issuer: iss,
		authorization_endpoint: `${iss}/authorize`,
		token_endpoint: `${iss}/token`,
		jwks_uri: `${iss}/jwks`,
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
		scopes_supported: ["openid", "email", "profile"],
		claims_supported: ["sub", "email", "login", "name", "avatar_url", "user_name", "full_name"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["client_secret_post"],
	});
}

function handleJwks(): Response {
	const privateJwk = JSON.parse(requiredEnv("OIDC_SIGNING_PRIVATE_KEY_JWK"));
	const publicJwk = {
		kty: privateJwk.kty,
		n: privateJwk.n,
		e: privateJwk.e,
		alg: "RS256",
		use: "sig",
		kid: requiredEnv("OIDC_SIGNING_KID"),
	};
	return json({ keys: [publicJwk] });
}

Deno.serve(async (req) => {
	if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

	// Supabase forwards the full path including the function name — strip
	// any prefix up to and including "github-identity-bridge".
	const path = new URL(req.url).pathname.replace(/^.*\/github-identity-bridge/, "") || "/";

	try {
		if (path === "/tickets" && req.method === "POST") return await handleTickets(req);
		if (path === "/authorize" && req.method === "GET") return await handleAuthorize(req);
		if (path === "/token" && req.method === "POST") return await handleToken(req);
		if (path === "/.well-known/openid-configuration" && req.method === "GET") return handleDiscovery();
		if (path === "/jwks" && req.method === "GET") return handleJwks();
		return json({ error: "not_found" }, { status: 404 });
	} catch (error) {
		console.error(error);
		return json({ error: "server_error", message: (error as Error).message }, { status: 500 });
	}
});
