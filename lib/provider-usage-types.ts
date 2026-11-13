export type ProviderUsageWindowId = "5h" | "7d" | "monthly";

export interface ProviderUsageWindow {
  percent: number;
  resetMinutes?: number;
  resetHours?: number;
}

export interface ProviderCreditBalance {
  remaining: number;
  limit: number;
  limitSource: "reported" | "fallback";
  percent: number;
}

/** Providers whose saved rate-limit resets omp can spend (`omp usage reset`). */
export const RESET_PROVIDERS = ["openai-codex", "anthropic"] as const;

export const PROVIDER_RESET_CREDIT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export interface ProviderResetCredit {
  /** omp's credit status: available, redeemed, expired, paused, unavailable. */
  /** Provider grant/credit identifier when omp supports selecting a specific card. */
  id?: string;
  status?: string;
  title?: string;
  /** Normalized quota window ids cleared by this reset (e.g. `anthropic:5h`, `anthropic:7d`). */
  clears?: string[];
  /** Remaining uses on this grant when omp reports it (0 = spent). */
  remainingCount?: number;
  /** Whether omp selects this grant as usable right now. */
  usable?: boolean;
  grantedAt?: number;
  expiresAt?: number;
}

/** Saved rate-limit resets of one account, from the usage report's `resetCredits`. */
export interface ProviderResets {
  /** Unexpired saved resets. */
  available: number;
  /** Whether one can be spent right now (Claude's only work at the limit). */
  spendable: boolean;
  /** omp's reason when none can be spent now, e.g. `not_at_wall`, `cooldown`. */
  /** Default credit id omp would spend when none is explicitly chosen. */
  nextCreditId?: string;
  reason?: string;
  cooldownUntil?: number;
  credits: ProviderResetCredit[];
}

/** Format of `ProviderUsageReport.accountKey`. */
export const PROVIDER_ACCOUNT_KEY_RE = /^[a-f0-9]{16}$/;
export const PROVIDER_ACCOUNT_ALIAS_MAX_LENGTH = 40;

export interface ProviderUsageReport {
  provider: string;
  /** Opaque, stable per-account id (hash of the account identity); keys user aliases. */
  accountKey: string;
  /** Current global routing denial, attached by the usage API after cache lookup. */
  disabled?: boolean;
  /** Redacted account identifier (shortest unique prefix + "*"). */
  accountLabel?: string;
  accountIndex?: number;
  /** User-assigned name for the account, if any. */
  accountAlias?: string;
  plan?: string;
  modelId?: string;
  tier?: string;
  /** Name of an independent quota pool when a provider meters several on the same windows. */
  pool?: string;
  noLimits?: boolean;
  /** True when omp listed the login under `accountsWithoutUsage` (quota fetch failed or unavailable). */
  noUsageData?: boolean;
  credits?: ProviderCreditBalance;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
  resets?: ProviderResets;
}

export interface ProviderUsageSnapshot {
  generatedAt: number | null;
  reports: ProviderUsageReport[];
}

export interface ProviderUsageContext {
  provider: string;
  modelId: string;
}
