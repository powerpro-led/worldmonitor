/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   node scripts/generate-nitric-routes.mjs
 *
 * Mechanically registers every Vercel Edge handler under api/ (except
 * api/mcp.ts, handled separately) onto the Nitric `api` gateway declared
 * in gcp/api/main.ts. GET/POST/PUT/PATCH/DELETE/OPTIONS are all registered
 * for every route — each handler already enforces its own method
 * allowlist internally (same as it does today under Vercel, where one
 * edge function receives every verb), so this is not widening what a
 * route accepts.
 *
 * Registered via route.all() (ONE gRPC stream per route), never per-method
 * .get()/.post()/…: the deployed Nitric membrane caps concurrent worker
 * streams at MAX_WORKERS (default 300) and routes past the cap silently
 * never register. See the comment on NITRIC_MAX_WORKERS_DEFAULT in the
 * generator.
 *
 * SKIPPED (visible gap, not silently dropped — see docs/architecture/
 * nitric-gcp-scaffold.md for what each of these needs):
 *   - api/[...notfound].ts (catch-all [...] segment — confirmed 2026-08-06 that Nitric itself has no wildcard route syntax, not just unsupported by this generator; see docs/architecture/nitric-gcp-scaffold.md)
 *   - api/data/city-coords.ts (no edge runtime config)
 *   - api/mcp/auth.ts (no edge runtime config)
 *   - api/mcp/billing-denial.ts (no edge runtime config)
 *   - api/mcp/constants.ts (no edge runtime config)
 *   - api/mcp/dispatch.ts (no edge runtime config)
 *   - api/mcp/downstream.ts (no edge runtime config)
 *   - api/mcp/error-fingerprint.ts (no edge runtime config)
 *   - api/mcp/filters.ts (no edge runtime config)
 *   - api/mcp/freshness.ts (no edge runtime config)
 *   - api/mcp/handler.ts (no edge runtime config)
 *   - api/mcp/jmespath.ts (no edge runtime config)
 *   - api/mcp/prompts/index.ts (no edge runtime config)
 *   - api/mcp/registry/cache-tools.ts (no edge runtime config)
 *   - api/mcp/registry/index.ts (no edge runtime config)
 *   - api/mcp/registry/rpc-tools.ts (no edge runtime config)
 *   - api/mcp/resources/index.ts (no edge runtime config)
 *   - api/mcp/resources/slugs.ts (no edge runtime config)
 *   - api/mcp/rpc.ts (no edge runtime config)
 *   - api/mcp/telemetry.ts (no edge runtime config)
 *   - api/mcp/types.ts (no edge runtime config)
 *   - api/mcp/ui/chokepoint-monitor-app.ts (no edge runtime config)
 *   - api/mcp/ui/conflict-events-app.ts (no edge runtime config)
 *   - api/mcp/ui/country-brief-app.ts (no edge runtime config)
 *   - api/mcp/ui/country-risk-app.ts (no edge runtime config)
 *   - api/mcp/ui/forecasts-app.ts (no edge runtime config)
 *   - api/mcp/ui/market-radar-app.ts (no edge runtime config)
 *   - api/mcp/ui/natural-disasters-app.ts (no edge runtime config)
 *   - api/mcp/ui/news-intelligence-app.ts (no edge runtime config)
 *   - api/mcp/ui/prediction-markets-app.ts (no edge runtime config)
 *   - api/mcp/ui/registry.ts (no edge runtime config)
 *   - api/mcp/ui/shell.ts (no edge runtime config)
 *   - api/mcp/ui/world-brief-app.ts (no edge runtime config)
 *   - api/mcp/usage.ts (no edge runtime config)
 *   - api/mcp/utils.ts (no edge runtime config)
 */

