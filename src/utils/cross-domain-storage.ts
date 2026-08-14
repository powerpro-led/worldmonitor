import { COOKIE_DOMAIN, APP_DOMAIN } from '@/config/domain';

const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function usesCookies(): boolean {
  return COOKIE_DOMAIN !== null && location.hostname.endsWith(APP_DOMAIN);
}

export function getDismissed(key: string): boolean {
  if (usesCookies()) {
    return document.cookie.split('; ').some((c) => c === `${key}=1`);
  }
  return localStorage.getItem(key) === '1' || localStorage.getItem(key) === 'true';
}

export function setDismissed(key: string): void {
  if (usesCookies()) {
    document.cookie = `${key}=1; domain=${COOKIE_DOMAIN}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
  }
  localStorage.setItem(key, '1');
}
