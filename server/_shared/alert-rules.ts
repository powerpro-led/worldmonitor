/**
 * `worldmonitor.alert_rules` CRUD (Postgres, service-role Supabase client) —
 * Stage 3 of the Convex/Clerk -> Supabase migration replaced
 * `convex/alertRules.ts` with direct Postgres queries through
 * `server/_shared/supabase-admin.ts`. Callers: `api/notification-channels.ts`
 * (all user-facing actions) and `scripts/lib/alert-rules-fetch.cjs` (the
 * Railway delivery/digest scripts' `getDigestRules`/`getByEnabled` reads —
 * separate CommonJS client, same table).
 *
 * The PRO-entitlement gate (`assertProEntitlement`) is NOT ported — see the
 * module doc in `server/_shared/notification-channels.ts` for why: Convex's
 * `entitlements` table has had nothing writing to it since Stage 1, so the
 * gate had degenerated into "reject every write." Dropped entirely.
 *
 * Everything else — the cross-field (digestMode, sensitivity) invariant,
 * countries/tickers shape validation + caps — is pure logic, ported verbatim.
 */

import { getSupabaseAdmin } from './supabase-admin';

export type Sensitivity = 'all' | 'high' | 'critical';
export type DigestMode = 'realtime' | 'daily' | 'twice_daily' | 'weekly';
export type QuietHoursOverride = 'critical_only' | 'silence_all' | 'batch_on_wake';
export type ChannelType = 'telegram' | 'slack' | 'email' | 'discord' | 'webhook' | 'web_push';

export interface AlertRule {
  variant: string;
  enabled: boolean;
  eventTypes: string[];
  sensitivity: Sensitivity;
  channels: ChannelType[];
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: QuietHoursOverride;
  digestMode?: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
  aiDigestEnabled?: boolean;
  countries?: string[];
  tickers?: string[];
}

/** Digest rules / relay-enabled rows also carry `userId` — service-role-only shape. */
export interface AlertRuleWithUser extends AlertRule {
  userId: string;
}

export type AlertRulesErrorKind =
  | 'INCOMPATIBLE_DELIVERY'
  | 'COUNTRIES_LIMIT_EXCEEDED'
  | 'TICKERS_LIMIT_EXCEEDED'
  | 'INVALID_INPUT'
  | 'CONFIG'
  | 'NETWORK';

export class AlertRulesError extends Error {
  readonly kind: AlertRulesErrorKind;
  constructor(kind: AlertRulesErrorKind, message: string) {
    super(message);
    this.name = 'AlertRulesError';
    this.kind = kind;
  }
}

function requireSupabase() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new AlertRulesError('CONFIG', 'Supabase service-role client unconfigured');
  return supabase;
}

// ── Cross-field (digestMode, sensitivity) invariant — ported verbatim from convex/alertRules.ts ──
//
// Real-time delivery is reserved for `critical`-tier events only. Anything
// below `critical` must live in a digest cadence. See
// docs/archive/plans/forbid-realtime-all-events.md.

function resolveEffectivePair(args: {
  incomingDigestMode?: DigestMode;
  incomingSensitivity?: Sensitivity;
  existing?: { digestMode?: DigestMode | string | null; sensitivity?: Sensitivity | string | null };
}): { digestMode: DigestMode; sensitivity: Sensitivity } {
  const digestMode = (args.incomingDigestMode
    ?? (args.existing?.digestMode as DigestMode | undefined | null)
    ?? 'realtime') as DigestMode;
  const sensitivity = (args.incomingSensitivity
    ?? (args.existing?.sensitivity as Sensitivity | undefined | null)
    ?? 'critical') as Sensitivity; // insert-only default — patch path never includes sensitivity unless caller passed it
  return { digestMode, sensitivity };
}

function assertCompatibleDeliveryMode(pair: { digestMode: DigestMode; sensitivity: Sensitivity }): void {
  if (pair.digestMode === 'realtime' && (pair.sensitivity === 'all' || pair.sensitivity === 'high')) {
    throw new AlertRulesError(
      'INCOMPATIBLE_DELIVERY',
      'Real-time delivery is for Critical events only. ' +
      'To receive High or All events, choose a digest cadence (Daily, Twice daily, or Weekly).',
    );
  }
}

