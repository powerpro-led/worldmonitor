// userPreferences (CURRENT_PREFS_SCHEMA_VERSION/MAX_PREFS_BLOB_SIZE/
// USER_PREFS_WRITE_RATE_LIMIT/USER_PREFS_WRITE_RATE_WINDOW_MS) and
// followed-countries (FREE_TIER_FOLLOW_LIMIT/MAX_MERGE_INPUT/
// COUNTRY_COUNT_PRIVACY_FLOOR/SHARD_COUNT) constants retired in Stage 2 of
// the Convex/Clerk -> Supabase migration alongside their Convex modules —
// ported equivalents (minus FREE_TIER_FOLLOW_LIMIT/SHARD_COUNT, which have
// no Postgres-side equivalent) live in `server/_shared/user-preferences.ts`
// and `server/_shared/followed-countries.ts`. See memory
// `supabase-migration-stage1`.
//
// channelTypeValidator/sensitivityValidator/quietHoursOverrideValidator/
// digestModeValidator retired in Stage 3 alongside notificationChannels/
// alertRules/telegramPairingTokens — ported equivalents (plain TS union
// types, no Convex `v.union` needed) live in
// `server/_shared/{notification-channels,alert-rules}.ts`.
