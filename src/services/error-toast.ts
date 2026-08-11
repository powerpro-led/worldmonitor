/**
 * Transient red toast for a dashboard-wide error banner.
 *
 * Only takes a pre-formatted `userMessage` — NEVER renders raw
 * server-generated strings. Raw detail goes to Sentry via the caller's
 * `captureException`/`captureMessage`.
 */

const TOAST_ID = 'error-toast';
const AUTO_DISMISS_MS = 6_000;

export function showErrorToast(userMessage: string): void {
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.setAttribute('role', 'alert');
  Object.assign(toast.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '99999',
    padding: '14px 20px',
    background: 'linear-gradient(135deg, #b91c1c, #dc2626)',
    color: '#fff',
    fontWeight: '600',
    fontSize: '14px',
    textAlign: 'center',
    boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
    transition: 'opacity 0.4s ease, transform 0.4s ease',
    transform: 'translateY(-100%)',
    opacity: '0',
  });
  toast.textContent = userMessage;

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });

  setTimeout(() => {
    toast.style.transform = 'translateY(-100%)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  }, AUTO_DISMISS_MS);
}
