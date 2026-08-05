/**
 * Followed-countries client service — single owner of watchlist semantics.
 *
 * Operating modes:
 *  1. Anonymous (no signed-in user) — localStorage at
 *     `wm-followed-countries-v1`, storing `JSON.stringify({ countries:
 *     string[] })`. No cap (see Stage 2 note below).
 *  2. handoffPending — transitional during the anon→signed-in merge.
 *     Mutations refused with `HANDOFF_PENDING`.
 *  3. Signed-in (handoff complete) — `/api/followed-countries` (Postgres,
 *     via a service-role edge function) is authoritative.
 *
 * Stage 2 of the Convex/Clerk -> Supabase migration replaced the direct
 * Convex client (`client.mutation`/`client.onUpdate`) with fetch calls to
 * `/api/followed-countries` (mirrors `src/utils/cloud-prefs-sync.ts`'s
 * `/api/user-prefs` pattern). Two behavioral changes that came with it:
 *
 *  - **No follow cap.** `FREE_TIER_FOLLOW_LIMIT` / `FREE_CAP` are gone —
 *    Stage 1 already collapsed entitlements to "signed in = full access"
 *    (`src/services/entitlements.ts`), so a per-tier follow cap had
 *    nothing left to differentiate. `WM_FOLLOWED_COUNTRIES_CAP_DROP` no
 *    longer fires; `src/App.ts`'s toast listener for it was removed
 *    alongside this file, and `src/utils/follow-button.ts`'s at-cap
 *    tooltip/upgrade-trigger branch was removed too.
 *  - **No live push.** Convex's `client.onUpdate` reactive subscription
 *    isn't ported — there's no realtime transport backing this anymore.
 *    The local snapshot (`_lastKnownSubscriptionSnapshot`, kept as-named
 *    for historical continuity even though nothing "subscribes" now) is
 *    populated by an explicit `listFollowed` fetch after handoff, updated
 *    optimistically on every successful `addCountry`/`removeCountry`, and
 *    refreshed on `visibilitychange`/`focus` so other tabs/devices'
 *    changes eventually show up without a persistent connection.
 *
 * Sign-in orchestration (unchanged from the Convex-backed version):
 *  - On user transition `null → user` OR `user-A → user-B`: increment
 *    `_handoffGeneration`, capture `userIdAtStart`, parse localStorage,
 *    optionally call `mergeAnonymousLocal`. The post-await callback
 *    verifies `(currentUserId === userIdAtStart) && (currentGen ===
 *    capturedGen)` and DROPS stale results — prevents a user-B sign-in or
 *    user-A sign-out from clearing localStorage on user-A's behalf
 *    (memory: cloud-prefs-sync `_authGeneration` pattern).
 *  - On `user → null` (sign-out): increment `_handoffGeneration`, clear
 *    `_lastKnownSubscriptionSnapshot = null` (cross-user-leak fix —
 *    memory: `session-storage-cross-user-leak-on-auth-transition`),
 *    reset `_handoffState = 'idle'`.
 *
 * Patterns mirrored from:
 *  - src/utils/cloud-prefs-sync.ts (`/api/*` fetch shape, `_authGeneration` guard)
 *  - src/services/market-watchlist.ts (event dispatch, JSON.parse safety)
 *  - src/services/aviation/watchlist.ts (storage-key versioning)
 *  - src/services/entitlements.ts (hasTier / getEntitlementState)
 *
 * Memory: `discriminated-union-over-sentinel-boolean` —
 * `FollowMutationResult` is a discriminated union, never a `boolean | null`.
 */

import { toIso2 } from '../utils/country-codes';
import {
  getEntitlementState as _getEntitlementState,
  hasTier as _hasTier,
} from './entitlements';
import { getCurrentAuthUser as _getCurrentAuthUser, getAuthToken as _getAuthToken } from './auth-provider';
import { subscribeAuthState as _subscribeAuthState } from './auth-state';

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

/** localStorage key for the anonymous-mode list. Versioned for safe migration. */
export const FOLLOWED_COUNTRIES_STORAGE_KEY = 'wm-followed-countries-v1';

/** Custom event name dispatched on every successful mutation. */
export const WM_FOLLOWED_COUNTRIES_CHANGED = 'wm-followed-countries-changed';

/**
 * Discriminated-union result. Service NEVER throws from
 * `addCountry` / `removeCountry`.
 */
export type FollowMutationResult =
  | { ok: true }
  | { ok: false; reason: 'DISABLED' }
  | { ok: false; reason: 'INVALID_INPUT' }
  | { ok: false; reason: 'ENTITLEMENT_LOADING' }
  | { ok: false; reason: 'HANDOFF_PENDING' }
  | { ok: false; reason: 'STORAGE_FULL' };

