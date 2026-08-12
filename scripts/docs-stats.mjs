#!/usr/bin/env node
/**
 * docs-stats — single source of truth for the capability counts quoted in the
 * repo's remaining (non-Mintlify) docs: README.md, ARCHITECTURE.md, AGENTS.md,
 * CONTRIBUTING.md, SECURITY.md, index.html.
 *
 * Default mode  : recompute every stat from code and write
 *                 scripts/generated/stats.json.
 * --check mode  : recompute, then assert that every registered doc claim still
 *                 matches the live number. Exits non-zero on drift (CI gate).
 *
 * Why this exists: capability counts (map layers, services, protos, locales,
 * workflows, freshness sources, feeds) were hand-maintained across these docs
 * and drifted independently. Every number a doc quotes must be derivable here
 * and registered in CLAIMS below.
 *
 * Note: this previously also validated docs/*.mdx (the public Mintlify docs
 * site) and blog-site/*.md (the public blog); both were retired along with
 * the rest of the public-product surface (private fork, no public docs/blog),
 * so those claims were removed rather than left to fail on missing files.
 *
 * Stats are parsed from source text (no TS execution / import-graph / env deps)
 * so this runs anywhere Node runs, including bare CI.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const dirsIn = (p) =>
  readdirSync(join(ROOT, p), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const filesIn = (p) =>
  readdirSync(join(ROOT, p), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const entriesIn = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).map((e) => e.name);

function sorted(items) {
  return [...items].sort();
}

function sameStringSet(a, b) {
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function describeSetDelta(found, expected) {
  const foundSet = new Set(found);
  const expectedSet = new Set(expected);
  const missing = sorted(expected.filter((v) => !foundSet.has(v)));
  const extra = sorted(found.filter((v) => !expectedSet.has(v)));
  return [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    extra.length ? `extra: ${extra.join(', ')}` : '',
  ].filter(Boolean).join('; ');
}

function extractSingleQuotedValue(text, name) {
  const match = text.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*'([^']+)'`));
  if (!match) throw new Error(`docs-stats: could not find ${name}`);
  return match[1];
}

function findTopLevelObjectBlocks(source) {
  const starts = [...source.matchAll(/^ {2}\{$/gm)].map((m) => m.index);
  return starts.map((start) => {
    const close = source.slice(start).search(/^ {2}\},?$/m);
    if (close === -1) return source.slice(start);
    return source.slice(start, start + close);
  });
}

function parseMcpAppsInventory({
  uiRegistrySource = read('api/mcp/ui/registry.ts'),
  shellSource = read('api/mcp/ui/shell.ts'),
  rpcToolsSource = read('api/mcp/registry/rpc-tools.ts'),
  cacheToolsSource = read('api/mcp/registry/cache-tools.ts'),
} = {}) {
  const uiConstToUri = new Map(
    [...uiRegistrySource.matchAll(/^export\s+const\s+(\w+_UI_URI)\s*=\s*'([^']+)';/gm)]
      .map((m) => [m[1], m[2]]),
  );
  if (uiConstToUri.size === 0) {
    throw new Error('docs-stats: could not parse MCP Apps ui:// URI constants');
  }

  const registryBlockMatch = uiRegistrySource.match(/export const UI_RESOURCE_REGISTRY:[\s\S]*?=\s*\[([\s\S]*?)\n\];/);
  if (!registryBlockMatch) {
    throw new Error('docs-stats: could not parse UI_RESOURCE_REGISTRY');
  }
  const registryEntries = [...registryBlockMatch[1].matchAll(
    /uri:\s*(\w+_UI_URI),\s*\n\s*name:\s*'((?:\\'|[^'])*)',\s*\n\s*description:\s*\n\s*'((?:\\'|[^'])*)',/g,
  )].map((m) => ({
    uriConst: m[1],
    uri: uiConstToUri.get(m[1]) ?? m[1],
    name: m[2].replace(/\\'/g, "'"),
    description: m[3].replace(/\\'/g, "'"),
  }));
  const registryConsts = registryEntries.map((entry) => entry.uriConst);
  const uiConsts = [...uiConstToUri.keys()];
  if (!sameStringSet(registryConsts, uiConsts)) {
    throw new Error(
      `docs-stats: UI_RESOURCE_REGISTRY entries do not match ui:// constants (${describeSetDelta(registryConsts, uiConsts)})`,
    );
  }

  const toolLinks = [];
  for (const source of [rpcToolsSource, cacheToolsSource]) {
    for (const block of findTopLevelObjectBlocks(source)) {
      const name = block.match(/^\s+name:\s*'([^']+)'/m)?.[1];
      const uriConst = block.match(/^\s+_uiResourceUri:\s*(\w+_UI_URI),/m)?.[1];
      if (name && uriConst) {
        const uri = uiConstToUri.get(uriConst);
        if (!uri) throw new Error(`docs-stats: tool ${name} links unknown MCP App URI constant ${uriConst}`);
        toolLinks.push({ tool: name, uriConst, uri });
      }
    }
  }
  for (const [label, values] of [
    ['tool', toolLinks.map((entry) => entry.tool)],
    ['ui resource', toolLinks.map((entry) => entry.uri)],
  ]) {
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    if (duplicates.length) {
      throw new Error(`docs-stats: duplicate MCP Apps ${label} links: ${sorted([...new Set(duplicates)]).join(', ')}`);
    }
  }

  const toolByUri = new Map(toolLinks.map((entry) => [entry.uri, entry.tool]));
  const apps = registryEntries.map((entry) => ({
    ...entry,
    tool: toolByUri.get(entry.uri) ?? null,
  }));
  const unlinked = apps.filter((entry) => !entry.tool).map((entry) => entry.uri);
  if (unlinked.length) {
    throw new Error(`docs-stats: MCP Apps resources missing linked tools: ${unlinked.join(', ')}`);
  }

  return {
    specVersion: extractSingleQuotedValue(shellSource, 'UI_PROTOCOL_VERSION'),
    mimeType: extractSingleQuotedValue(shellSource, 'UI_RESOURCE_MIME_TYPE'),
    apps,
    uiResources: apps.map((entry) => entry.uri),
    linkedTools: apps.map((entry) => entry.tool),
    toolLinks: apps.map((entry) => ({ tool: entry.tool, uri: entry.uri })),
  };
}

function parseJsonLdBlocks(html) {
  return [...html.matchAll(/<script\s+type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
}

function validateIndexLanguageMetadata(stats, html = read('index.html')) {
  const failures = [];
  const expected = stats.localeCodes;

  const alternateLinks = [...html.matchAll(/<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/>/g)]
    .map((m) => ({ code: m[1], href: m[2] }));
  const defaultLink = alternateLinks.find((l) => l.code === 'x-default');
  if (!defaultLink) {
    failures.push('index.html: x-default hreflang link not found');
  } else {
    const params = hrefSearchParams(defaultLink.href);
    if (!params) {
      failures.push('index.html: x-default hreflang href is not a valid URL');
    } else if (params.has('lang')) {
      failures.push('index.html: x-default hreflang href must not set ?lang');
    }
  }

  const localeLinks = alternateLinks.filter((l) => l.code !== 'x-default');
  const hreflangCodes = localeLinks.map((l) => l.code);
  if (!sameStringSet(hreflangCodes, expected)) {
    failures.push(`index.html: hreflang locale set does not match src/locales (${describeSetDelta(hreflangCodes, expected)})`);
  }

  for (const code of expected.filter((c) => c !== 'en')) {
    const link = localeLinks.find((l) => l.code === code);
    if (!link) continue;
    const lang = hrefSearchParams(link.href)?.get('lang');
    if (lang !== code) {
      failures.push(`index.html: hreflang ${code} href must use ?lang=${code}`);
    }
  }

  let jsonLd;
  try {
    jsonLd = parseJsonLdBlocks(html);
  } catch (error) {
    failures.push(`index.html: JSON-LD could not be parsed (${error.message})`);
    return failures;
  }

  const webSite = jsonLd.find((o) => o?.['@type'] === 'WebSite');
  if (!webSite) {
    failures.push('index.html: WebSite JSON-LD block not found');
  } else {
    const inLanguage = Array.isArray(webSite.inLanguage) ? webSite.inLanguage : [webSite.inLanguage].filter(Boolean);
    if (!sameStringSet(inLanguage, expected)) {
      failures.push(`index.html: WebSite inLanguage does not match src/locales (${describeSetDelta(inLanguage, expected)})`);
    }
  }

  // The "<N> language support with RTL" featureList count is validated by the
  // index.html claims() entry (single source of truth), so it is not re-checked
  // here to avoid a duplicate assertion of the same string against the same value.

  return failures;
}

// Parse a URL's query params tolerantly. A base URL is supplied so a relative
// hreflang href (e.g. `/dashboard?lang=fa`) parses instead of throwing and
// crashing the whole gate. Returns null only when the value is not a URL at all.
function hrefSearchParams(href) {
  try {
    return new URL(href, 'https://www.worldmonitor.app').searchParams;
  } catch {
    return null;
  }
}

// Cross-check the runtime i18next allow-list (SUPPORTED_LANGUAGES in
// src/services/i18n.ts) against the filesystem locale set. index.html now
// advertises an hreflang `?lang=<code>` for every locale on disk; if a code is
// present on disk but missing from SUPPORTED_LANGUAGES, i18next silently falls
// back to English for that `?lang=`, making the advertised URL a dead end.
function parseSupportedLanguages(i18nSource) {
  const block = i18nSource.match(/const\s+SUPPORTED_LANGUAGES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) return null;
  return (block[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
}

function validateSupportedLanguagesRegistry(stats, i18nSource = read('src/services/i18n.ts')) {
  const supported = parseSupportedLanguages(i18nSource);
  if (!supported) {
    return ['src/services/i18n.ts: could not parse SUPPORTED_LANGUAGES array'];
  }
  if (!sameStringSet(supported, stats.localeCodes)) {
    return [`src/services/i18n.ts: SUPPORTED_LANGUAGES does not match src/locales (${describeSetDelta(supported, stats.localeCodes)})`];
  }
  return [];
}

function makefileVar(text, name) {
  const match = text.match(new RegExp(`^${name}\\s*:=\\s*(\\S+)`, 'm'));
  if (!match) throw new Error(`docs-stats: could not find ${name} in Makefile`);
  return match[1];
}

function walk(rel, out = []) {
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
}

function computeStats() {
  const makefile = read('Makefile');
  const mcpApps = parseMcpAppsInventory();

  // ---- Map layers (src/config/map-layer-definitions.ts) ----
  const mld = read('src/config/map-layer-definitions.ts');
  const registryBlock = mld.slice(mld.indexOf('LAYER_REGISTRY'), mld.indexOf('VARIANT_LAYER_ORDER'));
  const layerDefinitions = (registryBlock.match(/^\s+\w+:\s+def\(/gm) || []).length;

  const variantBlock = mld.slice(mld.indexOf('VARIANT_LAYER_ORDER'), mld.indexOf('export function getLayersForVariant'));
  const variantLayers = {};
  for (const m of variantBlock.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    variantLayers[m[1]] = (m[2].match(/'[^']+'/g) || []).length;
  }
  const variantCount = Object.keys(variantLayers).length;

  // ---- Root app directories used by AGENTS.md and CONTRIBUTING.md ----
  const componentTopLevelTsFiles = filesIn('src/components').filter((f) => f.endsWith('.ts')).length;
  const serviceTopLevelEntries = entriesIn('src/services').length;
  const apiEndpointEntries = entriesIn('api').filter(
    (f) => !f.startsWith('_') && !/\.test\./.test(f) && !/\.d\.ts$/.test(f) && !/\.json$/.test(f),
  ).length;

  // ---- Panel subclasses across src/components (ARCHITECTURE.md system diagram) ----
  const panelClasses = walk('src/components')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .reduce((n, f) => n + (read(f).match(/class\s+\w+\s+extends\s+Panel\b/g) || []).length, 0);

  // ---- Protos & services (proto/**) ----
  const protoFiles = walk('proto').filter((f) => f.endsWith('.proto'));
  const protoServices = protoFiles
    .map((f) => (read(f).match(/^service\s+\w+/gm) || []).length)
    .reduce((a, b) => a + b, 0);
  const protoDomainFolders = dirsIn('proto/worldmonitor').length;

  // ---- Server domain handlers (server/worldmonitor/*/) ----
  const serverDomains = dirsIn('server/worldmonitor').length;

  // ---- User-facing locales (src/locales/*.json, excluding shell fragments) ----
  const localeCodes = filesIn('src/locales')
    .filter((f) => f.endsWith('.json') && !f.endsWith('.shell.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  const locales = localeCodes.length;

  // ---- CI workflows (.github/workflows/*.yml) ----
  const workflows = filesIn('.github/workflows').filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();

  // ---- Freshness-tracked sources (src/services/data-freshness.ts) ----
  const dfs = read('src/services/data-freshness.ts');
  const dfsStart = dfs.indexOf('const SOURCE_METADATA');
  const dfsClass = dfs.indexOf('class ', dfsStart);
  const metaBlock = dfs.slice(dfsStart, dfsClass >= 0 ? dfsClass : dfs.length);
  const freshnessSources = (metaBlock.match(/^\s+\w+:\s*\{\s*name:/gm) || []).length;
  const freshnessRequiredForRisk = (metaBlock.match(/requiredForRisk:\s*true/g) || []).length;

  // ---- Feed definitions (src/config/feeds.ts) — floor metric ----
  const feedDefinitions = (read('src/config/feeds.ts').match(/name:\s*'/g) || []).length;

  // ---- Operational source counts used by data-source and methodology docs ----
  const airportCount = (read('src/config/airports.ts').match(/\biata:\s*'/g) || []).length;

  const financeGeo = read('src/config/finance-geo.ts');
  const stockExchangeStart = financeGeo.indexOf('export const STOCK_EXCHANGES');
  const stockExchangeEnd = financeGeo.indexOf('export const FINANCIAL_CENTERS');
  if (stockExchangeStart === -1 || stockExchangeEnd === -1 || stockExchangeEnd <= stockExchangeStart) {
    throw new Error('docs-stats: could not isolate STOCK_EXCHANGES block in src/config/finance-geo.ts');
  }
  const stockExchangeBlock = financeGeo.slice(stockExchangeStart, stockExchangeEnd);
  const stockExchangeCount = (stockExchangeBlock.match(/\bid:\s*'/g) || []).length;
  const centralBankStart = financeGeo.indexOf('export const CENTRAL_BANKS');
  const centralBankEnd = financeGeo.indexOf('export const COMMODITY_HUBS');
  if (centralBankStart === -1 || centralBankEnd === -1 || centralBankEnd <= centralBankStart) {
    throw new Error('docs-stats: could not isolate CENTRAL_BANKS block in src/config/finance-geo.ts');
  }
  const centralBankBlock = financeGeo.slice(centralBankStart, centralBankEnd);
  const centralBankInstitutionCount = (centralBankBlock.match(/\bid:\s*'/g) || []).length;

  const telegram = JSON.parse(read('data/telegram-channels.json'));
  const telegramFullEnabled = Array.isArray(telegram?.channels?.full)
    ? telegram.channels.full.filter((c) => c?.enabled !== false)
    : [];
  const telegramFullTierCounts = telegramFullEnabled.reduce((acc, c) => {
    const tier = String(c?.tier ?? 'unknown');
    acc[tier] = (acc[tier] || 0) + 1;
    return acc;
  }, {});

  const leaderBlock = read('src/services/trending-keywords.ts').match(
    /const\s+LEADER_NAMES\s*(?::[^=]*)?\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!leaderBlock) {
    throw new Error('docs-stats: could not find LEADER_NAMES array in src/services/trending-keywords.ts');
  }
  const leaderNames = (leaderBlock[1].match(/'[^']+'/g) || []).length;

  const populationBlock = read('src/services/population-exposure.ts').match(
    /const PRIORITY_COUNTRIES:[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
  );
  const populationPriorityCountries = populationBlock
    ? (populationBlock[1].match(/^\s+[A-Z]{3}:\s*\{/gm) || []).length
    : 0;

  return {
    _generated: 'scripts/docs-stats.mjs — do not edit by hand; run `npm run docs:stats`',
    layerDefinitions,
    variantLayers,
    variantCount,
    componentTopLevelTsFiles,
    serviceTopLevelEntries,
    apiEndpointEntries,
    panelClasses,
    protoFiles: protoFiles.length,
    protoServices,
    protoDomainFolders,
    serverDomains,
    localeCodes,
    locales,
    workflows,
    workflowCount: workflows.length,
    freshnessSources,
    freshnessRequiredForRisk,
    feedDefinitions,
    airportCount,
    stockExchangeCount,
    centralBankInstitutionCount,
    telegramFullEnabledChannels: telegramFullEnabled.length,
    telegramFullTierCounts,
    leaderNames,
    populationPriorityCountries,
    sebufVersion: makefileVar(makefile, 'SEBUF_VERSION'),
    mcpApps,
    mcpAppCount: mcpApps.apps.length,
    mcpAppUiResources: mcpApps.uiResources,
    mcpAppLinkedTools: mcpApps.linkedTools,
  };
}

/**
 * Registered doc claims. Each entry pins one number in one doc to a live stat.
 * `value` returns the expected number; `min:true` treats the doc number as a
 * floor (doc says "500+" → live must be >= 500). The regex must capture the
 * number in group 1 and be unique enough to match the intended sentence.
 */
function claims(s) {
  return [
    { file: 'README.md', re: /(\d+)\s+map layer types/, value: s.layerDefinitions },
    { file: 'README.md', re: /Protocol Buffers \((\d+)\s+protos/, value: s.protoFiles },
    { file: 'README.md', re: /(\d+)\s+services\)/, value: s.protoServices },
    { file: 'README.md', re: /(\d+)\s+languages/, value: s.locales },
    { file: 'README.md', re: /(\d+)\+\s+curated news feeds/, value: s.feedDefinitions, min: true },
    { file: 'README.md', re: /(\d+)\s+stock exchanges/, value: s.stockExchangeCount },

    // ---- Root contributor/agent/security docs ----
    { file: 'AGENTS.md', re: /with (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'AGENTS.md', re: /(\d+)\+\s+Vercel Edge API endpoint entries/, value: s.apiEndpointEntries, min: true },
    { file: 'AGENTS.md', re: /(\d+)\s+freshness-tracked source groups/, value: s.freshnessSources },
    { file: 'AGENTS.md', re: /components\/\s+# (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'AGENTS.md', re: /services\/\s+# Business logic \((\d+)\s+service modules and domain directories\)/, value: s.serviceTopLevelEntries },
    { file: 'AGENTS.md', re: /requires buf \+ sebuf (v\d+\.\d+\.\d+) plugins/, value: s.sebufVersion },

    { file: 'ARCHITECTURE.md', re: /base class \((\d+)\s+classes\b/, value: s.panelClasses },
    { file: 'CONTRIBUTING.md', re: /Service and message definitions across (\d+)\s+domains/, value: s.protoDomainFolders },
    { file: 'CONTRIBUTING.md', re: /produces (\d+)\s+app variants/, value: s.variantCount },
    { file: 'CONTRIBUTING.md', re: /UI components — (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'CONTRIBUTING.md', re: /i18n JSON files \((\d+)\s+languages\)/, value: s.locales },
    { file: 'CONTRIBUTING.md', re: /Sebuf handler implementations for all (\d+)\s+server handler domains/, value: s.serverDomains },
    { file: 'CONTRIBUTING.md', re: /currently \*\*(v\d+\.\d+\.\d+)\*\*/, value: s.sebufVersion },
    { file: 'CONTRIBUTING.md', re: /expand our (\d+)\+\s+feed collection/, value: s.feedDefinitions, min: true },
    { file: 'SECURITY.md', re: /All (\d+)\s+domain APIs are served through Sebuf/, value: s.serverDomains },
    { file: 'index.html', re: /"(\d+)\s+language support with RTL"/, value: s.locales },
    { file: 'index.html', re: /multilingual \((\d+)\s+locales\)/, value: s.locales },
  ];
}

function main() {
  const check = process.argv.includes('--check');
  const stats = computeStats();

  if (!check) {
    mkdirSync(join(ROOT, 'scripts/generated'), { recursive: true });
    writeFileSync(join(ROOT, 'scripts/generated/stats.json'), JSON.stringify(stats, null, 2) + '\n');
    console.log('scripts/generated/stats.json written:');
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const failures = [];

  // Every CI workflow must be documented in ARCHITECTURE.md's CI/CD table.
  const arch = read('ARCHITECTURE.md');
  for (const wf of stats.workflows) {
    if (!arch.includes('`' + wf + '`')) {
      failures.push(`ARCHITECTURE.md: CI workflow \`${wf}\` is not listed in the CI/CD table`);
    }
  }

  failures.push(...validateIndexLanguageMetadata(stats));
  failures.push(...validateSupportedLanguagesRegistry(stats));

  for (const c of claims(stats)) {
    let text;
    try {
      text = read(c.file);
    } catch {
      failures.push(`${c.file}: file not found`);
      continue;
    }
    const m = text.match(c.re);
    if (!m) {
      failures.push(`${c.file}: claim pattern ${c.re} not found (expected ${c.value})`);
      continue;
    }
    if (c.min && typeof c.value !== 'number') {
      failures.push(`${c.file}: min claims must use numeric expected values — pattern ${c.re}`);
      continue;
    }
    const found = typeof c.value === 'number' ? Number(m[1]) : m[1];
    const ok = c.min ? found <= c.value : found === c.value;
    if (!ok) {
      failures.push(
        `${c.file}: doc says ${found}, code says ${c.value}${c.min ? ' (floor)' : ''} — pattern ${c.re}`,
      );
    }
  }

  if (failures.length) {
    console.error(`docs-stats --check FAILED (${failures.length}):`);
    for (const f of failures) console.error('  ✗ ' + f);
    console.error('\nFix the doc number, or run `npm run docs:stats` if the code total legitimately changed.');
    process.exit(1);
  }
  console.log(`docs-stats --check OK — ${claims(stats).length} doc claims match code.`);
}

export {
  computeStats,
  validateIndexLanguageMetadata,
  validateSupportedLanguagesRegistry,
  parseSupportedLanguages,
  parseJsonLdBlocks,
  sameStringSet,
  describeSetDelta,
  parseMcpAppsInventory,
};

// Run only when executed directly (node scripts/docs-stats.mjs [--check]).
// Stays import-safe so tests can load the validators without triggering the
// filesystem scan / CI gate on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
