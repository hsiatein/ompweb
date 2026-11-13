"use client";

import { useEffect, useRef, useState } from "react";
import { AlarmClock, Clock, Send, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { InfoHint } from "./ui/primitives";
import type { ScheduledMessage } from "@/lib/scheduled-messages";
import type { ProviderUsageSnapshot } from "@/lib/provider-usage-types";
import { usageSourceName } from "./AppShell-provider-usage";

const PRESET_MINUTES = [30, 60, 120, 300] as const;
// Fire a little after the reported reset so the new window is already open.
const RESET_MARGIN_MS = 60_000;

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", rest || (!days && !hours) ? `${rest}m` : ""].filter(Boolean).join(" ");
}

function formatWhen(at: number, locale: string): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(locale, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** `<input type="datetime-local">` value in local time. */
function toLocalInput(at: number): string {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

interface ResetOption { at: number; label: string }

/** 5-hour quota resets of the current model's provider accounts (minute precision). */
async function loadResetOptions(model: { provider: string; modelId: string }): Promise<ResetOption[]> {
  const query = new URLSearchParams({ provider: model.provider, model: model.modelId });
  const response = await fetch(`/api/provider-usage?${query}`, { cache: "no-store" });
  if (!response.ok) return [];
  const snapshot = await response.json() as ProviderUsageSnapshot;
  const base = snapshot.generatedAt ?? Date.now();
  const options: ResetOption[] = [];
  for (const report of snapshot.reports) {
    const minutes = report.fiveHour?.resetMinutes;
    if (minutes === undefined) continue;
    const at = base + minutes * 60_000 + RESET_MARGIN_MS;
    if (at <= Date.now() || options.some((option) => option.at === at)) continue;
    const account = report.accountAlias ?? report.accountLabel;
    options.push({ at, label: [usageSourceName(report), account].filter(Boolean).join(" · ") });
  }
  return options.sort((a, b) => a.at - b.at);
}

/** Clock button beside Send: pick when the composer text goes out. */
export function ScheduleSendButton({ disabled, disabledReason, model, onSchedule }: {
  disabled: boolean;
  disabledReason?: string;
  model?: { provider: string; modelId: string } | null;
  /** Resolves true once stored; the composer then clears. */
  onSchedule: (sendAt: number) => Promise<boolean>;
}) {
  const { t, locale } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const [resets, setResets] = useState<ResetOption[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setCustom(toLocalInput(Date.now() + 60 * 60_000));
    let cancelled = false;
    if (model) {
      loadResetOptions(model).then((options) => { if (!cancelled) setResets(options); }).catch(() => {});
    }
    const onPointer = (event: MouseEvent) => {
      // The "?" popup is portaled outside the panel; clicking it must not close the panel.
      const target = event.target as Element;
      if (!wrapRef.current?.contains(target) && !target.closest?.(".info-hint-popup")) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, model]);

  const pick = async (sendAt: number) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await onSchedule(sendAt)) setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const customAt = custom ? new Date(custom).getTime() : NaN;
  const customValid = Number.isFinite(customAt) && customAt > now;

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        className="composer-icon-button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        title={disabled ? disabledReason ?? t("scheduledSend.title") : t("scheduledSend.title")}
        aria-label={t("scheduledSend.title")}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <AlarmClock size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label={t("scheduledSend.title")} className="picker-panel schedule-send-panel">
          <div className="schedule-send-heading">
            {t("scheduledSend.title")}
            <span className="hint-chip">{t("scheduledSend.serverBadge")}</span>
            <InfoHint label={t("scheduledSend.serverBadge")}>{t("scheduledSend.note")}</InfoHint>
          </div>
          {resets.length > 0 && (
            <div className="schedule-send-group">
              {resets.map((reset) => (
                <button key={reset.at} type="button" disabled={busy} onClick={() => void pick(reset.at)}>
                  <span>{t("scheduledSend.afterReset", { name: reset.label })}</span>
                  <span className="schedule-send-time">{formatWhen(reset.at, locale)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="schedule-send-presets">
            {PRESET_MINUTES.map((minutes) => (
              <button key={minutes} type="button" disabled={busy} onClick={() => void pick(Date.now() + minutes * 60_000)}>
                {t("scheduledSend.inPreset", { duration: formatDuration(minutes * 60_000) })}
              </button>
            ))}
          </div>
          <form
            className="schedule-send-custom"
            onSubmit={(event) => { event.preventDefault(); if (Number.isFinite(customAt) && customAt > Date.now()) void pick(customAt); }}
          >
            <input
              type="datetime-local"
              value={custom}
              min={toLocalInput(now)}
              onChange={(event) => setCustom(event.target.value)}
              aria-label={t("scheduledSend.customTime")}
            />
            <button type="submit" disabled={busy || !customValid}>{t("scheduledSend.schedule")}</button>
          </form>
        </div>
      )}
    </div>
  );
}

/** Pending scheduled messages above the composer, each cancellable or sendable now. */
export function ScheduledMessagesPanel({ messages, onCancel, onSendNow }: {
  messages: readonly ScheduledMessage[];
  onCancel: (id: string) => void;
  onSendNow: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  // A clock in state (refreshed every 30 s and when the list changes) keeps
  // "in 2h 13m" counting down without reading the time during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (messages.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [messages]);
  if (messages.length === 0) return null;

  return (
    <div className="composer-scheduled-panel wallpaper-surface" role="list" aria-label={t("scheduledSend.listLabel")}>
      {messages.map((entry) => (
        <div key={entry.id} role="listitem" className="composer-scheduled-item" data-failed={entry.error ? true : undefined}>
          <Clock size={13} strokeWidth={1.9} aria-hidden="true" className="composer-scheduled-icon" />
          <span className="composer-scheduled-when">
            {entry.error
              ? t("scheduledSend.failed")
              : `${formatWhen(entry.sendAt, locale)} · ${t("scheduledSend.inDuration", { duration: formatDuration(entry.sendAt - now) })}`}
          </span>
          <span className="composer-scheduled-text" title={entry.error ? `${entry.error}\n\n${entry.message}` : entry.message}>
            {entry.message}
          </span>
          <button type="button" onClick={() => onSendNow(entry.id)} title={entry.error ? t("scheduledSend.retry") : t("scheduledSend.sendNow")}>
            <Send size={12} strokeWidth={2} aria-hidden="true" />
            <span>{entry.error ? t("scheduledSend.retry") : t("scheduledSend.sendNow")}</span>
          </button>
          <button type="button" onClick={() => onCancel(entry.id)} aria-label={t("scheduledSend.cancel")} title={t("scheduledSend.cancel")}>
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
