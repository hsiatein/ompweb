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

export interface ProviderUsageReport {
  provider: string;
  accountLabel?: string;
  accountIndex?: number;
  plan?: string;
  modelId?: string;
  tier?: string;
  noLimits?: boolean;
  credits?: ProviderCreditBalance;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
}

export interface ProviderUsageSnapshot {
  generatedAt: number | null;
  reports: ProviderUsageReport[];
}

export interface ProviderUsageContext {
  provider: string;
  modelId: string;
}
