import { resolveVariantOrigin, resolveWwwOrigin } from '../../shared/domain-config.js';

export interface VariantMeta {
  title: string;
  description: string;
  keywords: string;
  url: string;
  siteName: string;
  shortName: string;
  subject: string;
  classification: string;
  categories: string[];
  features: string[];
}

type VariantMetaStatic = Omit<VariantMeta, 'url'>;

/**
 * The `.url` field is domain-dependent, so it's deliberately NOT baked into
 * this static copy — build it via `buildVariantMeta(rawDomain)` instead.
 * This module is imported both Node-side (vite.config.ts,
 * variant-dashboard-html.ts) and browser-side (event-handlers.ts,
 * meta-tags.ts), each with its own env-var mechanism (process.env vs
 * import.meta.env) — same "every caller passes its own raw domain string"
 * discipline as shared/domain-config.js.
 */
const VARIANT_META_STATIC: { full: VariantMetaStatic; [k: string]: VariantMetaStatic } = {
  full: {
    title: 'World Monitor - Real-Time Global Intelligence Dashboard',
    description: 'Real-time global intelligence platform. Featured in WIRED. Used by 2M+ people across 190 countries. Conflicts, markets, military, OSINT in one view.',
    keywords: 'AI intelligence, AI-powered dashboard, global intelligence, geopolitical dashboard, world news, market data, military bases, nuclear facilities, undersea cables, conflict zones, real-time monitoring, situation awareness, OSINT, flight tracking, AIS ships, earthquake monitor, protest tracker, power outages, oil prices, government spending, polymarket predictions',
    siteName: 'World Monitor',
    shortName: 'World Monitor',
    subject: 'AI-Powered Global Intelligence and Situation Awareness',
    classification: 'AI Intelligence Dashboard, OSINT Tool, News Aggregator',
    categories: ['news', 'productivity'],
    features: [
      'Real-time news aggregation',
      'Stock market tracking',
      'Military flight monitoring',
      'Ship AIS tracking',
      'Earthquake alerts',
      'Protest tracking',
      'Power outage monitoring',
      'Oil price analytics',
      'Government spending data',
      'Prediction markets',
      'Infrastructure monitoring',
      'Geopolitical intelligence',
    ],
  },
  tech: {
    title: 'Tech Monitor - Real-Time AI & Tech Industry Dashboard',
    description: 'Real-time AI and tech industry dashboard tracking tech giants, AI labs, startup ecosystems, funding rounds, and tech events worldwide.',
    keywords: 'tech dashboard, AI industry, startup ecosystem, tech companies, AI labs, venture capital, tech events, tech conferences, cloud infrastructure, datacenters, tech layoffs, funding rounds, unicorns, FAANG, tech HQ, accelerators, Y Combinator, tech news',
    siteName: 'Tech Monitor',
    shortName: 'TechMonitor',
    subject: 'AI, Tech Industry, and Startup Ecosystem Intelligence',
    classification: 'Tech Dashboard, AI Tracker, Startup Intelligence',
    categories: ['news', 'business'],
    features: [
      'Tech news aggregation',
      'AI lab tracking',
      'Startup ecosystem mapping',
      'Tech HQ locations',
      'Conference & event calendar',
      'Cloud infrastructure monitoring',
      'Datacenter mapping',
      'Tech layoff tracking',
      'Funding round analytics',
      'Tech stock tracking',
      'Service status monitoring',
    ],
  },
  happy: {
    title: 'Happy Monitor - Good News & Global Progress',
    description: 'Curated positive news, progress data, and uplifting stories from around the world.',
    keywords: 'good news, positive news, global progress, happy news, uplifting stories, human achievement, science breakthroughs, conservation wins',
    siteName: 'Happy Monitor',
    shortName: 'HappyMonitor',
    subject: 'Good News, Global Progress, and Human Achievement',
    classification: 'Positive News Dashboard, Progress Tracker',
    categories: ['news', 'lifestyle'],
    features: [
      'Curated positive news',
      'Global progress tracking',
      'Live humanity counters',
      'Science breakthrough feed',
      'Conservation tracker',
      'Renewable energy dashboard',
    ],
  },
  finance: {
    title: 'Finance Monitor - Real-Time Markets & Trading Dashboard',
    description: 'Real-time finance and trading dashboard tracking global markets, stock exchanges, central banks, commodities, forex, crypto, and economic indicators worldwide.',
    keywords: 'finance dashboard, trading dashboard, stock market, forex, commodities, central banks, crypto, economic indicators, market news, financial centers, stock exchanges, bonds, derivatives, fintech, hedge funds, IPO tracker, market analysis',
    siteName: 'Finance Monitor',
    shortName: 'FinanceMonitor',
    subject: 'Global Markets, Trading, and Financial Intelligence',
    classification: 'Finance Dashboard, Market Tracker, Trading Intelligence',
    categories: ['finance', 'news'],
    features: [
      'Real-time market data',
      'Stock exchange mapping',
      'Central bank monitoring',
      'Commodity price tracking',
      'Forex & currency news',
      'Crypto & digital assets',
      'Economic indicator alerts',
      'IPO & earnings tracking',
      'Financial center mapping',
      'Sector heatmap',
      'Market radar signals',
    ],
  },
  commodity: {
    title: 'Commodity Monitor - Real-Time Commodity Markets & Supply Chain Dashboard',
    description: 'Real-time commodity markets dashboard tracking mining sites, processing plants, commodity ports, supply chains, and global commodity trade flows.',
    keywords: 'commodity dashboard, mining sites, processing plants, commodity ports, supply chain, commodity markets, oil, gas, metals, agriculture, mining operations, commodity trade, logistics, infrastructure, resource tracking, commodity prices, futures markets',
    siteName: 'Commodity Monitor',
    shortName: 'CommodityMonitor',
    subject: 'Commodity Markets, Mining, and Supply Chain Intelligence',
    classification: 'Commodity Dashboard, Supply Chain Tracker, Resource Intelligence',
    categories: ['finance', 'business'],
    features: [
      'Mining site tracking',
      'Processing plant monitoring',
      'Commodity port mapping',
      'Supply chain visualization',
      'Commodity price tracking',
      'Trade flow analysis',
      'Resource extraction monitoring',
      'Logistics infrastructure',
      'Commodity market news',
      'Futures market data',
    ],
  },
  energy: {
    title: 'Energy Atlas - Real-Time Global Energy Intelligence Dashboard',
    description: 'Real-time global energy atlas tracking oil and gas pipelines, storage facilities, chokepoints, fuel shortages, tanker flows, and disruption events worldwide.',
    keywords: 'energy dashboard, oil pipeline tracker, gas pipeline map, LNG terminals, gas storage map, oil storage, SPR tracker, Strait of Hormuz, chokepoint monitor, fuel shortage tracker, pipeline disruption, energy crisis, OPEC, tanker tracking, energy infrastructure, natural gas storage, crude oil inventories, IEA oil stocks, days of cover, energy sanctions, petroleum, diesel, jet fuel, heating oil',
    siteName: 'Energy Atlas',
    shortName: 'EnergyAtlas',
    subject: 'Global Energy Infrastructure, Supply, and Disruption Intelligence',
    classification: 'Energy Dashboard, Pipeline Tracker, Supply Disruption Monitor',
    categories: ['news', 'business'],
    features: [
      'Oil & gas pipeline registry with live status',
      'Storage facility map (UGS, LNG, SPR, tank farms)',
      'Chokepoint flow monitoring (Hormuz, Suez, Malacca, Bab el-Mandeb)',
      'Fuel shortage alerts (jet, petrol, diesel, heating oil)',
      'Pipeline & storage disruption timeline',
      'Oil & gas inventories (EU gas, US SPR, IEA stocks)',
      'Retail fuel prices by country',
      'Energy crisis policy tracker',
      'Evidence-based status badges with public revision log',
      'Country energy exposure drill-down',
    ],
  },
};

/** The dashboard URL for one variant slug — 'full' serves from the www origin, others from their own subdomain. */
export function resolveVariantMetaUrl(rawDomain: string | undefined | null, variant: string): string {
  const origin = variant === 'full' ? resolveWwwOrigin(rawDomain) : resolveVariantOrigin(rawDomain, variant);
  return `${origin}/dashboard`;
}

/**
 * Builds a full `{ full: VariantMeta; [slug]: VariantMeta }` map for the
 * given domain — the drop-in replacement for what used to be the static
 * `VARIANT_META` export. Call once per domain source (Node's
 * `process.env.APP_DOMAIN` or the browser's `import.meta.env.VITE_APP_DOMAIN`
 * via src/config/domain.ts) and read fields off the result exactly as before.
 */
export function buildVariantMeta(rawDomain: string | undefined | null): { full: VariantMeta; [k: string]: VariantMeta } {
  const entries = Object.entries(VARIANT_META_STATIC).map(([slug, meta]) => [
    slug,
    { ...meta, url: resolveVariantMetaUrl(rawDomain, slug) },
  ]);
  return Object.fromEntries(entries) as { full: VariantMeta; [k: string]: VariantMeta };
}
