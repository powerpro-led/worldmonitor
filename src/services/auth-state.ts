import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { getCurrentAuthUser, scheduleAuthProviderLoad, subscribeAuthProvider } from './auth-provider';

/** Minimal user profile exposed to UI components. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: 'free' | 'pro';
}

/** Simplified auth session state for UI consumption. */
export interface AuthSession {
  user: AuthUser | null;
  isPending: boolean;
}

let _currentSession: AuthSession = { user: null, isPending: true };

function snapshotSession(): AuthSession {
  const cu = getCurrentAuthUser();
  if (!cu) {
    enqueueSentryCall((s) => s.setUser(null));
    return { user: null, isPending: false };
  }
  enqueueSentryCall((s) => s.setUser({ id: cu.id }));
  return {
    user: {
      id: cu.id,
      name: cu.name,
      email: cu.email,
      image: cu.image,
      role: cu.plan,
    },
    isPending: false,
  };
}

/**
 * Initialize auth state. Call once at app startup before UI subscribes.
 *
 * Does NOT await `initAuthProvider()` — scheduled off the critical path via
 * `scheduleAuthProviderLoad()` (idle-callback after first paint) so App.init()
 * (panel layout, data fetches, etc.) isn't blocked on the initial
 * `getSession()` round-trip.
 *
 * Leaves `_currentSession` at the module-level default
 * `{ user: null, isPending: true }` — calling `snapshotSession()` here
 * would flip `isPending` to `false` before the Supabase client has even
 * checked for an existing session, which subscribers cannot distinguish
 * from a settled signed-out session. The pending-subscriber behavior in
 * auth-provider.ts fires the subscribeAuthState listener as soon as init
 * completes, snapshots the real session, and flips `isPending` to `false`.
 */
export async function initAuthState(): Promise<void> {
  scheduleAuthProviderLoad();
}

/**
 * Subscribe to reactive auth state changes.
 * @returns Unsubscribe function.
 */
export function subscribeAuthState(callback: (state: AuthSession) => void): () => void {
  // Emit current state immediately
  callback(_currentSession);

  return subscribeAuthProvider(() => {
    _currentSession = snapshotSession();
    callback(_currentSession);
  });
}

/**
 * Synchronous snapshot of current auth state.
 */
export function getAuthState(): AuthSession {
  return _currentSession;
}
