"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Gauge, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { formatUsageReset, listBankedResetCredits, RESET_SCOPE_I18N_KEYS, usageSourceName, usageTone, useProviderUsage } from "./AppShell-provider-usage";
import type { ProviderCreditBalance, ProviderResets, ProviderUsageReport, ProviderUsageWindow } from "@/lib/provider-usage-types";

interface WindowDef {
  short: string;
  pick: (report: ProviderUsageReport) => ProviderUsageWindow | undefined;
}

const WINDOWS: WindowDef[] = [
  { short: "5H", pick: (r) => r.fiveHour },
  { short: "7D", pick: (r) => r.sevenDay },
  { short: "30D", pick: (r) => r.monthly },
];

const COLLAPSED_STORAGE_KEY = "omp-web:provider-usage-collapsed";

function worstWindow(report: ProviderUsageReport): { short: string; window: ProviderUsageWindow } | null {
  let best: { short: string; window: ProviderUsageWindow } | null = null;
  for (const def of WINDOWS) {
    const window = def.pick(report);
    if (window && (best === null || window.percent > best.window.percent)) {
      best = { short: def.short, window };
    }
  }
  if (report.credits && (!best || report.credits.percent > best.window.percent)) {
    best = { short: report.credits.limitSource === "fallback" ? "HC*" : "HC", window: report.credits };
  }
  return best;
}

export function CreditBalanceDetails({ credits, t }: {
  credits: ProviderCreditBalance;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
      <span>{t("providerUsage.creditBalance", { value: credits.remaining })}</span>
      <span>{t(credits.limitSource === "fallback" ? "providerUsage.creditLimitFallback" : "providerUsage.creditLimit", { value: credits.limit })}</span>
      <span>{t(credits.limitSource === "fallback" ? "providerUsage.creditReferenceUsed" : "providerUsage.creditUsed", { percent: Number(credits.percent.toFixed(1)) })}</span>
      {credits.limitSource === "fallback" && <span style={{ color: "var(--text-dim)" }}>{t("providerUsage.creditCaveat")}</span>}
    </div>
  );
}

