export type UsageTimeRange = "today" | "7d" | "30d" | "90d" | "month" | "all";
export type UsageGranularity = "daily" | "monthly" | "projects";
export type UsageMetricView = "cost" | "tokens";
export type UsageBreakdownView = "model" | "day" | "project";
export type CostQualityTier = "provider_reported" | "model_priced" | "unpriced";

export interface ModelRates {
  input: number;      // USD per million tokens
  output: number;     // USD per million tokens
  cacheRead: number;  // USD per million tokens
  cacheWrite: number; // USD per million tokens
}

export interface UsageRecord {
  timestamp: number;
  sessionId: string;
  sessionCwd: string;
  provider: string;
  model: string;
  input: number;        // uncached input tokens
  output: number;       // output tokens
  reasoning: number;    // reasoning / thought tokens
  cacheRead: number;    // prompt cache read tokens
  cacheWrite: number;   // prompt cache write tokens
  totalTokens: number;
  cost: number;         // USD
  cacheSavings: number; // USD
  costQuality: CostQualityTier;
  /** omp's request duration (ms) when it recorded one and the request produced output; drives speed stats. */
  durationMs: number | null;
  /** Time to first token (ms) when omp recorded it. */
  ttftMs: number | null;
}

export interface UsageSummary {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheSavings: number;
  activeDays: number;
  tokensPerActiveDay: number;
  cachePercentage: number;
  costQuality: {
    providerReported: number; // percentage 0-100
    modelPriced: number;      // percentage 0-100
    unpriced: number;         // percentage 0-100
  };
}

export interface ProviderUsageSummary {
  provider: string;
  name: string;
  cost: number;
  tokens: number;
  share: number; // 0-100 percentage of total cost (or total tokens if total cost is 0)
  color: string;
}

export interface ModelUsageSummary {
  model: string;
  provider: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  share: number; // 0-100 percentage
  recordsCount: number;
  /** Requests with a recorded duration (the speed figures below are null without any). */
  speedSamples: number;
  /** Mean of per-request output t/s (output tokens / request duration), like the top-bar speed chart. */
  meanTps: number | null;
  /** Total output tokens / total request time: long answers weigh more. */
  tokenWeightedTps: number | null;
  /** Mean t/s after the first token arrived (requests with a recorded TTFT). */
  meanDecodeTps: number | null;
  /** Mean time to first token (ms). */
  meanTtftMs: number | null;
}

export interface TimeSeriesPoint {
  date: string; // ISO format: "YYYY-MM-DD" or "YYYY-MM"
  label: string; // e.g. "Aug 3", "Sep 1", "2026-08"
  timestamp: number;
  totalCost: number;
  totalTokens: number;
  byProvider: Record<string, { cost: number; tokens: number }>;
}

export interface DayUsageSummary {
  date: string; // "YYYY-MM-DD"
  label: string; // e.g. "Aug 3, 2026"
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  share: number; // 0-100 percentage
}

export interface ProjectUsageSummary {
  project: string; // directory path
  projectName: string; // display folder name
  cost: number;
  tokens: number;
  share: number; // 0-100 percentage
  sessionsCount: number;
}

export interface UsageReportScanInfo {
  transcriptsScanned: number;
  transcriptsOutsideWindow: number;
  usageRecordsCount: number;
  durationSeconds: number;
  scannedAt: number;
}

export interface UsageReport {
  timeRange: UsageTimeRange;
  granularity: UsageGranularity;
  summary: UsageSummary;
  providers: ProviderUsageSummary[];
  timeSeries: TimeSeriesPoint[];
  modelBreakdown: ModelUsageSummary[];
  dayBreakdown: DayUsageSummary[];
  projectBreakdown: ProjectUsageSummary[];
  scanInfo: UsageReportScanInfo;
}

export interface UsageQueryOptions {
  range?: UsageTimeRange;
  granularity?: UsageGranularity;
  project?: string;
  from?: number;
  to?: number;
  forceRefresh?: boolean;
}
