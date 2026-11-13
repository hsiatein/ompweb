import { execFile } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import { stripAnsi } from "./ansi";
import { resolveOmpBin } from "./omp/omp-cli";
import { asNumber, isRecord } from "./type-guards";
import {
  PROVIDER_RESET_CREDIT_ID_RE,
  RESET_PROVIDERS,
  type ProviderCreditBalance,
  type ProviderResetCredit,
  type ProviderResets,
  type ProviderUsageReport,
  type ProviderUsageSnapshot,
  type ProviderUsageWindowId,
} from "./provider-usage-types";
import { accountProxyEnvironment } from "./account-proxy";

const execFileAsync = promisify(execFile);
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 4 * 1024 * 1024;
const USAGE_CACHE_TTL_MS = 60_000;
// omp lists Codex resets with a 10 s timeout and confirms a spend within 15 s.
const RESET_TIMEOUT_MS = 60_000;
const HYPER_FALLBACK_CREDIT_LIMIT = 250;

type UsageQuery = { provider?: string; modelId?: string };

/** Per-account report fields, resolved across the whole snapshot. */
type UsageAccount = Pick<ProviderUsageReport, "accountKey" | "accountLabel" | "accountIndex" | "accountAlias">;

type CachedUsage = { expiresAt: number; output: string };

