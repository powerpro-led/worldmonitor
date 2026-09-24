import { createRelayHandler } from './_relay.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
  buildRelayPath: (_req, url) => {
    const endpoint = url.searchParams.get('endpoint');
    return endpoint === 'history' ? '/oref/history' : '/oref/alerts';
  },
  forwardSearch: false,
  timeout: 12000,
  onlyOk: true,
  cacheHeaders: () => ({
    'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=120, stale-if-error=900',
  }),
  // _relay.js calls this fallback for two different reasons it doesn't
  // distinguish for the caller: WS_RELAY_URL was never set at all (the
  // permanent, expected state for every local-mode install — relay-backed
  // routes have no local equivalent), or it WAS set and the relay call
  // itself failed (a genuine, temporary production issue). Only the first
  // case should report `configured: false`; conflating them under a single
  // 503 made local mode's permanent, by-design "no relay here" look like a
  // transient outage worth retrying — and worse, src/services/oref-alerts.ts's
  // fetchOrefAlerts() short-circuits on `!res.ok` before ever reading the
  // body, so the `configured: false` this endpoint already sent was invisible
  // to the frontend's own "not configured" UI branch, AND a non-2xx status
  // is exactly what a browser flags red in its own console/network panel
  // regardless of what the response body says (a real Windows field report:
  // console kept flashing red on every load, panel never got to show its
  // "not configured" state). 200 for the permanent case — this is normal,
  // expected, successfully-answered "there is no data here", not an error —
  // lets the frontend parse the body and hit its own already-correct
  // `configured` branch. 503 stays for an actually-configured relay having a
  // bad moment, where "temporarily unavailable, retry" is the true story.
  fallback: (_req, corsHeaders) => {
    const configured = Boolean(process.env.WS_RELAY_URL);
    return jsonResponse({
      configured,
      alerts: [],
      historyCount24h: 0,
      timestamp: new Date().toISOString(),
      error: configured ? 'Relay request failed' : 'No data source available',
    }, configured ? 503 : 200, corsHeaders);
  },
});
