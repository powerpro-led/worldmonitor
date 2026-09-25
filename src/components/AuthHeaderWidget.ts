import { subscribeAuthState, type AuthSession } from '@/services/auth-state';
import { getCurrentAuthUser, signInWithGithub, signOut } from '@/services/auth-provider';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml, clearChildren } from '@/utils/dom-utils';


export class AuthHeaderWidget {
  private container: HTMLElement;
  private unsubscribeAuth: (() => void) | null = null;
  private onSignInClick?: () => void;
  private onSettingsClick?: () => void;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  // Set for the duration of the VS-Code-embed GitHub sign-in flow (ticket
  // fetch + OAuth redirect chain — a few seconds before the page navigates
  // away). Without this the button just sits there after a click with no
  // feedback, which a 2026-09-25 live test called out as "looks dead" —
  // there was no visual difference between "processing" and "did nothing".
  // Not used for the onSignInClick (modal) path: that opens its own UI
  // synchronously, nothing to wait on here.
  private signingIn = false;

  constructor(onSignInClick?: () => void, onSettingsClick?: () => void) {
    this.onSignInClick = onSignInClick;
    this.onSettingsClick = onSettingsClick;
    this.container = document.createElement('div');
    this.container.className = 'auth-header-widget';

    this.unsubscribeAuth = subscribeAuthState((state: AuthSession) => {
      if (state.isPending) {
        this.renderPending();
        return;
      }
      this.render(state);
    });
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.detachMenuListeners();
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  }

  private render(state: AuthSession): void {
    this.detachMenuListeners();
    this.container.classList.remove('auth-header-widget-pending');
    this.container.removeAttribute('aria-busy');
    setTrustedHtml(this.container, trustedHtml('', "legacy direct innerHTML migration"));

    if (!state.user) {
      this.renderSignedOut();
      return;
    }
    this.renderSignedIn();
  }

  private renderPending(): void {
    this.detachMenuListeners();
    this.container.classList.add('auth-header-widget-pending');
    this.container.setAttribute('aria-busy', 'true');
    setTrustedHtml(this.container, trustedHtml('', "legacy direct innerHTML migration"));

    const signInSkeleton = document.createElement('span');
    signInSkeleton.className = 'auth-header-skeleton auth-header-skeleton-signin';
    signInSkeleton.setAttribute('aria-hidden', 'true');
    this.container.appendChild(signInSkeleton);

    const signUpSkeleton = document.createElement('span');
    signUpSkeleton.className = 'auth-header-skeleton auth-header-skeleton-signup';
    signUpSkeleton.setAttribute('aria-hidden', 'true');
    this.container.appendChild(signUpSkeleton);
  }

  private renderSignedOut(): void {
    clearChildren(this.container);
    const signInBtn = document.createElement('button');
    signInBtn.type = 'button';
    signInBtn.className = 'auth-signin-btn';
    if (this.signingIn) {
      signInBtn.classList.add('auth-signin-btn--loading');
      signInBtn.disabled = true;
      signInBtn.setAttribute('aria-busy', 'true');
      const spinner = document.createElement('span');
      spinner.className = 'auth-signin-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      signInBtn.appendChild(spinner);
    }
    signInBtn.appendChild(document.createTextNode(t('auth.signIn')));
    signInBtn.addEventListener('click', () => {
      if (this.onSignInClick) {
        this.onSignInClick();
        return;
      }
      if (this.signingIn) return;
      this.signingIn = true;
      this.renderSignedOut();
      void signInWithGithub().finally(() => {
        // No-op on success in the VS Code embed path: signInWithGithub()
        // ends in a real page navigation there, so this component is
        // already gone by the time the promise would settle. This only
        // fires on a genuine failure (or the plain-web redirect path,
        // which also navigates away) — reset so the button isn't stuck
        // disabled forever.
        this.signingIn = false;
        if (this.container.contains(signInBtn)) this.renderSignedOut();
      });
    });
    this.container.appendChild(signInBtn);
  }

  private detachMenuListeners(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
  }