let usageCache: CachedUsage | undefined;
let usageInFlight: Promise<string> | undefined;
/** Bumped when a spent reset makes fetched snapshots stale. */
let usageGeneration = 0;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeWindowId(scope: Record<string, unknown>, window: Record<string, unknown>): ProviderUsageWindowId | undefined {
  const windowId = nonEmptyString(scope.windowId);
  if (windowId === "5h" || windowId === "7d" || windowId === "monthly" || windowId === "30d" || windowId === "daily") {
    if (windowId === "30d") return "monthly";
    if (windowId === "daily") return "5h";
    return windowId;
  }
  const durationMs = asNumber(window.durationMs);
  if (durationMs === undefined) return undefined;
  if (Math.abs(durationMs - 5 * 60 * 60 * 1000) <= 60_000) return "5h";
  if (Math.abs(durationMs - 7 * 24 * 60 * 60 * 1000) <= 60_000) return "7d";
  if (Math.abs(durationMs - 30 * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000) return "monthly";
  if (Math.abs(durationMs - 24 * 60 * 60 * 1000) <= 60_000) return "5h";
  return undefined;
}

function usageWindow(
  windowId: ProviderUsageWindowId,
  fraction: number,
  window: Record<string, unknown>,
  now: number,
): ProviderUsageReport["fiveHour"] {
  const resetAt = asNumber(window.resetsAt);
  if (windowId === "5h") {
    return {
      percent: fraction * 100,
      ...(resetAt !== undefined ? { resetMinutes: Math.max(0, Math.round((resetAt - now) / 60_000)) } : {}),
    };
  }
  return {
    percent: fraction * 100,
    ...(resetAt !== undefined ? { resetHours: Math.max(0, Math.round((resetAt - now) / 3_600_000)) } : {}),
  };
}

function accountLabel(metadata: Record<string, unknown> | undefined): string | undefined {
  return nonEmptyString(metadata?.email) ?? nonEmptyString(metadata?.accountId);
}

// Stable across redaction lengths, report order and other logins, so a
// user-assigned alias keeps following the same credential. Accounts that omp
// reports without any identity fall back to their position within the provider.
function accountIdentity(provider: string, metadata: Record<string, unknown> | undefined, providerOrdinal: number): string {
  const accountId = nonEmptyString(metadata?.accountId);
  const email = nonEmptyString(metadata?.email);
  if (accountId || email) return `${provider}\0account\0${accountId ?? ""}\0${email ?? ""}`;
  const projectId = nonEmptyString(metadata?.projectId);
  if (projectId) return `${provider}\0project\0${projectId}`;
  return `${provider}\0ordinal\0${providerOrdinal}`;
}

/** Opaque per-account id sent to the browser in place of the raw identity. */
export function providerAccountKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

const REDACT_MIN_PREFIX = 2;

// Shortest prefix (at least two characters) that no other distinct identifier
// in the snapshot shares, so labels stay distinguishable without exposing them.
function redactIdentifiers(values: string[]): Map<string, string> {
  const distinct = [...new Set(values)];
  const redacted = new Map<string, string>();
  for (const value of distinct) {
    let length = Math.min(REDACT_MIN_PREFIX, value.length);
    while (length < value.length && distinct.some((other) => other !== value && other.startsWith(value.slice(0, length)))) length++;
    redacted.set(value, `${value.slice(0, length)}*`);
  }
  return redacted;
}

function hyperCreditBalance(provider: string, limits: unknown[]): ProviderCreditBalance | undefined {
  if (provider !== "charm-hyper") return undefined;
  for (const limit of limits) {
    if (!isRecord(limit) || !isRecord(limit.scope) || !isRecord(limit.amount)) continue;
    if (limit.scope.windowId !== "balance" || limit.amount.unit !== "credits") continue;
    const remaining = asNumber(limit.amount.remaining);
    if (remaining === undefined) continue;
    const reportedLimit = asNumber(limit.amount.limit);
    const hasLimit = reportedLimit !== undefined && reportedLimit > 0;
    const total = hasLimit ? reportedLimit : HYPER_FALLBACK_CREDIT_LIMIT;
    // Hyper currently exposes balance only, not a plan or reset window. The
    // fallback is a display reference, not evidence of subscription or spend.
    return {
      remaining,
      limit: total,
      limitSource: hasLimit ? "reported" : "fallback",
      percent: Math.max(0, Math.min(100, (1 - remaining / total) * 100)),
    };
  }
  return undefined;
}

function isoTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// omp's `resetCredits`: Codex reports a count plus dated credits; Claude adds
// whether one is redeemable now (its resets only apply at the limit).
function resetSummary(provider: string, raw: unknown, now: number): ProviderResets | undefined {
  if (!(RESET_PROVIDERS as readonly string[]).includes(provider) || !isRecord(raw)) return undefined;
  const available = Math.max(0, Math.trunc(asNumber(raw.availableCount) ?? 0));
  const redeemable = asNumber(raw.redeemableCount);
  const cooldownUntil = isoTime(raw.cooldownUntil);
  const reason = nonEmptyString(raw.reason);
  const rawNextCreditId = nonEmptyString(raw.nextCreditId);
  const nextCreditId = rawNextCreditId && PROVIDER_RESET_CREDIT_ID_RE.test(rawNextCreditId) ? rawNextCreditId : undefined;
  const credits: ProviderResetCredit[] = (Array.isArray(raw.credits) ? raw.credits : []).filter(isRecord).map((credit) => {
    const rawId = nonEmptyString(credit.id);
    const id = rawId && PROVIDER_RESET_CREDIT_ID_RE.test(rawId) ? rawId : undefined;
    const status = nonEmptyString(credit.status);
    const title = nonEmptyString(credit.title);
    const clears = Array.isArray(credit.clears)
      ? credit.clears.map(nonEmptyString).filter((entry): entry is string => entry !== undefined)
      : [];
    const remainingCount = typeof credit.remainingCount === "number" && Number.isSafeInteger(credit.remainingCount) && credit.remainingCount >= 0
      ? credit.remainingCount
      : undefined;
    const usable = typeof credit.usable === "boolean" ? credit.usable : undefined;
    const grantedAt = isoTime(credit.grantedAt);
    const expiresAt = isoTime(credit.expiresAt);
    return {
      ...(id ? { id } : {}),
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(clears.length > 0 ? { clears } : {}),
      ...(remainingCount !== undefined ? { remainingCount } : {}),
      ...(usable !== undefined ? { usable } : {}),
      ...(grantedAt !== undefined ? { grantedAt } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  });
  const coolingDown = cooldownUntil !== undefined && cooldownUntil > now;
  return {
    available,
    spendable: available > 0 && (redeemable === undefined || redeemable > 0) && !coolingDown,
    ...(nextCreditId ? { nextCreditId } : {}),
    ...(reason ? { reason } : coolingDown ? { reason: "cooldown" } : {}),
    ...(coolingDown ? { cooldownUntil } : {}),
    credits,
  };
}

type UsageLimit = { id: ProviderUsageWindowId; fraction: number; window: Record<string, unknown> };

type UsageGroup = {
  priority: number;
  modelId?: string;
  tier?: string;
  pool?: string;
  limits: Map<ProviderUsageWindowId, UsageLimit>;
};

// A provider can meter independent quota pools on the same window (Antigravity
// has separate Gemini and "Claude & GPT" 5h/weekly budgets). Those only differ
// by label, so labels split groups only when one window carries several of them;
// otherwise labels just name the window ("Claude 5 Hour") and must not split.
function labelsSplitPools(limits: unknown[]): boolean {
  const labelsByWindow = new Map<string, Set<string>>();
  for (const rawLimit of limits) {
    if (!isRecord(rawLimit) || !isRecord(rawLimit.scope)) continue;
    const label = nonEmptyString(rawLimit.label);
    const windowId = normalizeWindowId(rawLimit.scope, isRecord(rawLimit.window) ? rawLimit.window : {});
    if (!label || !windowId) continue;
    const key = `${nonEmptyString(rawLimit.scope.modelId)?.toLowerCase() ?? ""}\0${nonEmptyString(rawLimit.scope.tier)?.toLowerCase() ?? ""}\0${windowId}`;
    const labels = labelsByWindow.get(key) ?? new Set<string>();
    labels.add(label);
    if (labels.size > 1) return true;
    labelsByWindow.set(key, labels);
  }
  return false;
}

function normalizeReport(
  rawReport: Record<string, unknown>,
  query: UsageQuery,
  now: number,
  account: UsageAccount,
): ProviderUsageReport[] {
  const provider = nonEmptyString(rawReport.provider);
  if (!provider || (query.provider && provider !== query.provider)) return [];
  const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
  const activeModelId = query.modelId?.toLowerCase();
  const splitPools = labelsSplitPools(limits);
  const groups = new Map<string, UsageGroup>();

  for (const rawLimit of limits) {
    if (!isRecord(rawLimit) || !isRecord(rawLimit.scope) || !isRecord(rawLimit.amount)) continue;
    const scope = rawLimit.scope;
    const amount = rawLimit.amount;
    const fraction = asNumber(amount.usedFraction);
    if (fraction === undefined) continue;
    const window = isRecord(rawLimit.window) ? rawLimit.window : {};
    const windowId = normalizeWindowId(scope, window);
    if (!windowId) continue;
    const modelId = nonEmptyString(scope.modelId);
    if (activeModelId && modelId && modelId.toLowerCase() !== activeModelId) continue;
    const tier = nonEmptyString(scope.tier);
    const normalizedModelId = modelId?.toLowerCase();
    const normalizedTier = tier?.toLowerCase();
    const pool = splitPools ? nonEmptyString(rawLimit.label) : undefined;
    const groupKey = `${normalizedModelId ?? ""}\0${normalizedTier ?? ""}\0${pool ?? ""}`;
    const priority = modelId ? (normalizedTier ? 0 : 1) : normalizedTier ? 2 : 3;
    let group = groups.get(groupKey);
    if (!group) {
      group = { priority, modelId, tier, pool, limits: new Map() };
      groups.set(groupKey, group);
    }
    const candidate = { id: windowId, fraction, window };
    const current = group.limits.get(windowId);
    if (!current || fraction > current.fraction) group.limits.set(windowId, candidate);
  }

  let selectedGroups = [...groups.values()];
  if (activeModelId && selectedGroups.length > 0) {
    const bestPriority = Math.min(...selectedGroups.map((group) => group.priority));
    // Parallel pools are all relevant to the active model; otherwise keep the single most specific group.
    selectedGroups = splitPools
      ? selectedGroups.filter((group) => group.priority === bestPriority)
      : [selectedGroups.find((group) => group.priority === bestPriority)!];
  }
  const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
  const plan = nonEmptyString(metadata?.planType);
  const credits = hyperCreditBalance(provider, limits);
  const resets = resetSummary(provider, rawReport.resetCredits, now);
  if (selectedGroups.length === 0) {
    const noUsageData = rawReport.noUsageData === true;
    return [{
      provider,
      ...account,
      ...(plan ? { plan } : {}),
      ...(credits ? { credits } : { noLimits: true, ...(noUsageData ? { noUsageData: true } : {}) }),
      ...(resets ? { resets } : {}),
    }];
  }
  return selectedGroups.flatMap((group) => {
    const result: ProviderUsageReport = {
      provider,
      ...account,
      ...(plan ? { plan } : {}),
      ...(group.modelId ? { modelId: group.modelId } : {}),
      ...(group.tier ? { tier: group.tier } : {}),
      ...(group.pool ? { pool: group.pool } : {}),
      ...(credits ? { credits } : {}),
      ...(resets ? { resets } : {}),
    };
    for (const candidate of group.limits.values()) {
      const normalized = usageWindow(candidate.id, candidate.fraction, candidate.window, now);
      if (candidate.id === "5h" && !result.fiveHour) result.fiveHour = normalized;
      if (candidate.id === "7d" && !result.sevenDay) result.sevenDay = normalized;
      if (candidate.id === "monthly" && !result.monthly) result.monthly = normalized;
    }
    return result.fiveHour || result.sevenDay || result.monthly ? [result] : [];
  });
}

type ReportIdentity = { provider: string; key: string; rawLabel?: string; metadata?: Record<string, unknown> };

function mergeUnreportedAccounts(rawReports: unknown[], unreported: unknown[]): unknown[] {
  if (unreported.length === 0) return rawReports;
  const providerOrdinals = new Map<string, number>();
  const seenKeys = new Set<string>();
  for (const report of rawReports) {
    if (!isRecord(report)) continue;
    const provider = nonEmptyString(report.provider) ?? "";
    const metadata = isRecord(report.metadata) ? report.metadata : undefined;
    const ordinal = providerOrdinals.get(provider) ?? 0;
    providerOrdinals.set(provider, ordinal + 1);
    seenKeys.add(providerAccountKey(accountIdentity(provider, metadata, ordinal)));
  }
  const merged = [...rawReports];
  for (const entry of unreported) {
    if (!isRecord(entry)) continue;
    const provider = nonEmptyString(entry.provider);
    if (!provider) continue;
    const metadata: Record<string, string> = {};
    for (const field of ["accountId", "email", "orgId", "projectId", "orgName"] as const) {
      const value = nonEmptyString(entry[field]);
      if (value) metadata[field] = value;
    }
    const ordinal = providerOrdinals.get(provider) ?? 0;
    const key = providerAccountKey(accountIdentity(provider, metadata, ordinal));
    if (seenKeys.has(key)) continue;
    providerOrdinals.set(provider, ordinal + 1);
    seenKeys.add(key);
    merged.push({
      provider,
      limits: [],
      noUsageData: true,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }
  return merged;
}

function parseUsagePayload(output: string): { generatedAt: unknown; reports: unknown[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");
  const rawReports = Array.isArray(payload.reports) ? payload.reports : [];
  const unreported = Array.isArray(payload.accountsWithoutUsage) ? payload.accountsWithoutUsage : [];
  return { generatedAt: payload.generatedAt, reports: mergeUnreportedAccounts(rawReports, unreported) };
}

// Resolved over every report before query filtering, so keys and redacted
// labels do not change with the provider/model being viewed.
function reportIdentities(rawReports: unknown[]): Array<ReportIdentity | undefined> {
  const providerOrdinals = new Map<string, number>();
  return rawReports.map((report) => {
    if (!isRecord(report)) return undefined;
    const provider = nonEmptyString(report.provider) ?? "";
    const metadata = isRecord(report.metadata) ? report.metadata : undefined;
    const ordinal = providerOrdinals.get(provider) ?? 0;
    providerOrdinals.set(provider, ordinal + 1);
    return { provider, key: providerAccountKey(accountIdentity(provider, metadata, ordinal)), rawLabel: accountLabel(metadata), metadata };
  });
}

export function parseProviderUsageOutput(
  output: string,
  query: UsageQuery = {},
  now = Date.now(),
  aliases: Readonly<Record<string, string>> = {},
): ProviderUsageSnapshot {
  const payload = parseUsagePayload(output);
  const rawReports = payload.reports;
  const identities = reportIdentities(rawReports);
  const redacted = redactIdentifiers(identities.flatMap((identity) => identity?.rawLabel ? [identity.rawLabel] : []));
  const reports = rawReports.flatMap((report, index) => {
    const identity = identities[index];
    if (!isRecord(report) || !identity) return [];
    const alias = nonEmptyString(aliases[identity.key]);
    const account: UsageAccount = {
      accountKey: identity.key,
      ...(identity.rawLabel ? { accountLabel: redacted.get(identity.rawLabel) } : { accountIndex: index + 1 }),
      ...(alias ? { accountAlias: alias } : {}),
    };
    return normalizeReport(report, query, now, account);
  });
  const generatedAt = asNumber(payload.generatedAt) ?? null;
  return { generatedAt, reports };
}

async function fetchProviderUsage(): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  // Unredacted so account keys stay stable; parseProviderUsageOutput redacts
  // labels itself and only opaque keys leave the server.
  const { stdout } = await execFileAsync(bin, ["usage", "--json"], {
    timeout: USAGE_TIMEOUT_MS,
    maxBuffer: USAGE_MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, ...accountProxyEnvironment() },
  });
  return stdout;
}

function getUsageOutput(): Promise<string> {
  if (usageCache && usageCache.expiresAt > Date.now()) return Promise.resolve(usageCache.output);
  if (usageInFlight) return usageInFlight;
  const generation = usageGeneration;
  usageInFlight = fetchProviderUsage()
    .then((output) => {
      // A reset spent meanwhile makes this snapshot stale: return it, don't keep it.
      if (generation === usageGeneration) usageCache = { output, expiresAt: Date.now() + USAGE_CACHE_TTL_MS };
      return output;
    })
    .finally(() => { if (generation === usageGeneration) usageInFlight = undefined; });
  return usageInFlight;
}

export async function getProviderUsage(query: UsageQuery = {}, aliases: Readonly<Record<string, string>> = {}): Promise<ProviderUsageSnapshot> {
  return parseProviderUsageOutput(await getUsageOutput(), query, Date.now(), aliases);
}

/** Drop the cached snapshot (and any fetch in flight): accounts or quotas just changed. */
export function invalidateProviderUsage(): void {
  usageGeneration += 1;
  usageCache = undefined;
  usageInFlight = undefined;
}

/** Raw OAuth identity fields as omp's `auth.accountPolicies[].account` matches them. Server-only. */
export interface ProviderAccountIdentity {
  accountId?: string;
  email?: string;
  orgId?: string;
  projectId?: string;
}

export interface ProviderAccount {
  provider: string;
  accountKey: string;
  identity: ProviderAccountIdentity;
}

/** One entry per distinct identified account (pools of one account collapse). */
export function parseProviderAccounts(output: string): ProviderAccount[] {
  const accounts = new Map<string, ProviderAccount>();
  const ambiguous = new Set<string>();
  for (const identity of reportIdentities(parseUsagePayload(output).reports)) {
    if (!identity?.provider || ambiguous.has(identity.key)) continue;
    const existing = accounts.get(identity.key);
    const fields: ProviderAccountIdentity = { ...existing?.identity };
    for (const field of ["accountId", "email", "orgId", "projectId"] as const) {
      const value = nonEmptyString(identity.metadata?.[field]);
      if (value && fields[field] && fields[field] !== value) {
        ambiguous.add(identity.key);
        accounts.delete(identity.key);
        break;
      }
      if (value) fields[field] = value;
    }
    if (ambiguous.has(identity.key)) continue;
    // Ordinal-keyed reports carry nothing omp could match an account by.
    if (!fields.accountId && !fields.email && !fields.projectId) continue;
    accounts.set(identity.key, { provider: identity.provider, accountKey: identity.key, identity: fields });
  }
  return [...accounts.values()];
}

export async function getProviderAccounts(): Promise<ProviderAccount[]> {
  return parseProviderAccounts(await getUsageOutput());
}

/**
 * Inventory stays available even when the account's quota endpoint needs a proxy.
 * Settings-only: `accountName` is the full email/account id so accounts can be
 * told apart there (the usage snapshot shown everywhere else stays redacted).
 */
export async function getProviderProxyAccounts(provider: string, aliases: Readonly<Record<string, string>> = {}) {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("account_proxy_runtime_required");
  const { stdout } = await execFileAsync(bin, ["usage", "accounts", "--json", "--provider", provider], {
    timeout: USAGE_TIMEOUT_MS, maxBuffer: USAGE_MAX_BUFFER, windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...accountProxyEnvironment() },
  });
  const payload: unknown = JSON.parse(stdout);
  if (!isRecord(payload) || payload.accountProxyVersion !== 1 || !Array.isArray(payload.proxyAccounts)) throw new Error("account_proxy_runtime_required");
  const accounts = payload.proxyAccounts.map((row: unknown) => {
    if (!isRecord(row) || row.provider !== provider || typeof row.key !== "string" || !/^[a-f0-9]{64}$/.test(row.key) ||
      !Number.isSafeInteger(row.index) || (row.index as number) < 0 || !isRecord(row.metadata)) throw new Error("Invalid account inventory");
    const metadata = row.metadata;
    const accountKey = providerAccountKey(accountIdentity(provider, metadata, (row.index as number) + 1));
    const accountName = nonEmptyString(metadata.email) ?? nonEmptyString(metadata.accountId) ?? nonEmptyString(metadata.projectId);
    return { provider, key: row.key, accountKey, accountName, accountAlias: nonEmptyString(aliases[accountKey]) };
  });
  return [...new Map(accounts.map(account => [account.key, account])).values()];
}

/** Credential id `omp usage reset` addresses the account by, from its `--json` listing. */
export function parseResetCredentialId(output: string, provider: string, accountKey: string): number | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage reset returned invalid JSON");
  }
  const accounts = isRecord(payload) && Array.isArray(payload.accounts) ? payload.accounts : [];
  for (const account of accounts) {
    if (!isRecord(account) || account.provider !== provider || !Number.isInteger(account.credentialId)) continue;
    // Same identity the usage report keys the account by (account id and email).
    if (!nonEmptyString(account.accountId) && !nonEmptyString(account.email)) continue;
    if (providerAccountKey(accountIdentity(provider, account, 0)) === accountKey) return account.credentialId as number;
  }
  return undefined;
}

export class ProviderResetError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export interface ProviderResetOutcome {
  ok: boolean;
  /** omp's own sentence, with account labels redacted. */
  message: string;
}

/**
 * Spend one saved rate-limit reset on an account through `omp usage reset`,
 * which fences the spend against other omp processes and confirms it with the
 * provider. Outcomes omp reports (applied, nothing to reset, already spent
 * elsewhere, ...) come back as `{ ok, message }`; only a missing account or a
 * failed omp call throws.
 */
export async function spendProviderReset(accountKey: string, creditId?: string): Promise<ProviderResetOutcome> {
  if (creditId !== undefined && !PROVIDER_RESET_CREDIT_ID_RE.test(creditId)) {
    throw new ProviderResetError("Invalid reset credit id", "invalid_credit_id", 400);
  }
  const bin = resolveOmpBin();
  if (!bin) throw new ProviderResetError("omp binary not found", "omp_unavailable", 503);
  const account = (await getProviderAccounts()).find((candidate) => candidate.accountKey === accountKey);
  if (!account || !(RESET_PROVIDERS as readonly string[]).includes(account.provider)) {
    throw new ProviderResetError("No account with saved resets matches this key", "unknown_account", 404);
  }
  const options = { timeout: RESET_TIMEOUT_MS, maxBuffer: USAGE_MAX_BUFFER, windowsHide: true, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...accountProxyEnvironment() } };
  const listing = await execFileAsync(bin, ["usage", "reset", "--json", "--provider", account.provider], options);
  const credentialId = parseResetCredentialId(listing.stdout, account.provider, accountKey);
  if (credentialId === undefined) throw new ProviderResetError("omp lists no stored login for this account", "unknown_account", 404);

  const target = creditId ? `${account.provider}/${credentialId}/${creditId}` : `${account.provider}/${credentialId}`;
  let outcome: ProviderResetOutcome;
  try {
    const { stdout } = await execFileAsync(bin, ["usage", "reset", target, "--redact"], options);
    outcome = { ok: true, message: stripAnsi(stdout).trim() };
  } catch (error) {
    // omp reports a refused or unconfirmed spend on stderr with exit code 1.
    const stderr = isRecord(error) && typeof error.stderr === "string" ? stripAnsi(error.stderr).trim() : "";
    if (!stderr) throw error;
    outcome = { ok: false, message: stderr };
  }
  // `omp usage reset` already ran per-credential `invalidateAfterReset` in omp's
  // store (preserving peer accounts' cached resetCredits); only drop our snapshot.
  invalidateProviderUsage();
  return outcome;
}
