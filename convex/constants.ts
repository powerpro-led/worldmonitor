import { v } from "convex/values";

export const channelTypeValidator = v.union(
  v.literal("telegram"),
  v.literal("slack"),
  v.literal("email"),
  v.literal("discord"),
  v.literal("webhook"),
  v.literal("web_push"),
);

export const sensitivityValidator = v.union(
  v.literal("all"),
  v.literal("high"),
  v.literal("critical"),
);

export const quietHoursOverrideValidator = v.union(
  v.literal("critical_only"),
  v.literal("silence_all"),
  v.literal("batch_on_wake"),
);

export const digestModeValidator = v.union(
  v.literal("realtime"),
  v.literal("daily"),
  v.literal("twice_daily"),
  v.literal("weekly"),
);

// userPreferences (CURRENT_PREFS_SCHEMA_VERSION/MAX_PREFS_BLOB_SIZE/
// USER_PREFS_WRITE_RATE_LIMIT/USER_PREFS_WRITE_RATE_WINDOW_MS) and
// followed-countries (FREE_TIER_FOLLOW_LIMIT/MAX_MERGE_INPUT/
// COUNTRY_COUNT_PRIVACY_FLOOR/SHARD_COUNT) constants retired in Stage 2 of
// the Convex/Clerk -> Supabase migration alongside their Convex modules —
// ported equivalents (minus FREE_TIER_FOLLOW_LIMIT/SHARD_COUNT, which have
// no Postgres-side equivalent) live in `server/_shared/user-preferences.ts`
// and `server/_shared/followed-countries.ts`. See memory
// `supabase-migration-stage1`.
