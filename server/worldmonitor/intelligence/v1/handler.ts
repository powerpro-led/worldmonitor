import type { IntelligenceServiceHandler } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getRiskScores } from './get-risk-scores';
import { getCountryRisk } from './get-country-risk';
import { getPizzintStatus } from './get-pizzint-status';
import { classifyEvent } from './classify-event';
import { getCountryIntelBrief } from './get-country-intel-brief';
import { deductSituation } from './deduct-situation';
import { getCountryFacts } from './get-country-facts';
import { listSecurityAdvisories } from './list-security-advisories';
import { listSatellites } from './list-satellites';
import { listGpsInterference } from './list-gps-interference';
import { listOrefAlerts } from './list-oref-alerts';
import { listTelegramFeed } from './list-telegram-feed';
import { getCompanyEnrichment } from './get-company-enrichment';
import { listCompanySignals } from './list-company-signals';
import { listCrossSourceSignals } from './list-cross-source-signals';
import { listMarketImplications } from './list-market-implications';
import { getSocialVelocity } from './get-social-velocity';
import { getCountryEnergyProfile } from './get-country-energy-profile';
import { computeEnergyShockScenario } from './compute-energy-shock';
import { getCountryPortActivity } from './get-country-port-activity';
import { getRegionalSnapshot } from './get-regional-snapshot';
import { getRegimeHistory } from './get-regime-history';
import { getRegionalBrief } from './get-regional-brief';

export const intelligenceHandler: IntelligenceServiceHandler = {
  getRiskScores,
  getCountryRisk,
  getPizzintStatus,
  classifyEvent,
  getCountryIntelBrief,
  deductSituation,
  getCountryFacts,
  listSecurityAdvisories,
  listSatellites,
  listGpsInterference,
  listOrefAlerts,
  listTelegramFeed,
  getCompanyEnrichment,
  listCompanySignals,
  listCrossSourceSignals,
  listMarketImplications,
  getSocialVelocity,
  getCountryEnergyProfile,
  computeEnergyShockScenario,
  getCountryPortActivity,
  getRegionalSnapshot,
  getRegimeHistory,
  getRegionalBrief,
};