export type ServiceEntitlementState = 'pro' | 'free' | 'loading';

declare global {
  interface Window {
    __wmFollowedCountries?: {
      getFollowed: () => string[];
    };
  }
}

export interface ServerFollowMutationResult {
  ok: true;
  idempotent: boolean;
}

export interface ServerMergeAnonymousLocalResult {
  totalCount: number;
  accepted: string[];
  droppedInvalid: string[];
}

// ---------------------------------------------------------------------------
// Backend transport — `/api/followed-countries` (edge, Postgres-backed)
// ---------------------------------------------------------------------------

/** Discriminated error kinds surfaced by the backend transport. Mirrors
 * `server/_shared/followed-countries.ts::FollowedCountriesErrorKind` plus
 * the transport-local `UNAUTHENTICATED`/`NETWORK` cases. */
export type FollowedCountriesErrorKind =
  | 'UNAUTHENTICATED'
  | 'INVALID_COUNTRY'
  | 'EMPTY_INPUT'
  | 'INPUT_TOO_LARGE'
  | 'NETWORK';

export class FollowedCountriesFetchError extends Error {
  readonly kind: FollowedCountriesErrorKind;
  constructor(kind: FollowedCountriesErrorKind, message: string) {
    super(message);
    this.name = 'FollowedCountriesFetchError';
    this.kind = kind;
  }
}

async function readErrorKind(res: Response): Promise<FollowedCountriesErrorKind> {
  if (res.status === 401) return 'UNAUTHENTICATED';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === 'string') {
      const k = body.error;
      if (k === 'INVALID_COUNTRY' || k === 'EMPTY_INPUT' || k === 'INPUT_TOO_LARGE') return k;
    }
  } catch {
    /* fall through to NETWORK */
  }
  return 'NETWORK';
}

interface FollowedCountriesBackend {
  list(): Promise<string[]>;
  follow(country: string): Promise<ServerFollowMutationResult>;
  unfollow(country: string): Promise<ServerFollowMutationResult>;
  merge(countries: string[]): Promise<ServerMergeAnonymousLocalResult>;
}

async function apiFetch(body: Record<string, unknown> | null): Promise<Response> {
  const token = await _getAuthTokenFn();
  if (!token) throw new FollowedCountriesFetchError('UNAUTHENTICATED', 'No auth token available');
  return fetch('/api/followed-countries', body
    ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }
    : { headers: { Authorization: `Bearer ${token}` } });
}

const defaultBackend: FollowedCountriesBackend = {
  async list() {
    const res = await apiFetch(null);
    if (!res.ok) throw new FollowedCountriesFetchError(await readErrorKind(res), `list failed: ${res.status}`);
    const data = (await res.json()) as { countries?: unknown };
    return Array.isArray(data?.countries)
      ? (data.countries.filter((c): c is string => typeof c === 'string'))
      : [];
  },
  async follow(country) {
    const res = await apiFetch({ action: 'follow', country });
    if (!res.ok) throw new FollowedCountriesFetchError(await readErrorKind(res), `follow failed: ${res.status}`);
    return (await res.json()) as ServerFollowMutationResult;
  },
  async unfollow(country) {
    const res = await apiFetch({ action: 'unfollow', country });
    if (!res.ok) throw new FollowedCountriesFetchError(await readErrorKind(res), `unfollow failed: ${res.status}`);
    return (await res.json()) as ServerFollowMutationResult;
  },
  async merge(countries) {
    const res = await apiFetch({ action: 'merge', countries });
    if (!res.ok) throw new FollowedCountriesFetchError(await readErrorKind(res), `merge failed: ${res.status}`);
    return (await res.json()) as ServerMergeAnonymousLocalResult;
  },
};

// ---------------------------------------------------------------------------
// Test-injection seams
// ---------------------------------------------------------------------------
//
// Node's `node:test` runner has no first-class ESM module mocker; rather
// than reach for ts-jest / vitest, we expose narrow setter hooks.
// Production callers never touch these.

type AuthUserGetter = () => { id: string } | null;
type EntitlementStateGetter = () => { features?: { tier?: number } } | null;
type HasTierFn = (minTier: number) => boolean;
type AuthTokenGetter = () => Promise<string | null>;

let _authUserGetter: AuthUserGetter = () =>
  _getCurrentAuthUser() as { id: string } | null;
let _entitlementStateGetter: EntitlementStateGetter = () =>
  _getEntitlementState();
let _hasTierFn: HasTierFn = (n) => _hasTier(n);
let _featureFlagOverride: boolean | null = null;
let _getAuthTokenFn: AuthTokenGetter = () => _getAuthToken();
let _backend: FollowedCountriesBackend = defaultBackend;