  /**
   * No Supabase equivalent to Clerk's `mountUserButton` — this builds a
   * minimal avatar-triggered dropdown from `getCurrentAuthUser()` instead.
   * Reuses the `.auth-avatar-btn` / `.auth-dropdown` class family already
   * defined in main.css (pre-dating Clerk, orphaned since the custom OTP
   * modal was replaced) rather than inventing a new style system.
   */
  private renderSignedIn(): void {
    const user = getCurrentAuthUser();
    const initial = (user?.name?.trim()?.[0] ?? '?').toUpperCase();

    const avatarBtn = document.createElement('button');
    avatarBtn.type = 'button';
    avatarBtn.className = 'auth-avatar-btn';
    avatarBtn.setAttribute('aria-haspopup', 'true');
    avatarBtn.setAttribute('aria-expanded', 'false');
    avatarBtn.setAttribute('aria-label', user?.name ? `${user.name} — ${t('auth.settings')}` : t('auth.settings'));

    if (user?.image) {
      const avatarImg = document.createElement('img');
      avatarImg.className = 'auth-avatar-img';
      avatarImg.src = user.image;
      avatarImg.alt = '';
      avatarBtn.appendChild(avatarImg);
    } else {
      const initials = document.createElement('span');
      initials.className = 'auth-avatar-initials';
      initials.textContent = initial;
      avatarBtn.appendChild(initials);
    }
    this.container.appendChild(avatarBtn);

    const dropdown = document.createElement('div');
    dropdown.className = 'auth-dropdown';

    const header = document.createElement('div');
    header.className = 'auth-dropdown-header';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'auth-dropdown-avatar-wrap';
    if (user?.image) {
      const avatarImg = document.createElement('img');
      avatarImg.className = 'auth-avatar-img';
      avatarImg.src = user.image;
      avatarImg.alt = '';
      avatarWrap.appendChild(avatarImg);
    } else {
      const initials = document.createElement('span');
      initials.className = 'auth-avatar-initials';
      initials.textContent = initial;
      avatarWrap.appendChild(initials);
    }
    header.appendChild(avatarWrap);

    const info = document.createElement('div');
    info.className = 'auth-dropdown-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'auth-dropdown-name';
    nameEl.textContent = user?.name ?? '';
    const emailEl = document.createElement('div');
    emailEl.className = 'auth-dropdown-email';
    emailEl.textContent = user?.email ?? '';
    info.appendChild(nameEl);
    info.appendChild(emailEl);
    header.appendChild(info);
    dropdown.appendChild(header);

    const divider = document.createElement('div');
    divider.className = 'auth-dropdown-divider';
    dropdown.appendChild(divider);

    const signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.className = 'auth-dropdown-item auth-signout-item';
    signOutBtn.textContent = t('auth.signOut');
    signOutBtn.addEventListener('click', () => {
      closeMenu();
      void signOut();
    });
    dropdown.appendChild(signOutBtn);

    this.container.appendChild(dropdown);

    const closeMenu = (): void => {
      dropdown.classList.remove('open');
      avatarBtn.setAttribute('aria-expanded', 'false');
      this.detachMenuListeners();
    };
    const openMenu = (): void => {
      dropdown.classList.add('open');
      avatarBtn.setAttribute('aria-expanded', 'true');
      this.outsideClickHandler = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) closeMenu();
      };
      this.keydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeMenu();
      };
      document.addEventListener('click', this.outsideClickHandler, true);
      document.addEventListener('keydown', this.keydownHandler);
    };

    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dropdown.classList.contains('open')) closeMenu();
      else openMenu();
    });

    if (this.onSettingsClick) {
      const settingsBtn = document.createElement('button');
      settingsBtn.className = 'auth-settings-btn';
      settingsBtn.type = 'button';
      settingsBtn.setAttribute('aria-label', t('auth.settings'));
      settingsBtn.title = t('auth.settings');
      setTrustedHtml(settingsBtn, trustedHtml(SETTINGS_ICON, "legacy direct innerHTML migration"));
      settingsBtn.addEventListener('click', () => this.onSettingsClick?.());
      this.container.appendChild(settingsBtn);
    }
  }
}

const SETTINGS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
