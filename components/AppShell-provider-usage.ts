import { useState, useEffect, useRef, useCallback } from "react";
import type { ProviderResetCredit, ProviderResets, ProviderUsageReport, ProviderUsageSnapshot } from "@/lib/provider-usage-types";
import { ACCOUNT_ROUTING_CHANGED_EVENT } from "@/lib/account-choices";

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

/**
 * Short name for a usage row's source. Providers that meter parallel pools
 * (Antigravity: Gemini vs the shared Claude & GPT budget) get one name per
 * pool, so the row label stays free for the account alias.
 */
export function usageSourceName(report: Pick<ProviderUsageReport, "provider" | "pool">): string {
  if (!report.pool) return report.provider;
  if (report.provider === "google-antigravity") {
    if (/^gemini\b/i.test(report.pool)) return "antigravity-gemini";
    if (/\bshared\b|claude|gpt/i.test(report.pool)) return "antigravity-shared";
  }
  return `${report.provider}·${report.pool}`;
}

export function usageTone(percent: number): string {
  if (percent >= 80) return "var(--status-error)";
  if (percent >= 50) return "var(--status-warning)";
  return "var(--text-muted)";
}

export type ResetCreditScope = "full" | "5h" | "5h_fable" | "5h_opus" | "5h_sonnet" | "5h_overage" | "7d";

export const RESET_SCOPE_I18N_KEYS: Record<ResetCreditScope, string> = {
  full: "providerUsage.resetScopeFull",
  "5h": "providerUsage.resetScope5h",
  "5h_fable": "providerUsage.resetScope5hFable",
  "5h_opus": "providerUsage.resetScope5hOpus",
  "5h_sonnet": "providerUsage.resetScope5hSonnet",
  "5h_overage": "providerUsage.resetScope5hOverage",
  "7d": "providerUsage.resetScope7d",
};

export function classifyResetCreditScope(credit: Pick<ProviderResetCredit, "clears" | "title">): ResetCreditScope | undefined {
  const clears = credit.clears ?? [];
  if (clears.length === 0) return undefined;
  const has5h = clears.includes("anthropic:5h");
  const has7d = clears.includes("anthropic:7d");
  if (has5h && has7d) return "full";
  if (has5h) {
    if (clears.includes("anthropic:7d:opus")) return "5h_opus";
    if (clears.includes("anthropic:7d:sonnet")) return "5h_sonnet";
    if (clears.some((id) => id.startsWith("anthropic:reset:seven_day"))) {
      return /\bfable\b/i.test(credit.title ?? "") ? "5h_fable" : "5h_overage";
    }
    return "5h";
  }
  if (has7d) return "7d";
  return undefined;
}

export interface BankedResetCredit extends ProviderResetCredit {
  scope?: ResetCreditScope;
  canSpend: boolean;
  nextToSpend: boolean;
  queued: boolean;
}

export function listBankedResetCredits(resets: ProviderResets, now: number | null): BankedResetCredit[] {
  const banked = resets.credits.filter((credit) => {
    if (credit.status === "redeemed" || credit.status === "expired") return false;
    if (credit.remainingCount !== undefined && credit.remainingCount <= 0) return false;
    if (credit.expiresAt !== undefined && now !== null && credit.expiresAt <= now) return false;
    return true;
  });
  let nextIndex = resets.nextCreditId
    ? banked.findIndex((credit) => credit.id === resets.nextCreditId && credit.usable !== false)
    : -1;
  if (nextIndex === -1) nextIndex = banked.findIndex((credit) => credit.usable === true);
  if (nextIndex === -1 && resets.spendable) {
    nextIndex = banked.findIndex((credit) => (credit.status ?? "available") === "available");
  }
  return banked.map((credit, index) => {
    const canSpend = Boolean(resets.spendable && (credit.usable ?? (credit.status ?? "available") === "available"));
    return {
      ...credit,
      scope: classifyResetCreditScope(credit),
      canSpend,
      nextToSpend: index === nextIndex,
      queued: !canSpend && credit.status === "unavailable" && (nextIndex !== -1 || index > 0),
    };
  });
}

export function formatProviderUsageReport(report: ProviderUsageReport, noLimitsLabel: string): string {
  if (report.noLimits) return noLimitsLabel;
  const parts: string[] = [];
  if (report.pool) parts.push(report.pool);
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

export function useProviderUsage(query: string | null, refreshMs = 60_000): ProviderUsageState & { refresh: () => void } {
  const [state, setState] = useState<ProviderUsageState>({ snapshot: null, loading: false, error: false });
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (query === null) {
      setState({ snapshot: null, loading: false, error: false });
      return;
    }
    const polling = Number.isFinite(refreshMs) && refreshMs > 0;
    let disposed = false;
    let inFlight = false;
    // Asked for while a request runs: that answer may predate the change.
    let refreshPending = false;
    let nextRefreshAt = 0;
    let controller: AbortController | undefined;
    let refreshTimer: number | undefined;
    let requestTimer: number | undefined;
    const canLoad = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
    const clearRefreshTimer = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };
    const schedule = () => {
      clearRefreshTimer();
      if (disposed || inFlight || !polling || !canLoad()) return;
      refreshTimer = window.setTimeout(() => void load(), Math.max(0, nextRefreshAt - Date.now()));
    };
    setState({ snapshot: null, loading: true, error: false });
    const load = async () => {
      if (disposed || inFlight || !canLoad()) return;
      clearRefreshTimer();
      inFlight = true;
      const request = new AbortController();
      controller = request;
      requestTimer = window.setTimeout(() => request.abort(), 35_000);
      try {
        const response = await fetch(`/api/provider-usage${query ? `?${query}` : ""}`, { signal: request.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = await response.json() as ProviderUsageSnapshot;
        if (!disposed && !request.signal.aborted) setState({ snapshot, loading: false, error: false });
      } catch {
        if (!disposed) setState((previous) => ({ ...previous, loading: false, error: true }));
      } finally {
        window.clearTimeout(requestTimer);
        inFlight = false;
        // Count from completion so slow requests neither overlap nor race the server cache TTL.
        nextRefreshAt = refreshPending ? Date.now() : polling ? Date.now() + refreshMs : Infinity;
        if (refreshPending) {
          refreshPending = false;
          void load();
        } else {
          schedule();
        }
      }
    };
    const resume = () => {
      if (!canLoad()) clearRefreshTimer();
      else if (Date.now() >= nextRefreshAt) void load();
      else schedule();
    };
    void load();
    const refresh = () => {
      nextRefreshAt = 0;
      if (inFlight) refreshPending = true;
      else void load();
    };
    const routingStorageChanged = (event: StorageEvent) => {
      if (event.key === ACCOUNT_ROUTING_CHANGED_EVENT) refresh();
    };
    refreshRef.current = refresh;
    window.addEventListener(ACCOUNT_ROUTING_CHANGED_EVENT, refresh);
    window.addEventListener("storage", routingStorageChanged);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    return () => {
      disposed = true;
      controller?.abort();
      clearRefreshTimer();
      window.clearTimeout(requestTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      window.removeEventListener(ACCOUNT_ROUTING_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", routingStorageChanged);
      refreshRef.current = () => {};
    };
  }, [query, refreshMs]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...state, refresh };
}