function DetailMeter({ short, window, t }: {
  short: string;
  window: ProviderUsageWindow;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const pct = Math.round(window.percent);
  const tone = usageTone(pct);
  const rawReset = window.resetMinutes ?? window.resetHours;
  const reset = rawReset !== undefined
    ? formatUsageReset(rawReset, window.resetMinutes !== undefined ? "minutes" : "hours")
    : null;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em", width: 22, flexShrink: 0 }}>{short}</span>
      <span style={{ flex: 1, minWidth: 0, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: tone, borderRadius: 2 }} />
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {pct}%
      </span>
      {reset && (
        <span style={{ fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
          {t("providerUsage.resets", { value: reset })}
        </span>
      )}
    </span>
  );
}


const RESET_REASON_KEYS: Record<string, string> = {
  not_at_wall: "providerUsage.resetReasonNotAtWall",
  cooldown: "providerUsage.resetReasonCooldown",
  ineligible: "providerUsage.resetReasonIneligible",
};

// Saved Codex / Claude rate-limit resets: how many, when they expire, and a
// button that spends one through `omp usage reset` after a confirmation.
export function ResetCredits({ resets, accountKey, account, now, locale, onSpent, t }: {
  resets: ProviderResets;
  accountKey: string;
  account: string;
  /** Snapshot time; expiries are shown relative to it. */
  now: number | null;
  locale: string;
  onSpent: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [selectedCreditId, setSelectedCreditId] = useState<string | undefined>(undefined);
  const [spending, setSpending] = useState(false);
  const formatTime = (ms: number) => new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const formatExpiry = (expiresAt: number) => now !== null
    ? t("providerUsage.resetExpiresIn", { value: formatUsageReset(Math.max(0, Math.round((expiresAt - now) / 3_600_000)), "hours"), time: formatTime(expiresAt) })
    : t("providerUsage.resetExpiresAt", { time: formatTime(expiresAt) });
  const banked = listBankedResetCredits(resets, now);
  const selectableCredits = banked.filter((credit) => credit.canSpend && Boolean(credit.id));
  const hasChoice = selectableCredits.length > 1;
  const defaultCredit = banked.find((credit) => credit.nextToSpend) ?? selectableCredits[0];
  const activeChoice = (selectedCreditId ? selectableCredits.find((credit) => credit.id === selectedCreditId) : undefined) ?? defaultCredit;
  const activeCardParts = [
    activeChoice?.scope ? t(RESET_SCOPE_I18N_KEYS[activeChoice.scope]) : undefined,
    activeChoice?.title,
  ].filter((part): part is string => Boolean(part));
  const activeCardSummary = activeCardParts.length > 0 ? activeCardParts.join(" · ") : null;
  const reasonKey = resets.reason && !(resets.reason === "cooldown" && resets.cooldownUntil === undefined) ? RESET_REASON_KEYS[resets.reason] : undefined;
  // Known reasons explain an empty count too (Claude offers none below its limit).
  const reason = resets.spendable || !resets.reason
    ? null
    : reasonKey
      ? t(reasonKey, { time: resets.cooldownUntil !== undefined ? formatTime(resets.cooldownUntil) : "" })
      : resets.available > 0 ? t("providerUsage.resetReasonOther", { reason: resets.reason }) : null;

  const openConfirm = (creditId?: string) => {
    setSelectedCreditId(creditId ?? defaultCredit?.id);
    setConfirming(true);
  };

  const spend = async (creditId?: string) => {
    setSpending(true);
    try {
      const response = await fetch("/api/provider-usage/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creditId ? { accountKey, creditId } : { accountKey }),
      });
      const data = await response.json().catch(() => null) as { ok?: unknown; message?: unknown; error?: unknown } | null;
      if (!response.ok || typeof data?.ok !== "boolean") {
        throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
      }
      const message = typeof data.message === "string" ? data.message : undefined;
      if (data.ok) toast.success(t("providerUsage.resetApplied"), message);
      else toast.error(t("providerUsage.resetNotApplied"), message);
    } catch (error) {
      toast.error(t("providerUsage.resetRequestFailed"), error instanceof Error ? error.message : undefined);
    } finally {
      setSpending(false);
      onSpent();
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-muted)" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 20 }}>
        <RotateCcw size={10} strokeWidth={2.2} aria-hidden="true" style={{ flexShrink: 0, color: resets.available > 0 ? "var(--accent)" : "var(--text-dim)" }} />
        <span style={{ flex: 1, minWidth: 0, color: resets.available > 0 ? "var(--text)" : "var(--text-dim)" }}>
          {resets.available > 0 ? t("providerUsage.resetsAvailable", { count: resets.available }) : t("providerUsage.resetsNone")}
        </span>
        {resets.available > 0 && (
          <button
            type="button"
            disabled={!resets.spendable || spending}
            onClick={() => openConfirm()}
            title={reason ?? undefined}
            style={{
              flexShrink: 0,
              height: 20,
              padding: "0 7px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--bg)",
              color: resets.spendable && !spending ? "var(--accent)" : "var(--text-dim)",
              cursor: resets.spendable && !spending ? "pointer" : "default",
              fontSize: 10,
              fontFamily: "inherit",
              fontWeight: 600,
            }}
          >
            {spending ? t("providerUsage.resetUsing") : t(hasChoice ? "providerUsage.resetChoose" : "providerUsage.resetUse")}
          </button>
        )}
      </span>
      {banked.map((credit, index) => {
        const scopeLabel = credit.scope ? t(RESET_SCOPE_I18N_KEYS[credit.scope]) : null;
        const countSuffix = (credit.remainingCount ?? 1) > 1 ? ` ×${credit.remainingCount}` : "";
        const expiryLabel = credit.expiresAt !== undefined
          ? formatExpiry(credit.expiresAt)
          : (!scopeLabel ? credit.title ?? null : null);
        if (!scopeLabel && !expiryLabel) return null;
        const canPickThis = hasChoice && credit.canSpend && Boolean(credit.id);
        return (
          <span
            key={`${credit.id ?? credit.expiresAt ?? "no-exp"}-${index}`}
            title={credit.title}
            style={{ paddingLeft: 16, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, color: "var(--text-dim)", overflowWrap: "anywhere" }}
          >
            {scopeLabel && (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "0 5px",
                  borderRadius: 4,
                  lineHeight: 1.6,
                  border: "1px solid var(--border)",
                  background: credit.canSpend ? "var(--bg-selected)" : "var(--bg)",
                  color: credit.canSpend ? "var(--accent)" : "var(--text-muted)",
                  whiteSpace: "nowrap",
                }}
              >
                {scopeLabel}{countSuffix}
              </span>
            )}
            {expiryLabel && <span style={{ flex: "1 1 auto", minWidth: 0 }}>{expiryLabel}</span>}
            {credit.queued && <span style={{ color: "var(--text-dim)" }}>· {t("providerUsage.resetQueued")}</span>}
            {canPickThis && (
              <button
                type="button"
                disabled={spending}
                onClick={() => openConfirm(credit.id)}
                style={{
                  marginLeft: "auto",
                  flexShrink: 0,
                  height: 18,
                  padding: "0 6px",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  background: "var(--bg)",
                  color: spending ? "var(--text-dim)" : "var(--accent)",
                  cursor: spending ? "default" : "pointer",
                  fontSize: 9,
                  fontFamily: "inherit",
                  fontWeight: 600,
                }}
              >
                {t("providerUsage.resetUseThis")}
              </button>
            )}
          </span>
        );
      })}
      {reason && <span style={{ paddingLeft: 16, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{reason}</span>}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          style={{ width: 440, maxWidth: "min(92vw, 440px)", padding: 22, display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}
        >
          <DialogTitle>
            <span style={{ overflowWrap: "anywhere" }}>{t("providerUsage.resetConfirmTitle", { account })}</span>
          </DialogTitle>
          {hasChoice ? (
            <div role="radiogroup" aria-label={t("providerUsage.resetSelectLabel")} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
                {t("providerUsage.resetSelectLabel")}
              </span>
              {selectableCredits.map((credit) => {
                const checked = activeChoice?.id === credit.id;
                const scopeLabel = credit.scope ? t(RESET_SCOPE_I18N_KEYS[credit.scope]) : (credit.id ?? "");
                const countSuffix = (credit.remainingCount ?? 1) > 1 ? ` ×${credit.remainingCount}` : "";
                return (
                  <label
                    key={credit.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 9,
                      padding: "8px 10px",
                      borderRadius: "var(--radius-control)",
                      border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                      background: checked ? "var(--bg-selected)" : "var(--bg-panel)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name={`reset-credit-${accountKey}`}
                      checked={checked}
                      onChange={() => setSelectedCreditId(credit.id)}
                      style={{ marginTop: 3, accentColor: "var(--accent)", flexShrink: 0 }}
                    />
                    <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 700, color: checked ? "var(--accent)" : "var(--text)" }}>
                          {scopeLabel}{countSuffix}
                        </span>
                        {credit.expiresAt !== undefined && (
                          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                            {formatExpiry(credit.expiresAt)}
                          </span>
                        )}
                      </span>
                      {credit.title && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4, overflowWrap: "anywhere" }}>
                          {credit.title}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : activeCardSummary ? (
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)", fontWeight: 500, overflowWrap: "anywhere" }}>
              {t("providerUsage.resetConfirmCard", { card: activeCardSummary })}
            </div>
          ) : null}
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-muted)" }}>
            {t("providerUsage.resetConfirmBody")}
          </p>
          <div className="dialog-actions" style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button
              type="button"
              className="dialog-action"
              onClick={() => setConfirming(false)}
              style={{
                padding: "6px 14px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {t("providerUsage.aliasCancel")}
            </button>
            <button
              type="button"
              className="dialog-action"
              disabled={spending}
              onClick={() => {
                setConfirming(false);
                void spend(activeChoice?.id);
              }}
              style={{
                padding: "6px 14px",
                background: "var(--accent-strong)",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: "var(--on-accent)",
                cursor: spending ? "wait" : "pointer",
                fontSize: 13,
                fontWeight: 600,
                opacity: spending ? 0.7 : 1,
              }}
            >
              {t("providerUsage.resetConfirm")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Compact provider rate-limit block pinned above Settings in the sidebar: one
// slim row per account (worst window only), click to expand the full detail.
export function ProviderUsageBar() {
  const { t, locale } = useI18n();
  const { snapshot, loading, error, refresh } = useProviderUsage("");
  const reports = (snapshot?.reports ?? []).filter(report => !report.disabled);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // The first render must match the server, where localStorage is unavailable,
  // so start collapsed and apply the stored preference after mounting.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      // No stored choice yet → stay hidden; an explicit expand persists.
      if (window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "false") setCollapsed(false);
    } catch {
      // Storage unavailable: keep the collapsed default.
    }
  }, []);

  let worst: { percent: number; window: string } | null = null;
  for (const report of reports) {
    const best = worstWindow(report);
    if (best && (worst === null || best.window.percent > worst.percent)) {
      worst = { percent: Math.round(best.window.percent), window: best.short };
    }
  }

  return (
    <section
      className="provider-usage-panel wallpaper-surface"
      aria-label={t("appShell.sectionProviderUsage")}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 8px 6px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
        minHeight: 0,
        maxHeight: "32vh",
        overflowY: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => {
          const next = !v;
          try {
            window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
          } catch {
            // The preference still applies for this page load.
          }
          return next;
        })}
        aria-expanded={!collapsed}
        title={t("appShell.sectionProviderUsage")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          boxSizing: "border-box",
          padding: "0 4px",
          minWidth: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <ChevronRight
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
        <span aria-hidden="true" style={{ display: "flex", color: "var(--accent)", flexShrink: 0 }}>
          <Gauge size={13} strokeWidth={2} aria-hidden="true" />
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("appShell.sectionProviderUsage")}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-mono)", color: worst ? usageTone(worst.percent) : "var(--text-dim)", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          {loading && reports.length === 0
            ? t("appShell.providerUsageLoading")
            : error
              ? t("appShell.providerUsageUnavailable")
              : worst
                ? t("providerUsage.highest", { percent: worst.percent, window: worst.window })
                : t(reports.length === 0 && (snapshot?.reports.length ?? 0) > 0 ? "providerUsage.noEnabledAccounts" : "appShell.providerUsageNoData")}
        </span>
      </button>
      {!collapsed && reports.map((report, index) => {
        const account = report.accountAlias ?? report.accountLabel ?? t("appShell.account", { number: report.accountIndex ?? index + 1 });
        // The pool goes into the source chip (antigravity-gemini); the full pool name stays in the tooltip.
        const rowTitle = report.pool ? `${report.pool} · ${account}` : account;
        const key = `${report.provider}:${report.accountKey}:${report.modelId ?? "all"}:${report.tier ?? ""}:${report.pool ?? ""}`;
        const best = worstWindow(report);
        const canExpand = Boolean(report.credits || (!report.noLimits && best) || report.resets);
        const expanded = canExpand && expandedKey === key;
        const Row = canExpand ? "button" : "div";
        const pct = best ? Math.round(best.window.percent) : 0;
        const tone = usageTone(pct);
        return (
          <div key={key} className="provider-usage-account" style={{ borderRadius: "var(--radius-control)", background: expanded ? "var(--bg-subtle)" : "transparent" }}>
            <Row
              type={canExpand ? "button" : undefined}
              onClick={canExpand ? () => setExpandedKey((prev) => (prev === key ? null : key)) : undefined}
              aria-expanded={canExpand ? expanded : undefined}
              title={rowTitle}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 6px 4px",
                background: "none",
                border: "none",
                cursor: canExpand ? "pointer" : "default",
                textAlign: "left",
                minWidth: 0,
              }}
            >
              <ChevronRight
                size={11}
                strokeWidth={2}
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  visibility: canExpand ? "visible" : "hidden",
                  color: "var(--text-dim)",
                  transform: expanded ? "rotate(90deg)" : "none",
                  transition: "transform var(--dur-med) var(--ease-out-warm)",
                }}
              />
              <span className="provider-usage-name wallpaper-inset" style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 10, color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", padding: "0 5px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, lineHeight: 1.7 }}>
                {usageSourceName(report)}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {account}
              </span>
              {(report.resets?.available ?? 0) > 0 && (() => {
                const scopes = listBankedResetCredits(report.resets!, snapshot?.generatedAt ?? null)
                  .map((credit) => credit.scope ? t(RESET_SCOPE_I18N_KEYS[credit.scope]) : null)
                  .filter((label): label is string => Boolean(label));
                const baseTitle = t("providerUsage.resetsAvailable", { count: report.resets!.available });
                return (
                  <span
                    title={scopes.length > 0 ? `${baseTitle} (${scopes.join(" / ")})` : baseTitle}
                    style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--accent)" }}
                  >
                    <RotateCcw size={10} strokeWidth={2.2} aria-hidden="true" />
                    {report.resets!.available}
                  </span>
                );
              })()}
              {report.noUsageData ? (
                <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }} title={t("appShell.providerUsageNoData")}>—</span>
              ) : report.noLimits ? (
                <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>∞</span>
              ) : report.credits ? (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
                  title={t("providerUsage.creditBalance", { value: report.credits.remaining })}>
                  {report.credits.remaining}/{report.credits.limit}{report.credits.limitSource === "fallback" ? "*" : ""}
                </span>
              ) : (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {pct}%
                </span>
              )}
            </Row>
            {!report.noLimits && (
              <div style={{ height: 3, margin: "0 6px 0 23px", borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: tone, borderRadius: 2 }} />
              </div>
            )}
            {expanded && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px 7px 23px", fontFamily: "var(--font-mono)" }}>
                {report.credits && <CreditBalanceDetails credits={report.credits} t={t} />}
                {!report.noLimits && WINDOWS.map((def) => {
                  const window = def.pick(report);
                  return window ? <DetailMeter key={def.short} short={def.short} window={window} t={t} /> : null;
                })}
                {report.resets && (
                  <ResetCredits
                    resets={report.resets}
                    accountKey={report.accountKey}
                    account={`${report.provider} · ${account}`}
                    now={snapshot?.generatedAt ?? null}
                    locale={locale}
                    onSpent={refresh}
                    t={t}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
