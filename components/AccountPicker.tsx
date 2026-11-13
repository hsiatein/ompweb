"use client";

import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, UserRound } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { groupAccountChoices, type AccountChoice, type AccountPins, type AccountRoutingView } from "@/lib/account-choices";
import type { ProviderUsageSnapshot } from "@/lib/provider-usage-types";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usageTone } from "./AppShell-provider-usage";

interface Props {
  /** Live session; null for a new chat, whose choice rides on its first spawn. */
  sessionId: string | null;
  provider: string;
  modelId: string;
  /** New-chat choice, owned by useAgentSession until the session exists. */
  pendingPins: AccountPins;
  onPendingPinsChange: (pins: AccountPins) => void;
  pendingProviderPin: string | null;
  onPendingProviderPinChange?: (provider: string | null) => void;
  busy?: boolean;
}

const EMPTY_ROUTING: AccountRoutingView = { disabled: [], disabledProviders: [], providerPin: null, pins: {}, serving: {} };

function CheckMark() {
  return <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>;
}

/** Strict provider/account selection; live policy changes apply at the next request. */
export const AccountPicker = memo(function AccountPicker({ sessionId, provider, modelId, pendingPins, onPendingPinsChange, pendingProviderPin, onPendingProviderPinChange, busy = false }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [choices, setChoices] = useState<AccountChoice[]>([]);
  const [routing, setRouting] = useState<AccountRoutingView>(EMPTY_ROUTING);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const refreshVersion = useRef(0);
  const menuId = useId();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++refreshVersion.current;
    try {
      const query = new URLSearchParams({ provider, model: modelId });
      const [usageResponse, routingResponse] = await Promise.all([
        fetch(`/api/provider-usage?${query}`, { cache: "no-store", signal }),
        fetch(`/api/account-routing${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { cache: "no-store", signal }),
      ]);
      const snapshot = usageResponse.ok ? await usageResponse.json() as ProviderUsageSnapshot : null;
      if (!routingResponse.ok) throw new Error(`HTTP ${routingResponse.status}`);
      const view = await routingResponse.json() as AccountRoutingView;
      if (signal?.aborted || version !== refreshVersion.current) return;
      setChoices(snapshot ? groupAccountChoices(snapshot.reports).get(provider) ?? [] : []);
      setRouting(view);
    } catch (error) {
      if (!signal?.aborted && version === refreshVersion.current) toast.error(t("accountRouting.loadFailed"), error instanceof Error ? error.message : String(error));
    }
  }, [provider, modelId, sessionId, t]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);


  const pins = sessionId ? routing.pins : pendingPins;
  const providerPin = sessionId ? routing.providerPin : pendingProviderPin;
  const selected = choices.find((choice) => choice.accountKey === pins[provider]);
  const serving = choices.find((choice) => choice.accountKey === routing.serving[provider]);
  const nameOf = (choice: AccountChoice) => choice.name ?? t("appShell.account", { number: choices.indexOf(choice) + 1 });
  const buttonLabel = selected ? nameOf(selected) : pins[provider] ? t("accountPicker.unavailable") : providerPin ?? t("accountPicker.auto");

  const choose = async (accountKey: string | null) => {
    setOpen(false);
    if (saving || busy || accountKey === (pins[provider] ?? null)) return;
    ++refreshVersion.current;
    const next = { ...pins };
    if (accountKey) next[provider] = accountKey;
    else delete next[provider];
    if (!sessionId) {
      onPendingPinsChange(next);
      return;
    }
    setRouting((current) => ({ ...current, pins: next }));
    setSaving(true);
    try {
      const response = await fetch("/api/account-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, provider, accountKey }),
      });
      const data = await response.json() as { pins: AccountPins; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRouting((current) => ({ ...current, pins: data.pins }));
    } catch (error) {
      setRouting((current) => ({ ...current, pins }));
      toast.error(t("accountPicker.saveFailed"), error instanceof Error ? error.message : String(error));
    }
    finally { setSaving(false); }
  };

  const chooseProvider = async (next: string | null) => {
    if (saving || busy) return;
    ++refreshVersion.current;
    if (!sessionId) { onPendingProviderPinChange?.(next); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/account-routing", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, providerPin: next }),
      });
      const data = await response.json() as { providerPin: string | null; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRouting(current => ({ ...current, providerPin: data.providerPin }));
    } catch (error) {
      toast.error(t("accountPicker.saveFailed"), error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };

  return (
    <div ref={wrapRef} className="composer-account-control" style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        disabled={busy || saving}
        className="wallpaper-inset"
        onClick={() => { if (!open) void refresh(); setOpen((value) => !value); }}
        title={t("accountPicker.title", { account: buttonLabel })}
        aria-label={`${t("accountPicker.label")}: ${buttonLabel}`}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          display: "flex", alignItems: "center", gap: 5,
          height: "var(--control-height-sm)", maxWidth: 160, padding: "0 6px",
          background: open ? "var(--bg-hover)" : selected ? "var(--bg-selected)" : "none",
          border: "none", borderRadius: 7, cursor: "pointer", fontSize: "var(--text-sm)",
          color: selected ? "var(--accent)" : "var(--text-muted)",
          transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
        }}
      >
        <UserRound size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{buttonLabel}</span>
        <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7, transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t("accountPicker.label")}
          className="picker-panel"
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}
          style={{
            position: isMobile ? "fixed" : "absolute",
            bottom: isMobile ? 8 : "calc(100% + 6px)",
            ...(isMobile ? { left: 8, right: 8 } : { right: 0, width: 250 }),
            zIndex: 500, maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(100dvh - 32px)", overflowY: "auto",
          }}
        >
          <div className="picker-panel-header">
            <UserRound size={12} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
            <span className="picker-panel-title">{t("accountPicker.label")}</span>
            <span className="picker-panel-count">{choices.length}</span>
          </div>
          <div className="picker-thinking-cards">
            <div role="group" aria-label={t("accountPicker.providerLabel")}>
              <button type="button" className="picker-thinking-card" role="menuitemradio" aria-checked={!providerPin} disabled={busy || saving} onClick={() => void chooseProvider(null)}>
                <span className="picker-check">{!providerPin && <CheckMark />}</span>{t("accountPicker.providerAuto")}
              </button>
              <button type="button" className="picker-thinking-card" role="menuitemradio" aria-checked={providerPin === provider} disabled={busy || saving || routing.disabledProviders.includes(provider)} onClick={() => void chooseProvider(provider)}>
                <span className="picker-check">{providerPin === provider && <CheckMark />}</span>{t("accountPicker.providerOnly", { provider })}
              </button>
            </div>
            <div role="group" aria-label={t("accountPicker.label")}>
            <button type="button" className="picker-thinking-card" role="menuitemradio" aria-checked={!pins[provider]} data-active={!pins[provider]} disabled={busy || saving} onClick={() => void choose(null)}>
              <span className="picker-check">{!pins[provider] && <CheckMark />}</span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span>{t("accountPicker.auto")}</span>
                <span style={{ fontSize: 10.5, fontWeight: 400, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {serving ? t("accountPicker.serving", { account: nameOf(serving) }) : t("accountPicker.autoDesc")}
                </span>
              </span>
            </button>
            {choices.map((choice) => {
              const active = choice === selected;
              const disabled = routing.disabled.includes(choice.accountKey) || routing.disabledProviders.includes(provider);
              return (
                <button key={choice.accountKey} type="button" disabled={busy || saving || disabled} className="picker-thinking-card" role="menuitemradio" aria-checked={active} data-active={active} onClick={() => void choose(choice.accountKey)}>
                  <span className="picker-check">{active && <CheckMark />}</span>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(choice)}</span>
                    {(choice.plan || disabled) && (
                      <span style={{ fontSize: 10.5, fontWeight: 400, color: "var(--text-dim)" }}>
                        {[choice.plan, disabled ? t("accountPicker.disabledTag") : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                  {choice.usedPercent !== undefined && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: usageTone(Math.round(choice.usedPercent)), flexShrink: 0 }}>
                      {Math.round(choice.usedPercent)}%
                    </span>
                  )}
                </button>
              );
            })}
            </div>
          </div>
          <div className="picker-panel-footer">
            <span>{t("accountPicker.appliesNext")}</span>
          </div>
        </div>
      )}
    </div>
  );
});