import type { Api } from '@nitric/sdk';
import { adaptVercelHandler } from './adapt-vercel-handler';
import route_0_a2aHandler from '../../api/a2a';
import route_1_agent_authHandler from '../../api/agent-auth';
import route_2_askHandler from '../../api/ask';
import route_3_aviation_v1_rpcHandler from '../../api/aviation/v1/[rpc]';
import route_4_batch_v1_rpcHandler from '../../api/batch/v1/[rpc]';
// @ts-expect-error — JS module, no declaration file
import route_5_bootstrapHandler from '../../api/bootstrap.js';
import route_6_brief_userId_issueDateHandler from '../../api/brief/[userId]/[issueDate]';
import route_7_brief_carousel_userId_issueDate_pageHandler from '../../api/brief/carousel/[userId]/[issueDate]/[page]';
// @ts-expect-error — JS module, no declaration file
import route_8_cache_purgeHandler from '../../api/cache-purge.js';
import route_9_chat_analystHandler from '../../api/chat-analyst';
import route_10_climate_v1_rpcHandler from '../../api/climate/v1/[rpc]';
import route_11_conflict_v1_rpcHandler from '../../api/conflict/v1/[rpc]';
import route_12_consumer_prices_v1_rpcHandler from '../../api/consumer-prices/v1/[rpc]';
import route_13_cyber_v1_rpcHandler from '../../api/cyber/v1/[rpc]';
import route_14_discord_oauth_callbackHandler from '../../api/discord/oauth/callback';
import route_15_discord_oauth_startHandler from '../../api/discord/oauth/start';
import route_16_displacement_v1_rpcHandler from '../../api/displacement/v1/[rpc]';
import route_17_economic_v1_rpcHandler from '../../api/economic/v1/[rpc]';
import route_18_followed_countriesHandler from '../../api/followed-countries';
import route_19_forecast_v1_rpcHandler from '../../api/forecast/v1/[rpc]';
// @ts-expect-error — JS module, no declaration file
import route_20_fwdstartHandler from '../../api/fwdstart.js';
// @ts-expect-error — JS module, no declaration file
import route_21_geoHandler from '../../api/geo.js';
import route_22_giving_v1_rpcHandler from '../../api/giving/v1/[rpc]';
// @ts-expect-error — JS module, no declaration file
import route_23_gpsjamHandler from '../../api/gpsjam.js';
// @ts-expect-error — JS module, no declaration file
import route_24_healthHandler from '../../api/health.js';
import route_25_health_v1_rpcHandler from '../../api/health/v1/[rpc]';
import route_26_http_message_signatures_directoryHandler from '../../api/http-message-signatures-directory';
import route_27_imagery_v1_rpcHandler from '../../api/imagery/v1/[rpc]';
import route_28_infrastructure_v1_rpcHandler from '../../api/infrastructure/v1/[rpc]';
import route_29_intelligence_v1_rpcHandler from '../../api/intelligence/v1/[rpc]';
import route_30_internal_brief_why_mattersHandler from '../../api/internal/brief-why-matters';
import route_31_latest_briefHandler from '../../api/latest-brief';
import route_32_maritime_v1_rpcHandler from '../../api/maritime/v1/[rpc]';
import route_33_market_v1_rpcHandler from '../../api/market/v1/[rpc]';
import route_34_mcp_proxyHandler from '../../api/mcp-proxy';
import route_35_military_v1_rpcHandler from '../../api/military/v1/[rpc]';
import route_36_natural_v1_rpcHandler from '../../api/natural/v1/[rpc]';
import route_37_news_v1_rpcHandler from '../../api/news/v1/[rpc]';
import route_38_not_foundHandler from '../../api/not-found';
import route_39_notification_channelsHandler from '../../api/notification-channels';
import route_40_notifyHandler from '../../api/notify';
import route_41_oauth_authorization_serverHandler from '../../api/oauth-authorization-server';
import route_42_oauth_protected_resourceHandler from '../../api/oauth-protected-resource';
// @ts-expect-error — JS module, no declaration file
import route_43_oauth_authorizeHandler from '../../api/oauth/authorize.js';
// @ts-expect-error — JS module, no declaration file
import route_44_oauth_registerHandler from '../../api/oauth/register.js';
import route_45_oauth_tokenHandler from '../../api/oauth/token';
// @ts-expect-error — JS module, no declaration file
import route_46_openskyHandler from '../../api/opensky.js';
// @ts-expect-error — JS module, no declaration file
import route_47_oref_alertsHandler from '../../api/oref-alerts.js';
// @ts-expect-error — JS module, no declaration file
import route_48_polymarketHandler from '../../api/polymarket.js';
import route_49_positive_events_v1_rpcHandler from '../../api/positive-events/v1/[rpc]';
import route_50_prediction_v1_rpcHandler from '../../api/prediction/v1/[rpc]';
import route_51_radiation_v1_rpcHandler from '../../api/radiation/v1/[rpc]';
import route_52_research_v1_rpcHandler from '../../api/research/v1/[rpc]';
import route_53_resilience_v1_rpcHandler from '../../api/resilience/v1/[rpc]';
// @ts-expect-error — JS module, no declaration file
import route_54_reverse_geocodeHandler from '../../api/reverse-geocode.js';
// @ts-expect-error — JS module, no declaration file
import route_55_rss_proxyHandler from '../../api/rss-proxy.js';
import route_56_sanctions_v1_rpcHandler from '../../api/sanctions/v1/[rpc]';
import route_57_scenario_v1_rpcHandler from '../../api/scenario/v1/[rpc]';
import route_58_scenario_v1_runHandler from '../../api/scenario/v1/run';
import route_59_scenario_v1_statusHandler from '../../api/scenario/v1/status';
import route_60_scenario_v1_templatesHandler from '../../api/scenario/v1/templates';
// @ts-expect-error — JS module, no declaration file
import route_61_security_reportHandler from '../../api/security/report.js';
import route_62_seed_contract_probeHandler from '../../api/seed-contract-probe';
// @ts-expect-error — JS module, no declaration file
import route_63_seed_healthHandler from '../../api/seed-health.js';
import route_64_seismology_v1_rpcHandler from '../../api/seismology/v1/[rpc]';
import route_65_skills_fetch_agentskillsHandler from '../../api/skills/fetch-agentskills';
import route_66_slack_oauth_callbackHandler from '../../api/slack/oauth/callback';
import route_67_slack_oauth_startHandler from '../../api/slack/oauth/start';
// @ts-expect-error — JS module, no declaration file
import route_68_supply_chain_hormuz_trackerHandler from '../../api/supply-chain/hormuz-tracker.js';
import route_69_supply_chain_v1_rpcHandler from '../../api/supply-chain/v1/[rpc]';
import route_70_supply_chain_v1_country_productsHandler from '../../api/supply-chain/v1/country-products';
import route_71_supply_chain_v1_multi_sector_cost_shockHandler from '../../api/supply-chain/v1/multi-sector-cost-shock';
import route_72_symbol_searchHandler from '../../api/symbol-search';
// @ts-expect-error — JS module, no declaration file
import route_73_telegram_feedHandler from '../../api/telegram-feed.js';
import route_74_telegram_pair_callbackHandler from '../../api/telegram/pair-callback';
import route_75_thermal_v1_rpcHandler from '../../api/thermal/v1/[rpc]';
import route_76_trade_v1_rpcHandler from '../../api/trade/v1/[rpc]';
import route_77_unrest_v1_rpcHandler from '../../api/unrest/v1/[rpc]';
import route_78_user_prefsHandler from '../../api/user-prefs';
import route_79_v2_shipping_rpcHandler from '../../api/v2/shipping/[rpc]';
import route_80_v2_shipping_webhooks_subscriberIdHandler from '../../api/v2/shipping/webhooks/[subscriberId]';
import route_81_v2_shipping_webhooks_subscriberId_actionHandler from '../../api/v2/shipping/webhooks/[subscriberId]/[action]';
// @ts-expect-error — JS module, no declaration file
import route_82_versionHandler from '../../api/version.js';
import route_83_widget_agentHandler from '../../api/widget-agent';
import route_84_wildfire_v1_rpcHandler from '../../api/wildfire/v1/[rpc]';
// @ts-expect-error — JS module, no declaration file
import route_85_wm_sessionHandler from '../../api/wm-session.js';

