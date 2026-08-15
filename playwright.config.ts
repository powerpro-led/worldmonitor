import { defineConfig, devices } from '@playwright/test';
import { TEST_APP_DOMAIN } from './tests/helpers/domain-config.mjs';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90000,
  expect: {
    timeout: 30000,
  },
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 720 },
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-angle=swiftshader', '--use-gl=swiftshader'],
        },
      },
    },
  ],
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    // APP_DOMAIN pinned to the same test fixture domain as tests/*.test.mjs
    // (tests/helpers/domain-config.mjs) rather than inheriting whatever the
    // local .env happens to have configured — e2e specs assert on this exact
    // value (e.g. api.example.test), so the dev server must resolve it the
    // same way regardless of the machine's real APP_DOMAIN.
    env: { VITE_E2E: '1', APP_DOMAIN: TEST_APP_DOMAIN },
    url: 'http://127.0.0.1:4173/tests/map-harness.html',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