// ── countries / tickers normalization — ported verbatim ──

const COUNTRIES_MAX = 50;

function normalizeCountries(input: string[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const upper = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(upper)) continue;
    if (seen.has(upper)) continue;
    seen.add(upper);
    cleaned.push(upper);
  }
  if (cleaned.length > COUNTRIES_MAX) {
    throw new AlertRulesError('COUNTRIES_LIMIT_EXCEEDED', `countries list capped at ${COUNTRIES_MAX} entries`);
  }
  return cleaned;
}

const TICKERS_MAX = 50;

function normalizeTickers(input: string[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const upper = raw.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9&-]{0,11}(\.[A-Z]{1,3})?$/.test(upper)) continue;
    if (seen.has(upper)) continue;
    seen.add(upper);
    cleaned.push(upper);
  }
  if (cleaned.length > TICKERS_MAX) {
    throw new AlertRulesError('TICKERS_LIMIT_EXCEEDED', `tickers list capped at ${TICKERS_MAX} entries`);
  }
  return cleaned;
}

function validateDigestHour(digestHour: number | undefined): void {
  if (digestHour !== undefined && (digestHour < 0 || digestHour > 23 || !Number.isInteger(digestHour))) {
    throw new AlertRulesError('INVALID_INPUT', 'digestHour must be an integer 0–23');
  }
}

function validateTimezone(tz: string | undefined): void {
  if (tz === undefined) return;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new AlertRulesError('INVALID_INPUT', `invalid IANA timezone: ${tz}`);
  }
}

function validateQuietHours(args: { quietHoursStart?: number; quietHoursEnd?: number; quietHoursTimezone?: string }): void {
  if (args.quietHoursStart !== undefined && (args.quietHoursStart < 0 || args.quietHoursStart > 23 || !Number.isInteger(args.quietHoursStart))) {
    throw new AlertRulesError('INVALID_INPUT', 'quietHoursStart must be an integer 0–23');
  }
  if (args.quietHoursEnd !== undefined && (args.quietHoursEnd < 0 || args.quietHoursEnd > 23 || !Number.isInteger(args.quietHoursEnd))) {
    throw new AlertRulesError('INVALID_INPUT', 'quietHoursEnd must be an integer 0–23');
  }
  validateTimezone(args.quietHoursTimezone);
}

// ── row <-> wire mapping ──

interface RuleRowRaw {
  id: string;
  user_id: string;
  variant: string;
  enabled: boolean;
  event_types: string[];
  sensitivity: Sensitivity;
  channels: string[];
  quiet_hours_enabled: boolean | null;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  quiet_hours_timezone: string | null;
  quiet_hours_override: QuietHoursOverride | null;
  digest_mode: DigestMode | null;
  digest_hour: number | null;
  digest_timezone: string | null;
  ai_digest_enabled: boolean | null;
  countries: string[] | null;
  tickers: string[] | null;
}

const RULE_SELECT = 'id, user_id, variant, enabled, event_types, sensitivity, channels, ' +
  'quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone, quiet_hours_override, ' +
  'digest_mode, digest_hour, digest_timezone, ai_digest_enabled, countries, tickers';

function rowToRule(row: RuleRowRaw): AlertRuleWithUser {
  return {
    userId: row.user_id,
    variant: row.variant,
    enabled: row.enabled,
    eventTypes: row.event_types ?? [],
    sensitivity: row.sensitivity,
    channels: (row.channels ?? []) as ChannelType[],
    ...(row.quiet_hours_enabled != null ? { quietHoursEnabled: row.quiet_hours_enabled } : {}),
    ...(row.quiet_hours_start != null ? { quietHoursStart: row.quiet_hours_start } : {}),
    ...(row.quiet_hours_end != null ? { quietHoursEnd: row.quiet_hours_end } : {}),
    ...(row.quiet_hours_timezone != null ? { quietHoursTimezone: row.quiet_hours_timezone } : {}),
    ...(row.quiet_hours_override != null ? { quietHoursOverride: row.quiet_hours_override } : {}),
    ...(row.digest_mode != null ? { digestMode: row.digest_mode } : {}),
    ...(row.digest_hour != null ? { digestHour: row.digest_hour } : {}),
    ...(row.digest_timezone != null ? { digestTimezone: row.digest_timezone } : {}),
    ...(row.ai_digest_enabled != null ? { aiDigestEnabled: row.ai_digest_enabled } : {}),
    ...(row.countries != null ? { countries: row.countries } : {}),
    ...(row.tickers != null ? { tickers: row.tickers } : {}),
  };
}

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