/**
 * Test-only override hook. Pass `null` to restore the real
 * implementations. Pass `backend: 'force-null'` to make every backend call
 * throw `UNAUTHENTICATED` without going through the production `fetch`
 * path (node:test has no `fetch` mock by default).
 */
export function _setDepsForTests(deps: {
  getCurrentAuthUser?: AuthUserGetter | null;
  getEntitlementState?: EntitlementStateGetter | null;
  hasTier?: HasTierFn | null;
  featureFlagEnabled?: boolean | null;
  getAuthToken?: AuthTokenGetter | null;
  backend?: Partial<FollowedCountriesBackend> | null | 'force-null';
}): void {
  if (deps.getCurrentAuthUser !== undefined) {
    _authUserGetter =
      deps.getCurrentAuthUser ??
      (() => _getCurrentAuthUser() as { id: string } | null);
  }
  if (deps.getEntitlementState !== undefined) {
    _entitlementStateGetter = deps.getEntitlementState ?? (() => _getEntitlementState());
  }
  if (deps.hasTier !== undefined) {
    _hasTierFn = deps.hasTier ?? ((n) => _hasTier(n));
  }
  if (deps.featureFlagEnabled !== undefined) {
    _featureFlagOverride = deps.featureFlagEnabled;
  }
  if (deps.getAuthToken !== undefined) {
    _getAuthTokenFn = deps.getAuthToken ?? (() => _getAuthToken());
  }
  if (deps.backend !== undefined) {
    if (deps.backend === null) {
      _backend = defaultBackend;
    } else if (deps.backend === 'force-null') {
      const alwaysUnauth = async () => {
        throw new FollowedCountriesFetchError('UNAUTHENTICATED', 'backend force-null for tests');
      };
      _backend = { list: alwaysUnauth, follow: alwaysUnauth, unfollow: alwaysUnauth, merge: alwaysUnauth };
    } else {
      _backend = { ...defaultBackend, ...deps.backend };
    }
  }
}

/** Test-only — clears all module-level state so tests start from a clean slate. */
export function _resetStateForTests(): void {
  _handoffState = 'idle';
  _handoffGeneration = 0;
  _handoffRetryAttempt = 0;
  _authListenerInstalled = false;
  _lastKnownSubscriptionSnapshot = null;
  _lastSeenUserId = null;
  if (_visibilityRetryListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityRetryListener);
  }
  _visibilityRetryListener = null;
  if (_crossTabStorageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', _crossTabStorageListener);
  }
  _crossTabStorageListener = null;
  if (_refetchListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _refetchListener);
    if (typeof window !== 'undefined') window.removeEventListener('focus', _refetchListener);
  }
  _refetchListener = null;
  if (typeof window !== 'undefined') {
    delete window.__wmFollowedCountries;
  }
}

/**
 * Test-only recovery hook. If a handoff entered 'failed-permanent', this
 * clears that latch and resets retry counters so a follow-up
 * `_emitAuthStateForTests` (or production sign-in) can re-attempt. Also
 * clears any visibilitychange retry listener.
 *
 * Production has no equivalent today: a permanent failure requires the
 * user to sign out and sign back in to start a fresh handoff generation.
 */
export function _clearFailedHandoffForTests(): void {
  _handoffRetryAttempt = 0;
  if (_handoffState === 'failed-permanent' || _handoffState === 'failed') {
    _handoffState = 'idle';
  }
  _clearVisibilityRetryListener();
}

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/**
 * Handoff state machine.
 *
 *  - 'idle'             : no signed-in user OR initial replay
 *  - 'pending'          : handoff in flight (await mergeAnonymousLocal)
 *  - 'failed'           : transient failure (network/backend unavailable);
 *                         visibilitychange retry scheduled
 *  - 'complete'         : handoff finished successfully; snapshot loaded
 *  - 'failed-permanent' : permanent failure (max-retry exhausted OR
 *                         server returned a permanent error such as
 *                         INPUT_TOO_LARGE/EMPTY_INPUT). localStorage
 *                         cleared; snapshot loaded; manual recovery only
 *                         via `_clearFailedHandoffForTests()`.
 */
let _handoffState:
  | 'idle'
  | 'pending'
  | 'failed'
  | 'complete'
  | 'failed-permanent' = 'idle';

/**
 * Incremented on every auth-state transition. Captured by handoff
 * callbacks before `await` and verified after, to drop stale results.
 * Mirrors the cloud-prefs-sync.ts `_authGeneration` pattern.
 */
let _handoffGeneration = 0;

