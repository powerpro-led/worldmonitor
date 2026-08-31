/**
 * Unified intelligence service module.
 *
 * Re-exports from legacy service files that have complex client-side logic
 * (DEFCON calculation, circuit breakers, batch classification, GDELT DOC API).
 * Server-side edge functions are consolidated in the handler.
 */

// PizzINT dashboard + GDELT tensions
export {
  fetchPizzIntStatus,
  fetchGdeltTensions,
  getPizzIntStatus,
  getGdeltStatus,
} from '../pizzint';

// Risk scores (CII + strategic risk)
export {
  fetchCachedRiskScores,
  getCachedScores,
  hasCachedScores,
  toCountryScore,
} from '../cached-risk-scores';
export type { CachedCIIScore, CachedStrategicRisk, CachedRiskScores } from '../cached-risk-scores';

// Threat classification (keyword + AI)
export {
  classifyByKeyword,
  classifyWithAI,
  aggregateThreats,
  THREAT_PRIORITY,
} from '../threat-classifier';
export type { ThreatClassification, ThreatLevel, EventCategory } from '../threat-classifier';

// GDELT intelligence removed entirely 2026-08-31 — GdeltIntelPanel ("实时情报"),
// MapPopup hotspot context, AND the Good News Explorer positive-topic path
// (fetchAllPositiveTopicIntelligence + the search-gdelt-documents RPC). The
// positive-topic path had never actually worked: it queried topics that were
// never in the seeded cache, so it always returned seed-unavailable. See
// TASKS.md's FORTIETH-session HANDOFF.
