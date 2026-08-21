import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dashboardFontFamilies } from '../src/bootstrap/secondary-startup.ts';
import { scheduleAfterFirstPaint } from '../src/utils/after-paint.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const dashboardCsp = vercelConfig.headers
  .find((entry: { source: string }) => entry.source === '/((?!docs).*)')
  ?.headers
  ?.find((header: { key: string }) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
const activeMarkup = indexHtml.replace(/<!--[\s\S]*?-->/g, '');

describe('secondary dashboard startup', () => {
  it('keeps analytics, auth, Sentry, and font fetches out of index.html startup tags', () => {
    assert.equal(
      /<script\b[^>]+src=["']https:\/\/cdn\.debugbear\.com\/lpMwA9KpC6pf\.js["']/i.test(activeMarkup),
      false,
      'DebugBear RUM must be injected by the dashboard loader, not index.html',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/o4509927897890816\.ingest\.us\.sentry\.io["']/i.test(activeMarkup),
      false,
      'Sentry ingest preconnect must not compete with initial dashboard paint',
    );
    assert.equal(
      /<link\b[^>]+rel=["']dns-prefetch["'][^>]+href=["']https:\/\/clerk\.worldmonitor\.app["']/i.test(activeMarkup),
      false,
      'Clerk dns-prefetch must not run before the deferred Clerk loader',
    );
    assert.equal(
      /<link\b[^>]+href=["']https:\/\/fonts\.googleapis\.com\/css2\?/i.test(activeMarkup),
      false,
      'Google Fonts stylesheet must not be an eager head request',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com["']/i.test(activeMarkup),
      false,
      'Google Fonts preconnects must be deferred with the narrowed font request',
    );
  });

  it('keeps secondary startup script hosts out of the dashboard script-src allowlist', () => {
    const scriptSrc = dashboardCsp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.match(scriptSrc, /'strict-dynamic'/);
    assert.doesNotMatch(scriptSrc, /https:\/\/cdn\.debugbear\.com/);
    assert.doesNotMatch(scriptSrc, /https:\/\/static\.cloudflareinsights\.com/);
    assert.doesNotMatch(dashboardCsp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(dashboardCsp, /font-src[^;]*'self'/);
    assert.doesNotMatch(dashboardCsp, /font-src[^;]*https:/);
  });

  it('does not load any web font for the default English dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'en', dir: '' }), []);
  });

  it('loads only Nunito for the happy dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'happy', lang: 'en', dir: '' }), ['nunito']);
  });

  it('loads only Tajawal for the Arabic dashboard, not happy fonts', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'ar', dir: 'rtl' }), ['tajawal']);
  });

  it('combines Nunito + Tajawal for the Arabic happy dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'happy', lang: 'ar', dir: 'rtl' }), ['nunito', 'tajawal']);
  });
});

describe('scheduleAfterFirstPaint', () => {
  it('runs the task via the load-event listener when readyState is not complete', () => {
    const loadHandlers: Array<() => void> = [];
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      requestIdleCallback: (cb: () => void) => {
        cb();
        return 1;
      },
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'load') loadHandlers.push(cb);
      },
    };
    const fakeDocument = { readyState: 'loading' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 0, 'task must not run before the load event fires');
      assert.equal(loadHandlers.length, 1, 'a load listener must be registered');
      loadHandlers[0]!();
      assert.equal(ran, 1, 'task runs exactly once after load -> rAF -> idle');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it('falls back to setTimeout when requestIdleCallback is absent', () => {
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      addEventListener: () => {},
    };
    const fakeDocument = { readyState: 'complete' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const savedSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void) => {
        cb();
        return 1;
      },
    });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 1, 'task runs via the setTimeout fallback when rIC is missing');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (savedSetTimeout) Object.defineProperty(globalThis, 'setTimeout', savedSetTimeout);
    }
  });
});
