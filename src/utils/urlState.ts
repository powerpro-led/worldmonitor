import type { MapLayers } from '@/types';
import type { MapView, TimeRange } from '@/components/Map';

const LAYER_KEYS: (keyof MapLayers)[] = [
  'conflicts',
  'bases',
  'cables',
  'pipelines',
  'hotspots',
  'ais',
  'nuclear',
  'irradiators',
  'sanctions',
  'weather',
  'economic',
  'waterways',
  'outages',
  'cyberThreats',
  'datacenters',
  'protests',
  'flights',
  'military',
  'natural',
  'spaceports',
  'minerals',
  'fires',
  'ucdpEvents',
  'displacement',
  'climate',
  'startupHubs',
  'cloudRegions',
  'accelerators',
  'techHQs',
  'techEvents',
  'tradeRoutes',
  'iranAttacks',
  'gpsJamming',
  'satellites',
  'ciiChoropleth',
  'resilienceScore',
];

const TIME_RANGES: TimeRange[] = ['1h', '6h', '24h', '48h', '7d', 'all'];
const VIEW_VALUES: MapView[] = ['global', 'america', 'mena', 'eu', 'asia', 'latam', 'africa', 'oceania'];

export interface ParsedMapUrlState {
  view?: MapView;
  zoom?: number;
  lat?: number;
  lon?: number;
  timeRange?: TimeRange;
  layers?: MapLayers;
  country?: string;
  expanded?: boolean;
  chokepoint?: string;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const parseEnumParam = <T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[]
): T | undefined => {
  const value = params.get(key);
  return value && allowed.includes(value as T) ? (value as T) : undefined;
};

const parseClampedFloatParam = (
  params: URLSearchParams,
  key: string,
  min: number,
  max: number
): number | undefined => {
  const rawValue = params.get(key);
  const value = rawValue ? Number.parseFloat(rawValue) : NaN;
  return Number.isFinite(value) ? clamp(value, min, max) : undefined;
};

export function parseMapUrlState(
  search: string,
  fallbackLayers: MapLayers
): ParsedMapUrlState {
  const params = new URLSearchParams(search);

  const view = parseEnumParam(params, 'view', VIEW_VALUES);
  const zoom = parseClampedFloatParam(params, 'zoom', 1, 10);
  const lat = parseClampedFloatParam(params, 'lat', -90, 90);
  const lon = parseClampedFloatParam(params, 'lon', -180, 180);
  const timeRange = parseEnumParam(params, 'timeRange', TIME_RANGES);

  const countryParam = params.get('country');
  const country = countryParam && /^[A-Z]{2}$/i.test(countryParam.trim()) ? countryParam.trim().toUpperCase() : undefined;

  const expandedParam = params.get('expanded');
  const expanded = expandedParam === '1' ? true : undefined;

  // Chokepoint deep-link (?chokepoint=bab_el_mandeb): opens the waterway popup on
  // the live map. Value is a canonical chokepoint/waterway id (lowercase, snake).
  // The map resolves it against STRATEGIC_WATERWAYS and no-ops on an unknown id,
  // so this only needs to reject obviously malformed input.
  const chokepointParam = params.get('chokepoint');
  const chokepoint = chokepointParam && /^[a-z][a-z0-9_]{1,40}$/i.test(chokepointParam.trim())
    ? chokepointParam.trim().toLowerCase()
    : undefined;

  const layersParam = params.get('layers');
  let layers: MapLayers | undefined;
  if (layersParam !== null) {
    layers = { ...fallbackLayers };
    const normalizedLayers = layersParam.trim();
    if (normalizedLayers !== '' && normalizedLayers !== 'none') {
      const requested = new Set(
        normalizedLayers
          .split(',')
          .map((layer) => layer.trim())
          .filter(Boolean)
      );
      if (requested.has('satelliteImagery')) {
        requested.delete('satelliteImagery');
        requested.add('satellites');
      }
      LAYER_KEYS.forEach((key) => {
        layers![key] = requested.has(key);
      });
    } else {
      LAYER_KEYS.forEach((key) => {
        layers![key] = false;
      });
    }
  }

  return {
    view,
    zoom,
    lat,
    lon,
    timeRange,
    layers,
    country,
    expanded,
    chokepoint,
  };
}

/**
 * Re-attach a URL fragment that buildMapUrl() never carries.
 *
 * Supabase Auth runs in IMPLICIT flow here (supabase-client.ts leaves
 * `flowType` at @supabase/auth-js's default), so a completed GitHub sign-in
 * comes back as `#access_token=...&refresh_token=...` in the FRAGMENT — not
 * as the `?code=` query param the sibling comment in buildMapUrl describes.
 * auth-js reads that fragment in `_getSessionFromURL()` and clears it itself
 * once consumed, but that only runs when the Supabase client is constructed,
 * which auth-provider.ts defers behind `requestIdleCallback(..., 4000ms)`.
 * The debounced URL auto-sync fires at 250ms — so any history.replaceState()
 * on the way that drops the fragment destroys the session before auth-js
 * ever looks for it (confirmed 2026-08-19 against Supabase's own edge logs:
 * `/auth/v1/callback` 302'd every time, but the `/auth/v1/user` call auth-js
 * makes while consuming the fragment only ever appeared for the one sign-in
 * that happened to win the race).
 *
 * Deliberately NOT folded into buildMapUrl(): its result is also copied to
 * the clipboard by the share button, which must never carry an access token.
 */
export function withPreservedFragment(url: string, fragment: string): string {
  if (!fragment || fragment === '#') return url;
  try {
    const parsed = new URL(url);
    // Assigning .hash (rather than concatenating) both normalizes a missing
    // leading '#' and REPLACES any fragment already on `url` — buildMapUrl
    // passes one through untouched, so a naive concat would produce a
    // double-fragment the moment getShareUrl() stopped stripping it.
    parsed.hash = fragment;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function buildMapUrl(
  baseUrl: string,
  state: {
    view: MapView;
    zoom: number;
    center?: { lat: number; lon: number } | null;
    timeRange: TimeRange;
    layers: MapLayers;
    country?: string;
    expanded?: boolean;
    chokepoint?: string;
  }
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // window.location.origin can be "null" string in some in-app browsers / WebViews
    url = new URL(window.location.href);
  }
  // Seeded from whatever's already on the URL (not a fresh empty set) so
  // params this function doesn't own -- most importantly an in-flight OAuth
  // callback's `?code=`/`&state=` (Supabase's PKCE redirect) -- survive the
  // debounced auto-sync in event-handlers.ts instead of being silently wiped
  // by `url.search = params.toString()` below racing detectSessionInUrl's
  // async code exchange. Every key this function owns is still explicitly
  // .set() beneath, so current app state always wins for those.
  const params = new URLSearchParams(url.search);

  if (state.center) {
    params.set('lat', state.center.lat.toFixed(4));
    params.set('lon', state.center.lon.toFixed(4));
  }

  params.set('zoom', state.zoom.toFixed(2));
  params.set('view', state.view);
  params.set('timeRange', state.timeRange);

  const activeLayers = LAYER_KEYS.filter((layer) => state.layers[layer]);
  params.set('layers', activeLayers.length > 0 ? activeLayers.join(',') : 'none');

  if (state.country) {
    params.set('country', state.country);
  }

  if (state.expanded) {
    params.set('expanded', '1');
  }

  if (state.chokepoint) {
    params.set('chokepoint', state.chokepoint);
  }

  url.search = params.toString();
  return url.toString();
}
