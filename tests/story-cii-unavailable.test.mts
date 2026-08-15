import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

async function importSource(source: string): Promise<Record<string, unknown>> {
  const output = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function emptyStory() {
  return {
    countryCode: 'LB',
    countryName: 'Lebanon',
    cii: null,
    news: [],
    theater: null,
    markets: [],
    threats: { critical: 0, high: 0, medium: 0, categories: [] },
    signals: { protests: 0, militaryFlights: 0, militaryVessels: 0, outages: 0, gpsJammingHexes: 0 },
    convergence: null,
  };
}

describe('story CII unavailable state', () => {
  it('renders a neutral unavailable label without a fabricated score, level, or trend', async () => {
    const source = readFileSync(resolve(root, 'src/services/story-renderer.ts'), 'utf8')
      .replace("import type { StoryData } from './story-data';", '')
      .replace(
        "import { getLocale, t } from './i18n';",
        "const getLocale = () => 'en-US'; const t = (key: string) => key === 'common.unavailable' ? 'UNAVAILABLE' : key;",
      )
      .replace("import { APP_DOMAIN } from '@/config/domain';", "const APP_DOMAIN = 'example.test';");
    const { renderStoryToCanvas } = await importSource(source) as {
      renderStoryToCanvas: (data: ReturnType<typeof emptyStory>) => Promise<unknown>;
    };
    const drawnText: string[] = [];
    const context = new Proxy({
      fillText: (value: unknown) => drawnText.push(String(value)),
      measureText: (value: unknown) => ({ width: String(value).length * 10 }),
    }, {
      get: (target, prop) => prop in target ? target[prop as keyof typeof target] : () => undefined,
      set: (target, prop, value) => { (target as Record<PropertyKey, unknown>)[prop] = value; return true; },
    });
    const previousDocument = globalThis.document;
    const previousImage = globalThis.Image;
    class UnavailableImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { this.onerror?.(); }
    }
    Object.assign(globalThis, {
      document: { createElement: () => ({ getContext: () => context }) },
      Image: UnavailableImage,
    });

    try {
      await renderStoryToCanvas(emptyStory());
    } finally {
      Object.assign(globalThis, { document: previousDocument, Image: previousImage });
    }

    assert.ok(drawnText.includes('UNAVAILABLE'));
    assert.ok(!drawnText.includes('0'), 'must not render a fabricated zero CII score');
    assert.ok(!drawnText.includes('/100'));
    assert.ok(!drawnText.includes('NORMAL'));
    assert.ok(!drawnText.some(text => text.includes('STABLE')));
  });
});