async function loadExisting(supabase: SupabaseAdmin, userId: string, variant: string): Promise<RuleRowRaw | null> {
  const { data, error } = await supabase
    .from('alert_rules')
    .select(RULE_SELECT)
    .eq('user_id', userId)
    .eq('variant', variant)
    .maybeSingle();
  if (error) throw new AlertRulesError('NETWORK', `alert-rules read failed: ${error.message}`);
  return data as unknown as RuleRowRaw | null;
}

/**
 * Maps the raw (snake_case) row to the camelCase shape resolveEffectivePair
 * expects. Passing the raw row directly is a silent bug: `existing.digestMode`
 * on a `RuleRowRaw` is always undefined (the field is `digest_mode`), so the
 * pair would always fall back to the 'realtime' default on every patch,
 * regardless of what digest mode the row was actually already in.
 */
function existingPair(existing: RuleRowRaw | null): { digestMode?: DigestMode | null; sensitivity?: Sensitivity | null } | undefined {
  return existing ? { digestMode: existing.digest_mode, sensitivity: existing.sensitivity } : undefined;
}

/** Full row-merge: preserve-on-omit for every field not present in `patch`, same contract as Convex's ctx.db.patch. */
function mergedRow(userId: string, variant: string, existing: RuleRowRaw | null, patch: Partial<RuleRowRaw>): Record<string, unknown> {
  return {
    user_id: userId,
    variant,
    enabled: patch.enabled ?? existing?.enabled ?? true,
    event_types: patch.event_types ?? existing?.event_types ?? [],
    sensitivity: patch.sensitivity ?? existing?.sensitivity ?? 'critical',
    channels: patch.channels ?? existing?.channels ?? [],
    quiet_hours_enabled: 'quiet_hours_enabled' in patch ? patch.quiet_hours_enabled : existing?.quiet_hours_enabled ?? null,
    quiet_hours_start: 'quiet_hours_start' in patch ? patch.quiet_hours_start : existing?.quiet_hours_start ?? null,
    quiet_hours_end: 'quiet_hours_end' in patch ? patch.quiet_hours_end : existing?.quiet_hours_end ?? null,
    quiet_hours_timezone: 'quiet_hours_timezone' in patch ? patch.quiet_hours_timezone : existing?.quiet_hours_timezone ?? null,
    quiet_hours_override: 'quiet_hours_override' in patch ? patch.quiet_hours_override : existing?.quiet_hours_override ?? null,
    digest_mode: 'digest_mode' in patch ? patch.digest_mode : existing?.digest_mode ?? null,
    digest_hour: 'digest_hour' in patch ? patch.digest_hour : existing?.digest_hour ?? null,
    digest_timezone: 'digest_timezone' in patch ? patch.digest_timezone : existing?.digest_timezone ?? null,
    ai_digest_enabled: 'ai_digest_enabled' in patch ? patch.ai_digest_enabled : existing?.ai_digest_enabled ?? null,
    countries: 'countries' in patch ? patch.countries : existing?.countries ?? null,
    tickers: 'tickers' in patch ? patch.tickers : existing?.tickers ?? null,
    updated_at: new Date().toISOString(),
  };
}

async function upsertRule(supabase: SupabaseAdmin, doc: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('alert_rules').upsert(doc, { onConflict: 'user_id,variant' });
  if (error) throw new AlertRulesError('NETWORK', `alert-rules write failed: ${error.message}`);
}

// ── public CRUD ──

export async function getAlertRules(userId: string): Promise<AlertRule[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase.from('alert_rules').select(RULE_SELECT).eq('user_id', userId);
  if (error) throw new AlertRulesError('NETWORK', `getAlertRules failed: ${error.message}`);
  return ((data ?? []) as unknown as RuleRowRaw[]).map((row) => {
    const { userId: _drop, ...rest } = rowToRule(row);
    return rest;
  });
}

