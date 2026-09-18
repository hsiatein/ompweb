import { useState, useEffect } from "react";
import type { ProviderUsageReport, ProviderUsageSnapshot } from "@/lib/provider-usage-types";

export function formatUsageReset(value: number, unit: "minutes" | "hours"): string {
  if (unit === "minutes") {
    if (value < 60) return `${value}m`;
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (value < 24) return `${value}h`;
  const days = Math.floor(value / 24);
  const hours = value % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function usageTone(percent: number): string {
  if (percent >= 80) return "var(--status-error)";
  if (percent >= 50) return "var(--status-warning)";
  return "var(--text-muted)";
}

export function formatProviderUsageReport(report: ProviderUsageReport, noLimitsLabel: string): string {
  if (report.noLimits) return noLimitsLabel;
  const parts: string[] = [];
  if (report.tier) parts.push(report.tier);
  if (report.credits) {
    const { remaining, limit, limitSource } = report.credits;
    parts.push(`${remaining}/${limit} credits remaining${limitSource === "fallback" ? " (estimated limit)" : ""}`);
  }
  if (report.fiveHour) {
    const reset = report.fiveHour.resetMinutes === undefined
      ? ""
      : ` (${formatUsageReset(report.fiveHour.resetMinutes, "minutes")})`;
    parts.push(`5h ${Math.round(report.fiveHour.percent)}%${reset}`);
  }
  if (report.sevenDay) {
    const reset = report.sevenDay.resetHours === undefined
      ? ""
      : ` (${formatUsageReset(report.sevenDay.resetHours, "hours")})`;
    parts.push(`7d ${Math.round(report.sevenDay.percent)}%${reset}`);
  }
  if (report.monthly) {
    const reset = report.monthly.resetHours === undefined
      ? ""
      : ` (${formatUsageReset(report.monthly.resetHours, "hours")})`;
    parts.push(`mo ${Math.floor(report.monthly.percent)}%${reset}`);
  }
  return parts.join(" · ");
}

export type ProviderUsageState = {
  snapshot: ProviderUsageSnapshot | null;
  loading: boolean;
  error: boolean;
};

export function useProviderUsage(query: string | null, refreshMs?: number): ProviderUsageState {
  const [state, setState] = useState<ProviderUsageState>({ snapshot: null, loading: false, error: false });
  useEffect(() => {
    if (query === null) {
      setState({ snapshot: null, loading: false, error: false });
      return;
    }
    const controller = new AbortController();
    setState({ snapshot: null, loading: true, error: false });
    const load = async () => {
      try {
        const response = await fetch(`/api/provider-usage${query ? `?${query}` : ""}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = await response.json() as ProviderUsageSnapshot;
        if (!controller.signal.aborted) setState({ snapshot, loading: false, error: false });
      } catch {
        if (!controller.signal.aborted) setState({ snapshot: null, loading: false, error: true });
      }
    };
    void load();
    const interval = refreshMs ? window.setInterval(() => void load(), refreshMs) : undefined;
    return () => {
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [query, refreshMs]);
  return state;
}
