import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');

describe('forecast integrity and provenance surfaces', () => {
  it('labels simulation path confidence separately from event probability', () => {
    const src = read('src/components/ForecastPanel.ts');
    assert.match(src, /% confidence` : '—'/);
    assert.doesNotMatch(src, /p\.confidence \* 100\)}% probability/);
  });

  it('exposes degraded forecast backend state instead of empty success only', () => {
    const handler = read('server/worldmonitor/forecast/v1/get-forecasts.ts');
    const proto = read('proto/worldmonitor/forecast/v1/get_forecasts.proto');

    assert.match(proto, /bool degraded = 3;/);
    assert.match(proto, /bool stale = 4;/);
    assert.match(proto, /string error = 5;/);
    assert.match(handler, /getRawJson\(REDIS_KEY\)/);
    assert.match(handler, /degraded:\s*true/);
    assert.match(handler, /error:\s*'forecast_backend_unavailable'/);
  });

  it('does not repeat backend-unavailable detail in degraded forecast notices', () => {
    const src = read('src/components/ForecastPanel.ts');

    assert.match(src, /const errorDetail = this\.sourceState\.degraded \? '' : this\.sourceState\.error\.replace/);
    assert.doesNotMatch(src, /this\.sourceState\.error \? this\.sourceState\.error\.replace/);
  });

  it('keeps client request failures distinct from backend degradation', () => {
    const dataLoader = read('src/app/data-loader.ts');
    const forecastService = read('src/services/forecast.ts');

    assert.match(dataLoader, /degraded:\s*false,\n\s*stale:\s*false,\n\s*error:\s*'forecast_request_failed'/);
    assert.match(forecastService, /export async function fetchForecastFeed/);
    assert.doesNotMatch(forecastService, /export async function fetchForecasts/);
  });

  it('keeps forecast extra keys from clobbering last-good snapshots on empty transformed payloads', async () => {
    const { FORECAST_EXTRA_KEYS, PRIOR_KEY, declareRecords } = await import('../scripts/seed-forecasts.mjs');
    const { shouldSkipEmptyExtraKey } = await import('../scripts/_seed-utils.mjs');

    assert.ok(FORECAST_EXTRA_KEYS.length > 0, 'forecast seeder must expose extraKeys through FORECAST_EXTRA_KEYS');
    for (const ek of FORECAST_EXTRA_KEYS) {
      assert.equal(
        ek.skipWhenEmpty,
        true,
        `${ek.key} must opt into skipWhenEmpty so future forecast extraKeys do not overwrite last-good data with empty transforms`,
      );
    }

    const priorExtraKey = FORECAST_EXTRA_KEYS.find((ek) => ek.key === PRIOR_KEY);
    assert.ok(priorExtraKey, `FORECAST_EXTRA_KEYS must include ${PRIOR_KEY}`);

    const emptyPriorPayload = priorExtraKey.transform({ predictions: [] });
    const recordCount = declareRecords(emptyPriorPayload);

    assert.equal(recordCount, 0, 'empty prior snapshot transforms must resolve to recordCount=0');
    assert.equal(
      shouldSkipEmptyExtraKey(priorExtraKey, recordCount),
      true,
      `${PRIOR_KEY} must skip empty writes instead of clobbering the last-good prior snapshot`,
    );
  });
});