export async function setAlertRules(userId: string, variant: string, args: {
  enabled: boolean;
  eventTypes: string[];
  channels: ChannelType[];
  sensitivity?: Sensitivity;
  aiDigestEnabled?: boolean;
  countries?: string[];
  tickers?: string[];
}): Promise<void> {
  const supabase = requireSupabase();
  const existing = await loadExisting(supabase, userId, variant);

  const pair = resolveEffectivePair({ incomingSensitivity: args.sensitivity, existing: existingPair(existing) });
  assertCompatibleDeliveryMode(pair);

  const normalizedCountries = args.countries !== undefined ? normalizeCountries(args.countries) : undefined;
  const normalizedTickers = args.tickers !== undefined ? normalizeTickers(args.tickers) : undefined;

  const patch: Partial<RuleRowRaw> = {
    enabled: args.enabled,
    event_types: args.eventTypes,
    channels: args.channels,
    // Only patch sensitivity when caller explicitly supplied it — never
    // silently narrow an existing digest user with sensitivity:'all'.
    ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
    ...(args.aiDigestEnabled !== undefined ? { ai_digest_enabled: args.aiDigestEnabled } : (existing ? {} : { ai_digest_enabled: true })),
    ...(normalizedCountries !== undefined ? { countries: normalizedCountries } : {}),
    ...(normalizedTickers !== undefined ? { tickers: normalizedTickers } : {}),
  };
  if (!existing) patch.sensitivity = patch.sensitivity ?? pair.sensitivity;
  await upsertRule(supabase, mergedRow(userId, variant, existing, patch));
}

export async function setDigestSettings(userId: string, variant: string, args: {
  digestMode: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
  countries?: string[];
}): Promise<void> {
  const supabase = requireSupabase();
  validateDigestHour(args.digestHour);
  validateTimezone(args.digestTimezone);

  const existing = await loadExisting(supabase, userId, variant);
  const pair = resolveEffectivePair({ incomingDigestMode: args.digestMode, existing: existingPair(existing) });
  assertCompatibleDeliveryMode(pair);

  const normalizedCountries = args.countries !== undefined ? normalizeCountries(args.countries) : undefined;

  const patch: Partial<RuleRowRaw> = {
    digest_mode: args.digestMode,
    digest_hour: args.digestHour ?? null,
    digest_timezone: args.digestTimezone ?? null,
    ...(normalizedCountries !== undefined ? { countries: normalizedCountries } : {}),
  };
  if (!existing) patch.sensitivity = pair.sensitivity;
  await upsertRule(supabase, mergedRow(userId, variant, existing, patch));
}

export async function setQuietHours(userId: string, variant: string, args: {
  quietHoursEnabled: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: QuietHoursOverride;
  countries?: string[];
}): Promise<void> {
  const supabase = requireSupabase();
  validateQuietHours(args);

  const existing = await loadExisting(supabase, userId, variant);

  const effectiveEnabled = args.quietHoursEnabled ?? existing?.quiet_hours_enabled ?? false;
  if (effectiveEnabled) {
    const effectiveStart = args.quietHoursStart ?? existing?.quiet_hours_start ?? undefined;
    const effectiveEnd = args.quietHoursEnd ?? existing?.quiet_hours_end ?? undefined;
    if (effectiveStart !== undefined && effectiveEnd !== undefined && effectiveStart === effectiveEnd) {
      throw new AlertRulesError('INVALID_INPUT', 'quietHoursStart and quietHoursEnd must differ (same value = no quiet window)');
    }
  }

  // No assertCompatibleDeliveryMode here — quiet-hours mutations don't touch
  // the (digestMode, sensitivity) pair. See convex/alertRules.ts::setQuietHours
  // for the full rationale (docs/archive/plans/forbid-realtime-all-events.md).
  const pair = resolveEffectivePair({ existing: existingPair(existing) });

  const normalizedCountries = args.countries !== undefined ? normalizeCountries(args.countries) : undefined;
  const patch: Partial<RuleRowRaw> = {
    quiet_hours_enabled: args.quietHoursEnabled,
    quiet_hours_start: args.quietHoursStart ?? null,
    quiet_hours_end: args.quietHoursEnd ?? null,
    quiet_hours_timezone: args.quietHoursTimezone ?? null,
    quiet_hours_override: args.quietHoursOverride ?? null,
    ...(normalizedCountries !== undefined ? { countries: normalizedCountries } : {}),
  };
  if (!existing) patch.sensitivity = pair.sensitivity;
  await upsertRule(supabase, mergedRow(userId, variant, existing, patch));
}