/**
 * Counts visibilitychange-driven retries within a single handoff
 * generation. Reset to 0 when `_runHandoff` is invoked from
 * `onAuthStateChange` (fresh generation); incremented each time the
 * visibilitychange retry fires. After `MAX_HANDOFF_RETRIES` (5),
 * transition to 'failed-permanent' and stop scheduling retries.
 */
let _handoffRetryAttempt = 0;

/** Max visibilitychange-driven retry attempts per handoff generation. */
const MAX_HANDOFF_RETRIES = 5;

/** Exponential backoff schedule (ms) for retry attempt N (0-indexed). */
const HANDOFF_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/**
 * Test-only override for the backoff schedule. When set, replaces
 * `HANDOFF_RETRY_BACKOFF_MS` lookup. Tests use `[0, 0, ...]` to make
 * retries fire immediately (the visibility-event flow remains intact;
 * only the post-event delay is collapsed).
 */
let _handoffBackoffOverride: number[] | null = null;

function _backoffMsFor(attemptIndex: number): number {
  const schedule = _handoffBackoffOverride ?? HANDOFF_RETRY_BACKOFF_MS;
  const i = Math.min(attemptIndex, schedule.length - 1);
  return schedule[i] ?? 0;
}

/** Test-only — collapse retry backoff so tests don't need to wait seconds. */
export function _setHandoffBackoffForTests(schedule: number[] | null): void {
  _handoffBackoffOverride = schedule;
}

/**
 * User-scoped cache of the most recent `listFollowed` fetch. Cleared on
 * sign-out/user-switch (memory:
 * `session-storage-cross-user-leak-on-auth-transition`). `getFollowed()`
 * only unions this with localStorage if `userId === currentAuthUser.id`.
 */
let _lastKnownSubscriptionSnapshot:
  | { userId: string; countries: string[] }
  | null = null;

/** Last-observed signed-in user id, for diffing transitions inside the auth callback. */
let _lastSeenUserId: string | null = null;

/** Pending visibilitychange-retry listener (set when handoffState='failed'). */
let _visibilityRetryListener: (() => void) | null = null;

/**
 * Cross-tab `storage` event listener. When Tab-A mutates
 * `wm-followed-countries-v1`, every other tab fires a `storage` event. We
 * re-dispatch as `WM_FOLLOWED_COUNTRIES_CHANGED` so FollowButton
 * subscribers in Tab-B re-render. Installed once via
 * `installFollowedCountriesAuthListener()`.
 */
let _crossTabStorageListener: ((ev: StorageEvent) => void) | null = null;

/**
 * Refetch-on-focus listener (Stage 2 replacement for Convex's reactive
 * push). Fires on `visibilitychange` (tab becoming visible) and `focus`;
 * re-fetches `listFollowed` when signed in and handoff-complete, so
 * changes made in another tab/device eventually show up here without a
 * persistent connection.
 */
let _refetchListener: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Feature-flag gate
// ---------------------------------------------------------------------------

function isFeatureFlagEnabled(): boolean {
  if (_featureFlagOverride !== null) return _featureFlagOverride;
  // Default ON in dev/preview; OFF only when explicitly set to '0'.
  try {
    const flag = import.meta.env.VITE_FOLLOW_COUNTRIES_ENABLED;
    return flag !== '0';
  } catch {
    return true;
  }
}

/**
 * Public read-only mirror of the internal feature-flag check. Exposed so
 * UI helpers (e.g. FollowButton) gate on the same source of truth —
 * including the `_setDepsForTests({ featureFlagEnabled: ... })` override —
 * instead of duplicating the `import.meta.env` parse.
 */
export function isFollowFeatureEnabled(): boolean {
  return isFeatureFlagEnabled();
}

// ---------------------------------------------------------------------------
// Storage I/O — anonymous mode
// ---------------------------------------------------------------------------

interface StoredShape {
  countries: string[];
}

/**
 * Result of attempting to read the stored shape from localStorage:
 *  - { kind: 'absent' } — no key set
 *  - { kind: 'corrupt' } — non-JSON or wrong shape (caller should `removeItem`)
 *  - { kind: 'ok', list }
 *
 * Distinct from `readLocalStorageList` (which collapses absent/corrupt to
 * `[]`) because the sign-in handoff needs to differentiate "nothing to
 * merge" from "corrupt → clear unconditionally".
 */
function parseLocalStorageRaw(): { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'ok'; list: string[] } {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY)
      : null;
  } catch {
    return { kind: 'absent' };
  }
  if (!raw) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Partial<StoredShape>).countries)
  ) {
    return { kind: 'corrupt' };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of (parsed as StoredShape).countries) {
    if (typeof c !== 'string') continue;
    const norm = toIso2(c);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return { kind: 'ok', list: out };
}

function readLocalStorageList(): string[] {
  const r = parseLocalStorageRaw();
  return r.kind === 'ok' ? r.list : [];
}