export function registerGeneratedRoutes(api: Api): void {
  api.route('/api/a2a').all(adaptVercelHandler(route_0_a2aHandler));
  api.route('/api/agent-auth').all(adaptVercelHandler(route_1_agent_authHandler));
  api.route('/api/ask').all(adaptVercelHandler(route_2_askHandler));
  api.route('/api/aviation/v1/:rpc').all(adaptVercelHandler(route_3_aviation_v1_rpcHandler));
  api.route('/api/batch/v1/:rpc').all(adaptVercelHandler(route_4_batch_v1_rpcHandler));
  api.route('/api/bootstrap').all(adaptVercelHandler(route_5_bootstrapHandler));
  api.route('/api/brief/:userId/:issueDate').all(adaptVercelHandler(route_6_brief_userId_issueDateHandler));
  api.route('/api/brief/carousel/:userId/:issueDate/:page').all(adaptVercelHandler(route_7_brief_carousel_userId_issueDate_pageHandler));
  api.route('/api/cache-purge').all(adaptVercelHandler(route_8_cache_purgeHandler));
  api.route('/api/chat-analyst').all(adaptVercelHandler(route_9_chat_analystHandler));
  api.route('/api/climate/v1/:rpc').all(adaptVercelHandler(route_10_climate_v1_rpcHandler));
  api.route('/api/conflict/v1/:rpc').all(adaptVercelHandler(route_11_conflict_v1_rpcHandler));
  api.route('/api/consumer-prices/v1/:rpc').all(adaptVercelHandler(route_12_consumer_prices_v1_rpcHandler));
  api.route('/api/cyber/v1/:rpc').all(adaptVercelHandler(route_13_cyber_v1_rpcHandler));
  api.route('/api/discord/oauth/callback').all(adaptVercelHandler(route_14_discord_oauth_callbackHandler));
  api.route('/api/discord/oauth/start').all(adaptVercelHandler(route_15_discord_oauth_startHandler));
  api.route('/api/displacement/v1/:rpc').all(adaptVercelHandler(route_16_displacement_v1_rpcHandler));
  api.route('/api/economic/v1/:rpc').all(adaptVercelHandler(route_17_economic_v1_rpcHandler));
  api.route('/api/followed-countries').all(adaptVercelHandler(route_18_followed_countriesHandler));
  api.route('/api/forecast/v1/:rpc').all(adaptVercelHandler(route_19_forecast_v1_rpcHandler));
  api.route('/api/fwdstart').all(adaptVercelHandler(route_20_fwdstartHandler));
  api.route('/api/geo').all(adaptVercelHandler(route_21_geoHandler));
  api.route('/api/giving/v1/:rpc').all(adaptVercelHandler(route_22_giving_v1_rpcHandler));
  api.route('/api/gpsjam').all(adaptVercelHandler(route_23_gpsjamHandler));
  api.route('/api/health').all(adaptVercelHandler(route_24_healthHandler));
  api.route('/api/health/v1/:rpc').all(adaptVercelHandler(route_25_health_v1_rpcHandler));
  api.route('/api/http-message-signatures-directory').all(adaptVercelHandler(route_26_http_message_signatures_directoryHandler));
  api.route('/api/imagery/v1/:rpc').all(adaptVercelHandler(route_27_imagery_v1_rpcHandler));
  api.route('/api/infrastructure/v1/:rpc').all(adaptVercelHandler(route_28_infrastructure_v1_rpcHandler));
  api.route('/api/intelligence/v1/:rpc').all(adaptVercelHandler(route_29_intelligence_v1_rpcHandler));
  api.route('/api/internal/brief-why-matters').all(adaptVercelHandler(route_30_internal_brief_why_mattersHandler));
  api.route('/api/latest-brief').all(adaptVercelHandler(route_31_latest_briefHandler));
  api.route('/api/maritime/v1/:rpc').all(adaptVercelHandler(route_32_maritime_v1_rpcHandler));
  api.route('/api/market/v1/:rpc').all(adaptVercelHandler(route_33_market_v1_rpcHandler));
  api.route('/api/mcp-proxy').all(adaptVercelHandler(route_34_mcp_proxyHandler));
  api.route('/api/military/v1/:rpc').all(adaptVercelHandler(route_35_military_v1_rpcHandler));
  api.route('/api/natural/v1/:rpc').all(adaptVercelHandler(route_36_natural_v1_rpcHandler));
  api.route('/api/news/v1/:rpc').all(adaptVercelHandler(route_37_news_v1_rpcHandler));
  api.route('/api/not-found').all(adaptVercelHandler(route_38_not_foundHandler));
  api.route('/api/notification-channels').all(adaptVercelHandler(route_39_notification_channelsHandler));
  api.route('/api/notify').all(adaptVercelHandler(route_40_notifyHandler));
  api.route('/api/oauth-authorization-server').all(adaptVercelHandler(route_41_oauth_authorization_serverHandler));
  api.route('/api/oauth-protected-resource').all(adaptVercelHandler(route_42_oauth_protected_resourceHandler));
  api.route('/api/oauth/authorize').all(adaptVercelHandler(route_43_oauth_authorizeHandler));
  api.route('/api/oauth/register').all(adaptVercelHandler(route_44_oauth_registerHandler));
  api.route('/api/oauth/token').all(adaptVercelHandler(route_45_oauth_tokenHandler));
  api.route('/api/opensky').all(adaptVercelHandler(route_46_openskyHandler));
  api.route('/api/oref-alerts').all(adaptVercelHandler(route_47_oref_alertsHandler));
  api.route('/api/polymarket').all(adaptVercelHandler(route_48_polymarketHandler));
  api.route('/api/positive-events/v1/:rpc').all(adaptVercelHandler(route_49_positive_events_v1_rpcHandler));
  api.route('/api/prediction/v1/:rpc').all(adaptVercelHandler(route_50_prediction_v1_rpcHandler));
  api.route('/api/radiation/v1/:rpc').all(adaptVercelHandler(route_51_radiation_v1_rpcHandler));
  api.route('/api/research/v1/:rpc').all(adaptVercelHandler(route_52_research_v1_rpcHandler));
  api.route('/api/resilience/v1/:rpc').all(adaptVercelHandler(route_53_resilience_v1_rpcHandler));
  api.route('/api/reverse-geocode').all(adaptVercelHandler(route_54_reverse_geocodeHandler));
  api.route('/api/rss-proxy').all(adaptVercelHandler(route_55_rss_proxyHandler));
  api.route('/api/sanctions/v1/:rpc').all(adaptVercelHandler(route_56_sanctions_v1_rpcHandler));
  api.route('/api/scenario/v1/:rpc').all(adaptVercelHandler(route_57_scenario_v1_rpcHandler));
  api.route('/api/scenario/v1/run').all(adaptVercelHandler(route_58_scenario_v1_runHandler));
  api.route('/api/scenario/v1/status').all(adaptVercelHandler(route_59_scenario_v1_statusHandler));
  api.route('/api/scenario/v1/templates').all(adaptVercelHandler(route_60_scenario_v1_templatesHandler));
  api.route('/api/security/report').all(adaptVercelHandler(route_61_security_reportHandler));
  api.route('/api/seed-contract-probe').all(adaptVercelHandler(route_62_seed_contract_probeHandler));
  api.route('/api/seed-health').all(adaptVercelHandler(route_63_seed_healthHandler));
  api.route('/api/seismology/v1/:rpc').all(adaptVercelHandler(route_64_seismology_v1_rpcHandler));
  api.route('/api/skills/fetch-agentskills').all(adaptVercelHandler(route_65_skills_fetch_agentskillsHandler));
  api.route('/api/slack/oauth/callback').all(adaptVercelHandler(route_66_slack_oauth_callbackHandler));
  api.route('/api/slack/oauth/start').all(adaptVercelHandler(route_67_slack_oauth_startHandler));
  api.route('/api/supply-chain/hormuz-tracker').all(adaptVercelHandler(route_68_supply_chain_hormuz_trackerHandler));
  api.route('/api/supply-chain/v1/:rpc').all(adaptVercelHandler(route_69_supply_chain_v1_rpcHandler));
  api.route('/api/supply-chain/v1/country-products').all(adaptVercelHandler(route_70_supply_chain_v1_country_productsHandler));
  api.route('/api/supply-chain/v1/multi-sector-cost-shock').all(adaptVercelHandler(route_71_supply_chain_v1_multi_sector_cost_shockHandler));
  api.route('/api/symbol-search').all(adaptVercelHandler(route_72_symbol_searchHandler));
  api.route('/api/telegram-feed').all(adaptVercelHandler(route_73_telegram_feedHandler));
  api.route('/api/telegram/pair-callback').all(adaptVercelHandler(route_74_telegram_pair_callbackHandler));
  api.route('/api/thermal/v1/:rpc').all(adaptVercelHandler(route_75_thermal_v1_rpcHandler));
  api.route('/api/trade/v1/:rpc').all(adaptVercelHandler(route_76_trade_v1_rpcHandler));
  api.route('/api/unrest/v1/:rpc').all(adaptVercelHandler(route_77_unrest_v1_rpcHandler));
  api.route('/api/user-prefs').all(adaptVercelHandler(route_78_user_prefsHandler));
  api.route('/api/v2/shipping/:rpc').all(adaptVercelHandler(route_79_v2_shipping_rpcHandler));
  api.route('/api/v2/shipping/webhooks/:subscriberId').all(adaptVercelHandler(route_80_v2_shipping_webhooks_subscriberIdHandler));
  api.route('/api/v2/shipping/webhooks/:subscriberId/:action').all(adaptVercelHandler(route_81_v2_shipping_webhooks_subscriberId_actionHandler));
  api.route('/api/version').all(adaptVercelHandler(route_82_versionHandler));
  api.route('/api/widget-agent').all(adaptVercelHandler(route_83_widget_agentHandler));
  api.route('/api/wildfire/v1/:rpc').all(adaptVercelHandler(route_84_wildfire_v1_rpcHandler));
  api.route('/api/wm-session').all(adaptVercelHandler(route_85_wm_sessionHandler));
}
