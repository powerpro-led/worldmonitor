/**
 * Analytics facade — intentionally inert.
 *
 * This fork is an internal tool, not a public SaaS product, so the Umami
 * integration that used to back these calls (a self-hosted collector on the
 * `abacus.` subdomain, plus a hardcoded production website id) was removed.
 *
 * The facade itself is kept because ~40 modules call into it. Every function
 * below is a no-op, and `EVENTS` is retained so event names stay a closed,
 * compile-checked set: a typo at a call site is still a type error, and the
 * catalog documents what the UI considers a meaningful user action. Wire a
 * new backend by giving `track()` / `identifyUser()` a body — nothing else
 * needs to change.
 */

import { subscribeAuthState, type AuthSession } from './auth-state';
import { getAuthUserCreatedAt } from './auth-provider';


// ---------------------------------------------------------------------------
// Type-safe event catalog — every event name lives here.
// Typo in an event string = compile error.
// ---------------------------------------------------------------------------

const EVENTS = {
  // Search
  'search-open': true,
  'search-used': true,
  'search-result-selected': true,
  // Country / map
  'country-selected': true,
  'country-brief-opened': true,
  'map-layer-toggle': true,
  // Panels
  'panel-toggle': true,
  // Settings
  'settings-open': true,
  'variant-switch': true,
  'theme-changed': true,
  'language-change': true,
  'feature-toggle': true,
  // News
  'news-sort-toggle': true,
  'news-summarize': true,
  // Downloads / banners
  'download-clicked': true,
  'critical-banner': true,
  // AI widget
  'widget-ai-open': true,
  'widget-ai-generate': true,
  'widget-ai-success': true,
  // WM Analyst dashboard control
  'analyst-control-action': true,
  // MCP
  'mcp-connect-attempt': true,
  'mcp-connect-success': true,
  'mcp-panel-add': true,
  // WebMCP (in-page agent tool surface)
  'webmcp-registered': true,
  'webmcp-tool-invoked': true,
  // Route Explorer
  'route-explorer:opened': true,
  'route-explorer:query': true,
  'route-explorer:tab-switch': true,
  'route-explorer:alternative-selected': true,
  'route-explorer:impact-viewed': true,
  'route-explorer:share-copied': true,
  'route-explorer:free-cta-click': true,
  'route-explorer:closed': true,
  // Auth (wired in PR #1812 — do not remove)
  'sign-in': true,
  'sign-up': true,
  'sign-out': true,
  'gate-hit': true,
  // Brief — open-rate lift measurement for U10's followed-country bias
  // (followed-countries plan U11). Fired from the dashboard cover card
  // and from the hosted magazine source-link clicks. `followed` flags
  // whether the click target maps to a country the user follows;
  // correlate with non-followed threads to size the bias's effect.
  'brief-thread-open': true,
} as const;

export type AnalyticsEvent = keyof typeof EVENTS;


/** No-op sink. Event names are still type-checked against EVENTS. */
export function track(_event: AnalyticsEvent, _data?: Record<string, unknown>): void {}

export function initAnalytics(): void {}

// ---------------------------------------------------------------------------
// User identity — retained so the auth wiring below keeps a single place to
// re-attach a backend. Inert while there is no analytics sink.
// ---------------------------------------------------------------------------

export function identifyUser(_userId: string, _plan: string): void {}

export function clearIdentity(): void {}

let _unsubAuth: (() => void) | null = null;

// Cached latest value so re-subscriptions can re-identify with full data
let _lastAuth: AuthSession | null = null;

function _syncIdentity(): void {
  const user = _lastAuth?.user;
  if (user) {
    identifyUser(user.id, user.role);
  } else {
    clearIdentity();
  }
}

/**
 * Call once after initAuthState() to keep analytics identity in sync with
 * the authenticated user and their subscription status.
 * Re-entrant safe: subsequent calls are no-ops.
 */