/**
 * Atomic update of (digestMode, sensitivity) and any subset of the alert-rule/
 * digest-schedule fields — avoids the two-call race between setAlertRules and
 * setDigestSettings against the cross-field validator.
 */
export async function setNotificationConfig(userId: string, variant: string, args: {
  enabled?: boolean;
  eventTypes?: string[];
  sensitivity?: Sensitivity;
  channels?: ChannelType[];
  aiDigestEnabled?: boolean;
  digestMode?: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
  countries?: string[];
  tickers?: string[];
}): Promise<void> {
  const supabase = requireSupabase();
  validateDigestHour(args.digestHour);
  validateTimezone(args.digestTimezone);

  const existing = await loadExisting(supabase, userId, variant);
  const pair = resolveEffectivePair({
    incomingDigestMode: args.digestMode,
    incomingSensitivity: args.sensitivity,
    existing: existingPair(existing),
  });
  assertCompatibleDeliveryMode(pair);

  const normalizedCountries = args.countries !== undefined ? normalizeCountries(args.countries) : undefined;
  const normalizedTickers = args.tickers !== undefined ? normalizeTickers(args.tickers) : undefined;

  const patch: Partial<RuleRowRaw> = {
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    ...(args.eventTypes !== undefined ? { event_types: args.eventTypes } : {}),
    ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
    ...(args.channels !== undefined ? { channels: args.channels } : {}),
    ...(args.aiDigestEnabled !== undefined ? { ai_digest_enabled: args.aiDigestEnabled } : {}),
    ...(args.digestMode !== undefined ? { digest_mode: args.digestMode } : {}),
    ...(args.digestHour !== undefined ? { digest_hour: args.digestHour } : {}),
    ...(args.digestTimezone !== undefined ? { digest_timezone: args.digestTimezone } : {}),
    ...(normalizedCountries !== undefined ? { countries: normalizedCountries } : {}),
    ...(normalizedTickers !== undefined ? { tickers: normalizedTickers } : {}),
  };
  if (!existing) patch.sensitivity = patch.sensitivity ?? pair.sensitivity;
  await upsertRule(supabase, mergedRow(userId, variant, existing, patch));
}

/**
 * `getDigestRules()` — enabled rules with a non-realtime digestMode.
 * Service-role only, no user scoping — called from
 * `scripts/lib/alert-rules-fetch.cjs` (the digest cron), never from an
 * edge function reachable by a browser.
 */
export async function getDigestRules(): Promise<AlertRuleWithUser[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('alert_rules')
    .select(RULE_SELECT)
    .eq('enabled', true)
    .not('digest_mode', 'is', null)
    .neq('digest_mode', 'realtime');
  if (error) throw new AlertRulesError('NETWORK', `getDigestRules failed: ${error.message}`);
  return ((data ?? []) as unknown as RuleRowRaw[]).map(rowToRule);
}

/**
 * `getByEnabled(enabled)` — INTERNAL ONLY (GHSA-r649-4cqj-w93h): scans across
 * every user with no per-caller scope. Service-role only, called from
 * `scripts/lib/alert-rules-fetch.cjs` (the real-time relay's poll loop +
 * quiet-hours batch drain), never exposed to a browser-reachable endpoint.
 */
export async function getByEnabled(enabled: boolean): Promise<AlertRuleWithUser[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase.from('alert_rules').select(RULE_SELECT).eq('enabled', enabled);
  if (error) throw new AlertRulesError('NETWORK', `getByEnabled failed: ${error.message}`);
  return ((data ?? []) as unknown as RuleRowRaw[]).map(rowToRule);
}