/**
 * Returns `true` on success, `false` on storage quota / write failure.
 */
function writeLocalStorageList(list: string[]): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: list }),
    );
    return true;
  } catch {
    return false;
  }
}

function removeLocalStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(FOLLOWED_COUNTRIES_STORAGE_KEY);
    }
  } catch {
    /* swallow */
  }
}

function dispatchChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
  } catch {
    // jsdom-less test envs may not have CustomEvent; swallow.
  }
}

// ---------------------------------------------------------------------------
// Entitlement + auth state resolution
// ---------------------------------------------------------------------------

/**
 * Returns the effective service-level entitlement state.
 *
 *  - Anonymous (no signed-in user) → `'free'` (NEVER `'loading'`;
 *    otherwise anon users would be permanently blocked because
 *    `getEntitlementState()` returns null without a session).
 *  - Signed-in, entitlement snapshot not yet arrived → `'loading'`.
 *  - Signed-in, snapshot arrived → `'pro'` (every signed-in user is fully
 *    entitled post-Stage-1; this distinction no longer gates any follow
 *    behavior, just the FollowButton's loading spinner).
 */
export function serviceEntitlementState(): ServiceEntitlementState {
  const user = _authUserGetter();
  if (!user) return 'free';
  const ent = _entitlementStateGetter();
  if (ent === null) return 'loading';
  return _hasTierFn(1) ? 'pro' : 'free';
}

// ---------------------------------------------------------------------------
// Auth-state listener
// ---------------------------------------------------------------------------

let _authListenerInstalled = false;

function installFollowedCountriesGlobal(): void {
  if (typeof window === 'undefined') return;
  window.__wmFollowedCountries = { getFollowed };
}

/**
 * Install the auth-state listener, the cross-tab `storage` listener, and
 * the refetch-on-focus listener. Idempotent. Called once from app boot.
 * Tests don't call this; they drive the auth-state callback manually via
 * `_emitAuthStateForTests`.
 */
export function installFollowedCountriesAuthListener(): void {
  if (!isFollowFeatureEnabled()) return;
  installFollowedCountriesGlobal();
  if (_authListenerInstalled) return;
  _authListenerInstalled = true;
  _subscribeAuthState((state) => {
    void onAuthStateChange(state.user ? { id: state.user.id } : null);
  });
  _installCrossTabStorageListener();
  _installRefetchListener();
}

function _installCrossTabStorageListener(): void {
  if (_crossTabStorageListener) return;
  if (typeof window === 'undefined') return;
  const handler = (ev: StorageEvent): void => {
    if (ev.key !== FOLLOWED_COUNTRIES_STORAGE_KEY) return;
    dispatchChanged();
  };
  window.addEventListener('storage', handler);
  _crossTabStorageListener = handler;
}

/**
 * Test-only — install the cross-tab storage listener without going
 * through `installFollowedCountriesAuthListener` (which also wires the
 * auth listener + refetch listener). Lets tests assert the storage→change
 * fan-out in isolation.
 */
export function _installCrossTabStorageListenerForTests(): void {
  _installCrossTabStorageListener();
}

/**
 * Refetch-on-focus (Stage 2 replacement for Convex's reactive push). Only
 * re-fetches when signed in and handoff-complete — anonymous mode and
 * in-flight handoffs have nothing useful to refetch.
 */
function _installRefetchListener(): void {
  if (_refetchListener) return;
  if (typeof document === 'undefined') return;
  const handler = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const user = _authUserGetter();
    if (!user || _handoffState !== 'complete') return;
    void _refreshSnapshot(user.id, _handoffGeneration);
  };
  document.addEventListener('visibilitychange', handler);
  if (typeof window !== 'undefined') window.addEventListener('focus', handler);
  _refetchListener = handler;
}

/** Test-only — drive the refetch-on-focus listener directly. */
export function _triggerRefetchForTests(): Promise<void> {
  const user = _authUserGetter();
  if (!user || _handoffState !== 'complete') return Promise.resolve();
  return _refreshSnapshot(user.id, _handoffGeneration);
}

/**
 * Test-only: drive the auth-state callback directly without installing
 * the real auth listener. Always returns a Promise that resolves once
 * the handoff (if any) has fully resolved or dropped.
 */
export function _emitAuthStateForTests(
  nextUser: { id: string } | null,
): Promise<void> {
  return onAuthStateChange(nextUser);
}

/**
 * Auth-state transition handler. Called once at module-init with the
 * current state, then on every auth transition.
 *
 * Transitions handled:
 *  - null → user        : start sign-in handoff
 *  - userA → userB       : sign-out cleanup THEN start handoff for userB
 *  - user → null         : sign-out cleanup
 *  - null → null         : ignore (initial replay)
 *  - same user → same    : ignore (auth provider re-emit on tab focus etc.)
 */