export function initAuthAnalytics(): void {
  if (_unsubAuth) return;

  _unsubAuth = subscribeAuthState((state) => {
    const prevUserId = _lastAuth?.user?.id ?? null;
    const nextUserId = state.user?.id ?? null;
    if (prevUserId !== nextUserId) {
      // Detect a genuine sign-UP (not a sign-in). Null→non-null id transition
      // plus a createdAt within FRESH_SIGNUP_WINDOW_MS of now means Supabase
      // just created this account. Firing trackSignUp on the button click
      // would conflate "opened the sign-up modal" with "completed the flow";
      // gating on createdAt freshness captures the successful-completion
      // signal we actually want to measure.
      //
      // Durable fire-once guard: `_lastAuth` resets to null on every page
      // load, so without a persisted marker the null→user transition looks
      // identical on the completion reload and on any reload within the
      // 60s freshness window. We'd re-fire trackSignUp on every tab
      // refresh until createdAt ages out, inflating the signup count.
      // sessionStorage scopes the marker to the browser tab — tight enough
      // that re-install / new session reliably re-counts, wide enough that
      // a reload mid-signup doesn't double-count.
      if (
        nextUserId !== null &&
        !hasTrackedSignupInSession(nextUserId) &&
        isLikelyFreshSignup(prevUserId, nextUserId, getAuthUserCreatedAt(), Date.now())
      ) {
        trackSignUp('github');
        markSignupTrackedInSession(nextUserId);
      }
    }
    _lastAuth = state;
    _syncIdentity();
  });
}

/** Tear down the auth listener. Symmetric with initAuthAnalytics(). */
export function destroyAuthAnalytics(): void {
  _unsubAuth?.();
  _unsubAuth = null;
  _lastAuth = null;
  clearIdentity();
}

// ---------------------------------------------------------------------------
// Auth events
// ---------------------------------------------------------------------------

export function trackSignIn(method: string): void {
  track('sign-in', { method });
}

export function trackSignUp(method: string): void {
  track('sign-up', { method });
}

export function trackAnalystControlAction(actionType: string, status: string, reason?: string): void {
  track('analyst-control-action', {
    actionType,
    status,
    ...(reason ? { reason } : {}),
  });
}

/**
 * Window during which a freshly-observed Clerk `createdAt` is treated
 * as "this user just signed up." 60s is conservative enough to survive
 * network jitter between Clerk's user.created and the client seeing
 * the auth-state transition, while staying tight enough to reject
 * returning-user sign-ins on accounts created weeks ago.
 */
export const FRESH_SIGNUP_WINDOW_MS = 60_000;

/**
 * Pure predicate: was the just-observed auth transition a fresh sign-up?
 *
 * Exported for testability. Do not read Date.now() or Clerk state from
 * inside this function — callers pass both, so tests can pin time and
 * user state.
 */
/**
 * Lower bound for clock skew. A createdAt earlier-than-now by up to
 * this amount is treated as "now" for freshness purposes — tolerates
 * client clocks that lag the server. Bigger negatives (createdAt
 * unrealistically far in the future) are rejected as malformed.
 */
const FRESH_SIGNUP_CLOCK_SKEW_MS = 5_000;

/**
 * localStorage-backed fire-once guard, keyed by user id. Originally used
 * sessionStorage but sessionStorage is per-TAB — a user who signs up and
 * then opens a second tab on the app within the 60s createdAt freshness
 * window would fire a second trackSignUp from that fresh tab's
 * `_lastAuth=null → user` transition. localStorage is shared across
 * tabs in the same browser profile, so once any tab marks the user as
 * tracked, no other tab for the same user will re-fire.
 *
 * Keyed per user id so account switches within the same browser still
 * correctly track each user's first signup (rare but valid). The key
 * never needs to be cleaned up because Clerk user ids are effectively
 * unique forever — a deleted user's key is harmless and the storage
 * footprint is trivial (one byte per user who ever signed up here).
 *
 * Read/write are try/catched because storage throws in private-mode /
 * quota-exceeded / disabled scenarios; we fail open (track, don't
 * persist) rather than swallow signups.
 */
const SIGNUP_TRACKED_KEY_PREFIX = 'wm-signup-tracked:';

export function hasTrackedSignupInSession(userId: string): boolean {
  try {
    return window.localStorage.getItem(SIGNUP_TRACKED_KEY_PREFIX + userId) === '1';
  } catch {
    return false;
  }
}

export function markSignupTrackedInSession(userId: string): void {
  try {
    window.localStorage.setItem(SIGNUP_TRACKED_KEY_PREFIX + userId, '1');
  } catch {
    // Storage unavailable — we'll just risk a single double-count on
    // reload instead of crashing analytics init.
  }
}

export function isLikelyFreshSignup(
  prevUserId: string | null,
  nextUserId: string | null,
  createdAtMs: number | null,
  nowMs: number,
): boolean {
  if (prevUserId !== null) return false;
  if (nextUserId === null) return false;
  if (createdAtMs === null) return false;
  const age = nowMs - createdAtMs;
  // Accept:   -5s  ≤ age ≤ 60s  (brief clock skew tolerance + fresh window)
  // Reject: < -5s (createdAt unrealistically far in the future — malformed)
  //         > 60s (returning user, not a fresh signup)
  return age >= -FRESH_SIGNUP_CLOCK_SKEW_MS && age <= FRESH_SIGNUP_WINDOW_MS;
}

