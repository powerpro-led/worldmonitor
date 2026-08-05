import { signInWithGithub } from '@/services/auth-provider';

/**
 * Minimal auth launcher -- wraps signInWithGithub() (GitHub OAuth redirect).
 * Replaces the custom OTP modal. There is no separate sign-up flow post
 * Stage-1 migration: GitHub OAuth sign-in and sign-up are the same action,
 * the org-gate hook decides allow/deny either way.
 */
export class AuthLauncher {
  public open(): void {
    void signInWithGithub();
  }

  public openSignUp(): void {
    void signInWithGithub();
  }

  public close(): void {
    // signInWithGithub() is a real browser redirect; nothing to close.
  }

  public destroy(): void {
    // Nothing to clean up -- no modal lifecycle to manage.
  }
}