async function onAuthStateChange(
  nextUser: { id: string } | null,
): Promise<void> {
  const prevUserId = _lastSeenUserId;
  const nextUserId = nextUser?.id ?? null;

  if (prevUserId === nextUserId) {
    return;
  }
  _lastSeenUserId = nextUserId;

  _handoffGeneration += 1;
  _lastKnownSubscriptionSnapshot = null;
  _clearVisibilityRetryListener();

  if (!nextUser) {
    _handoffState = 'idle';
    return;
  }

  if (prevUserId !== null) {
    _handoffGeneration += 1;
  }

  const gen = _handoffGeneration;
  const userIdAtStart = nextUser.id;
  _handoffState = 'pending';
  _handoffRetryAttempt = 0;

  await _runHandoff(userIdAtStart, gen);
}

/**
 * Core handoff procedure. Extracted so the visibilitychange retry can
 * call it again with a fresh generation capture.
 *
 * Permanent error kinds (INPUT_TOO_LARGE/EMPTY_INPUT) are NOT retried;
 * they transition the state machine to 'failed-permanent', clear
 * localStorage (since the input shape is the problem), and load the
 * snapshot so `getFollowed` still works.
 *
 * `UNAUTHENTICATED` is transient (not permanent) — the auth-state
 * listener can fire before `getAuthToken()` has a fresh token available;
 * the visibilitychange retry path re-attempts.
 *
 * Max-retry counter (5) + exponential backoff (1, 2, 4, 8, 16 seconds)
 * gates the visibilitychange retry path. After exhaustion, the state
 * flips to 'failed-permanent' and no further retries are scheduled.
 */
async function _runHandoff(
  userIdAtStart: string,
  gen: number,
): Promise<void> {
  const parsed = parseLocalStorageRaw();
  if (parsed.kind === 'corrupt') {
    removeLocalStorage();
  }

  const localList = parsed.kind === 'ok' ? parsed.list : [];

  if (localList.length === 0) {
    if (!_authStillMatches(userIdAtStart, gen)) return;
    _handoffState = 'complete';
    await _refreshSnapshot(userIdAtStart, gen);
    return;
  }

  let result: ServerMergeAnonymousLocalResult;
  try {
    if (!_authStillMatches(userIdAtStart, gen)) return;
    result = await _backend.merge(localList);
  } catch (err) {
    if (!_authStillMatches(userIdAtStart, gen)) return;
    const kind = err instanceof FollowedCountriesFetchError ? err.kind : null;
    if (kind === 'INPUT_TOO_LARGE' || kind === 'EMPTY_INPUT') {
      console.warn(
        `[followed-countries] handoff permanent failure (kind=${kind}); clearing localStorage`,
      );
      removeLocalStorage();
      _handoffState = 'failed-permanent';
      await _refreshSnapshot(userIdAtStart, gen);
      return;
    }
    // Transient (network / backend unavailable / UNAUTHENTICATED race).
    _markFailedAndScheduleRetry(userIdAtStart, gen);
    return;
  }

  if (!_authStillMatches(userIdAtStart, gen)) return;

  removeLocalStorage();
  _handoffState = 'complete';
  // The merge response already tells us the accepted set; seed the
  // snapshot directly rather than round-tripping a fresh `list()` call.
  _lastKnownSubscriptionSnapshot = {
    userId: userIdAtStart,
    countries: [...new Set([...result.accepted])],
  };
  dispatchChanged();
  // Reconcile against the server once more in the background — the seeded
  // snapshot above only has the newly-accepted rows, not any rows that
  // may already have existed server-side from a prior partial handoff.
  void _refreshSnapshot(userIdAtStart, gen);
}

/**
 * Central retry-budget enforcer. Either schedules a visibilitychange
 * retry (with the exponential-backoff delay scaled by
 * `_handoffRetryAttempt`) OR transitions to 'failed-permanent' if the
 * budget is exhausted.
 */
function _markFailedAndScheduleRetry(
  userIdAtStart: string,
  gen: number,
): void {
  if (_handoffRetryAttempt >= MAX_HANDOFF_RETRIES) {
    console.warn(
      `[followed-countries] handoff retry budget exhausted (${MAX_HANDOFF_RETRIES}); marking permanent`,
    );
    _handoffState = 'failed-permanent';
    _clearVisibilityRetryListener();
    void _refreshSnapshot(userIdAtStart, gen);
    return;
  }
  _handoffState = 'failed';
  _scheduleVisibilityChangeRetry(userIdAtStart, gen);
}