export function trackSignOut(): void {
  track('sign-out');
}

/**
 * Test-only: reset module-level deferred-load state so each test starts from
 * a clean slate. The queue and load guards are module singletons that persist
 * across the shared module import in tests/secondary-startup.test.mts.
 */
export function resetAnalyticsForTesting(): void {}

export function trackGateHit(feature: string): void {
  track('gate-hit', { feature });
}

// ---------------------------------------------------------------------------
// Generic (were already no-ops before the backend was removed — too noisy)
// ---------------------------------------------------------------------------

export function trackEvent(_name: string, _props?: Record<string, unknown>): void {}
export function trackEventBeforeUnload(_name: string, _props?: Record<string, unknown>): void {}
export function trackPanelView(_panelId: string): void {}
export function trackApiKeysSnapshot(): void {}
export function trackUpdateShown(_current: string, _remote: string): void {}
export function trackUpdateClicked(_version: string): void {}
export function trackUpdateDismissed(_version: string): void {}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function trackSearchUsed(queryLength: number, resultCount: number): void {
  track('search-used', { queryLength, resultCount });
}

export function trackSearchResultSelected(resultType: string): void {
  track('search-result-selected', { type: resultType });
}

// ---------------------------------------------------------------------------
// Country / map
// ---------------------------------------------------------------------------

export function trackCountrySelected(code: string, name: string, source: string): void {
  track('country-selected', { code, name, source });
}

export function trackCountryBriefOpened(countryCode: string): void {
  track('country-brief-opened', { code: countryCode });
}

// ---------------------------------------------------------------------------
// Brief thread-open (followed-countries plan, U11)
// ---------------------------------------------------------------------------

export type BriefThreadOpenSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info'
  | null;

export interface BriefThreadOpenProps {
  /** ISO-2 country code, or null when no primary country attaches. */
  country: string | null;
  /** True iff the user follows `country` at click time. */
  followed: boolean;
  severity: BriefThreadOpenSeverity;
  /** Where the click originated. */
  source: 'dashboard' | 'magazine';
}

/**
 * Fire-and-forget. Wrap call sites in try/catch anyway so a future
 * regression in `track` cannot break navigation UX.
 */
export function trackBriefThreadOpen(props: BriefThreadOpenProps): void {
  track('brief-thread-open', {
    country: props.country,
    followed: props.followed,
    severity: props.severity,
    source: props.source,
  });
}

export function trackMapLayerToggle(layerId: string, enabled: boolean, source: 'user' | 'programmatic'): void {
  if (source !== 'user') return;
  track('map-layer-toggle', { layerId, enabled });
}

export function trackMapViewChange(_view: string): void {
  // No-op: low analytical value.
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function trackPanelToggled(panelId: string, enabled: boolean): void {
  track('panel-toggle', { panelId, enabled });
}

export function trackPanelResized(_panelId: string, _newSpan: number): void {
  // No-op: fires on every drag step, too noisy for analytics.
}

// ---------------------------------------------------------------------------
// App-wide settings
// ---------------------------------------------------------------------------

export function trackVariantSwitch(from: string, to: string): void {
  track('variant-switch', { from, to });
}

export function trackThemeChanged(theme: string): void {
  track('theme-changed', { theme });
}

export function trackLanguageChange(language: string): void {
  track('language-change', { language });
}

export function trackFeatureToggle(featureId: string, enabled: boolean): void {
  track('feature-toggle', { featureId, enabled });
}

// ---------------------------------------------------------------------------
// AI / LLM
// ---------------------------------------------------------------------------

export function trackLLMUsage(_provider: string, _model: string, _cached: boolean): void {
  // No-op: per-request noise, not a meaningful user action for analytics.
}

export function trackLLMFailure(_lastProvider: string): void {
  // No-op: per-request noise, not a meaningful user action for analytics.
}

// ---------------------------------------------------------------------------
// Downloads / banners / findings
// ---------------------------------------------------------------------------

export function trackCriticalBannerAction(action: string, theaterId: string): void {
  track('critical-banner', { action, theaterId });
}

export function trackFindingClicked(_id: string, _source: string, _type: string, _priority: string): void {
  // No-op: niche feature, low analytical value.
}

export function trackDeeplinkOpened(_type: string, _target: string): void {
  // No-op: not useful for analytics.
}