function _authStillMatches(userIdAtStart: string, gen: number): boolean {
  if (gen !== _handoffGeneration) return false;
  const current = _authUserGetter();
  if (!current || current.id !== userIdAtStart) return false;
  return true;
}

function _scheduleVisibilityChangeRetry(
  userIdAtStart: string,
  gen: number,
): void {
  if (typeof document === 'undefined') return;
  _clearVisibilityRetryListener();
  const handler = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    _clearVisibilityRetryListener();
    if (!_authStillMatches(userIdAtStart, gen)) return;
    const backoffMs = _backoffMsFor(_handoffRetryAttempt);
    _handoffRetryAttempt += 1;
    if (backoffMs > 0 && typeof setTimeout !== 'undefined') {
      setTimeout(() => {
        if (!_authStillMatches(userIdAtStart, gen)) return;
        void _runHandoff(userIdAtStart, gen);
      }, backoffMs);
    } else {
      void _runHandoff(userIdAtStart, gen);
    }
  };
  document.addEventListener('visibilitychange', handler);
  _visibilityRetryListener = handler;
}

function _clearVisibilityRetryListener(): void {
  if (_visibilityRetryListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityRetryListener);
  }
  _visibilityRetryListener = null;
}

/**
 * Test-only: trigger the pending visibilitychange retry without going
 * through the real DOM event. Returns a promise that resolves when the
 * retry's handoff finishes.
 */
export function _triggerVisibilityRetryForTests(): Promise<void> {
  if (!_visibilityRetryListener) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const handler = _visibilityRetryListener;
    if (!handler) {
      resolve();
      return;
    }
    _clearVisibilityRetryListener();
    handler();
    queueMicrotask(() => queueMicrotask(() => resolve()));
  });
}

// ---------------------------------------------------------------------------
// Snapshot refresh (Stage 2 replacement for the Convex reactive subscription)
// ---------------------------------------------------------------------------

/**
 * Fetch the authoritative watchlist and update the local snapshot. Used
 * after handoff completion and on refetch-on-focus. Silently no-ops on
 * failure (leaves the last-known snapshot in place) — same "eventually
 * consistent, never throws" posture the reactive subscription had.
 */
async function _refreshSnapshot(userIdAtStart: string, gen: number): Promise<void> {
  try {
    const countries = await _backend.list();
    if (!_authStillMatches(userIdAtStart, gen)) return;
    _lastKnownSubscriptionSnapshot = { userId: userIdAtStart, countries };
    dispatchChanged();
  } catch (err) {
    console.warn('[followed-countries] listFollowed refresh failed:', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current followed list as an ISO-2 array.
 *
 * Anonymous mode: localStorage. Signed-in mode: user-scoped server
 * snapshot. During handoffPending: union of localStorage + the
 * user-scoped snapshot (only if `snap.userId === currentAuthUser.id`).
 *
 * Sync, never throws. Empty/corrupt storage → [].
 */
export function getFollowed(): string[] {
  const user = _authUserGetter();
  const localList = readLocalStorageList();

  if (!user) return localList;

  const snap = _lastKnownSubscriptionSnapshot;
  const snapList = snap && snap.userId === user.id ? snap.countries : [];

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return [...new Set([...localList, ...snapList])];
  }

  if (_handoffState === 'complete' || _handoffState === 'failed-permanent') {
    return [...new Set(snapList)];
  }

  // 'idle' shouldn't be reachable when there's a signed-in user (the
  // listener flips to 'pending' on transition). Fallback: defensive.
  return snap && snap.userId === user.id ? [...snap.countries] : localList;
}

/** Sync `isFollowed` check; case-folds via `toIso2`. */
export function isFollowed(code: string): boolean {
  const norm = toIso2(code);
  if (!norm) return false;
  return getFollowed().includes(norm);
}

/**
 * Add a country to the followed list. Idempotent. Never throws —
 * returns a `FollowMutationResult` discriminated union.
 */
export async function addCountry(input: string): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return { ok: false, reason: 'HANDOFF_PENDING' };
  }

  const ent = serviceEntitlementState();
  if (ent === 'loading') {
    return { ok: false, reason: 'ENTITLEMENT_LOADING' };
  }

  const user = _authUserGetter();

  if (user) {
    const userIdAtStart = user.id;
    const genAtStart = _handoffGeneration;
    try {
      const result = await _backend.follow(code);
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      // Optimistic local update — no reactive push to wait for anymore.
      const snap = _lastKnownSubscriptionSnapshot;
      const countries = snap && snap.userId === userIdAtStart ? snap.countries : [];
      if (!countries.includes(code)) {
        _lastKnownSubscriptionSnapshot = { userId: userIdAtStart, countries: [...countries, code] };
      }
      dispatchChanged();
      void result; // idempotent flag is informational only
      return { ok: true };
    } catch (err) {
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      const kind = err instanceof FollowedCountriesFetchError ? err.kind : null;
      if (kind === 'INVALID_COUNTRY') {
        return { ok: false, reason: 'INVALID_INPUT' };
      }
      if (kind === 'UNAUTHENTICATED') {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      console.warn('[followed-countries] followCountry unknown error:', err);
      return { ok: false, reason: 'HANDOFF_PENDING' };
    }
  }

  // Anonymous mode — localStorage path.
  const existing = getFollowed();
  if (existing.includes(code)) {
    return { ok: true };
  }
  return _writeLocalStorageAdd(code);
}

function _writeLocalStorageAdd(code: string): FollowMutationResult {
  const existing = readLocalStorageList();
  if (existing.includes(code)) return { ok: true };
  const next = [...existing, code];
  const wrote = writeLocalStorageList(next);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };
  dispatchChanged();
  return { ok: true };
}

/**
 * Remove a country from the followed list. Idempotent — removing a
 * country that isn't in the list returns `{ok:true}`.
 */
export async function removeCountry(
  input: string,
): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return { ok: false, reason: 'HANDOFF_PENDING' };
  }

  const user = _authUserGetter();

  if (user) {
    const userIdAtStart = user.id;
    const genAtStart = _handoffGeneration;
    try {
      await _backend.unfollow(code);
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      const snap = _lastKnownSubscriptionSnapshot;
      if (snap && snap.userId === userIdAtStart && snap.countries.includes(code)) {
        _lastKnownSubscriptionSnapshot = {
          userId: userIdAtStart,
          countries: snap.countries.filter((c) => c !== code),
        };
      }
      dispatchChanged();
      return { ok: true };
    } catch (err) {
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      const kind = err instanceof FollowedCountriesFetchError ? err.kind : null;
      if (kind === 'INVALID_COUNTRY') {
        return { ok: false, reason: 'INVALID_INPUT' };
      }
      if (kind === 'UNAUTHENTICATED') {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      console.warn('[followed-countries] unfollowCountry unknown error:', err);
      return { ok: false, reason: 'HANDOFF_PENDING' };
    }
  }

  // Anonymous mode.
  const existing = readLocalStorageList();
  if (!existing.includes(code)) return { ok: true };
  return _writeLocalStorageRemove(code);
}

function _writeLocalStorageRemove(code: string): FollowMutationResult {
  const existing = readLocalStorageList();
  if (!existing.includes(code)) return { ok: true };
  const next = existing.filter((c) => c !== code);
  const wrote = writeLocalStorageList(next);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };
  dispatchChanged();
  return { ok: true };
}

/**
 * Subscribe to followed-list changes. Fires after every successful
 * `addCountry` / `removeCountry`, after handoff completion, and after
 * every refetch-on-focus snapshot refresh.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(handler: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {
      /* no-op in non-browser env */
    };
  }
  window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  return () => {
    window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  };
}

/**
 * Test-only: snapshot of internal state for assertion. Production
 * callers must NOT rely on this shape — it is private.
 */
export function _getInternalStateForTests(): {
  handoffState: typeof _handoffState;
  handoffGeneration: number;
  handoffRetryAttempt: number;
  lastKnownSubscriptionSnapshot:
    | { userId: string; countries: string[] }
    | null;
  hasVisibilityRetryListener: boolean;
  hasCrossTabStorageListener: boolean;
  hasRefetchListener: boolean;
} {
  return {
    handoffState: _handoffState,
    handoffGeneration: _handoffGeneration,
    handoffRetryAttempt: _handoffRetryAttempt,
    lastKnownSubscriptionSnapshot: _lastKnownSubscriptionSnapshot
      ? {
          userId: _lastKnownSubscriptionSnapshot.userId,
          countries: [..._lastKnownSubscriptionSnapshot.countries],
        }
      : null,
    hasVisibilityRetryListener: _visibilityRetryListener !== null,
    hasCrossTabStorageListener: _crossTabStorageListener !== null,
    hasRefetchListener: _refetchListener !== null,
  };
}

/**
 * Test-only: push a snapshot directly as if a `listFollowed` fetch just
 * resolved. Mocking `_backend.list` and calling `_triggerRefetchForTests`
 * is also fine; this helper is a convenience for tests that don't want to
 * drive a full fetch round-trip.
 */
export function _pushSubscriptionSnapshotForTests(
  userId: string,
  countries: string[],
): void {
  const current = _authUserGetter();
  if (!current || current.id !== userId) return;
  _lastKnownSubscriptionSnapshot = { userId, countries: [...countries] };
  dispatchChanged();
}
