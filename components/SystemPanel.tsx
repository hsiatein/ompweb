"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, ChevronRight, Cpu, MemoryStick, ShieldAlert, SquareTerminal, Bot } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getFileName } from "@/lib/file-paths";
import { toast } from "@/components/ui/toast";
import { Check, ConfirmDialog } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/primitives";
import { KILL_PERCENT_RANGE, WARN_PERCENT_RANGE, type MemoryGuardSettings } from "@/lib/memory-guard-settings";
import { formatBytes, type MonitoredProcess, type OwnerUsage, type ProcessOwner, type SystemSnapshot } from "@/lib/system-monitor-types";

const ACTIVE_POLL_MS = 2000;
/** Hidden but mounted: keep the tab's low-memory dot current at a low cost. */
const BACKGROUND_POLL_MS = 15000;

function ownerLabel(owner: ProcessOwner): string {
  if (owner.kind === "session") return owner.sessionName || getFileName(owner.cwd) || owner.cwd;
  return getFileName(owner.cwd) || owner.cwd;
}

function Meter({ percent, tone, markers = [] }: { percent: number; tone: string; markers?: Array<{ at: number; color: string; label: string }> }) {
  return (
    <div className="system-meter" role="presentation">
      <div className="system-meter-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: tone }} />
      {markers.map((marker) => (
        <span key={marker.label} className="system-meter-marker" title={marker.label} style={{ left: `${marker.at}%`, background: marker.color }} />
      ))}
    </div>
  );
}

function GuardSettingsEditor({ guard, totalBytes, onSaved }: { guard: MemoryGuardSettings; totalBytes: number; onSaved: (guard: MemoryGuardSettings) => void }) {
  const { t } = useI18n();
  const [kill, setKill] = useState(String(guard.killBelowPercent));
  const [warn, setWarn] = useState(String(guard.warnBelowPercent));
  useEffect(() => { setKill(String(guard.killBelowPercent)); setWarn(String(guard.warnBelowPercent)); }, [guard.killBelowPercent, guard.warnBelowPercent]);

  const save = async (patch: Partial<MemoryGuardSettings>) => {
    try {
      const response = await fetch("/api/system", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memoryGuard: patch }) });
      const body = await response.json() as { memoryGuard?: MemoryGuardSettings; error?: string };
      if (!response.ok || !body.memoryGuard) throw new Error(body.error || `HTTP ${response.status}`);
      onSaved(body.memoryGuard);
    } catch (error) {
      toast.error(t("systemPanel.saveFailed"), error instanceof Error ? error.message : String(error));
    }
  };
  const commit = (field: "killBelowPercent" | "warnBelowPercent", text: string) => {
    const value = Number(text);
    if (!Number.isFinite(value) || value === guard[field]) return;
    void save({ [field]: value });
  };
  const absolute = (percent: number) => totalBytes > 0 ? ` ≈ ${formatBytes((totalBytes * percent) / 100)}` : "";
  const [warnBefore, warnAfter = ""] = t("systemPanel.warnInline").split("{n}");
  const [killBefore, killAfter = ""] = t("systemPanel.killInline").split("{n}");

  return (
    <div className="system-guard-settings">
      <Check label={t("systemPanel.guardEnabled")} checked={guard.enabled} onChange={(enabled) => void save({ enabled })} />
      <label className="system-guard-field">
        <span>{warnBefore}</span>
        <input type="number" min={WARN_PERCENT_RANGE.min} max={WARN_PERCENT_RANGE.max} step={1} value={warn}
          onChange={(event) => setWarn(event.target.value)} onBlur={() => commit("warnBelowPercent", warn)}
          onKeyDown={(event) => { if (event.key === "Enter") commit("warnBelowPercent", warn); }} />
        <span>{warnAfter}</span>
        <span className="system-dim">{absolute(guard.warnBelowPercent)}</span>
      </label>
      <label className="system-guard-field">
        <span>{killBefore}</span>
        <input type="number" min={KILL_PERCENT_RANGE.min} max={KILL_PERCENT_RANGE.max} step={0.5} value={kill} disabled={!guard.enabled}
          onChange={(event) => setKill(event.target.value)} onBlur={() => commit("killBelowPercent", kill)}
          onKeyDown={(event) => { if (event.key === "Enter") commit("killBelowPercent", kill); }} />
        <span>{killAfter}</span>
        <span className="system-dim">{absolute(guard.killBelowPercent)}</span>
      </label>
      <p className="system-dim system-guard-help">
        {t("systemPanel.guardScope")}
        <InfoHint label={t("systemPanel.guard")}>{t("systemPanel.guardHelp")}</InfoHint>
      </p>
    </div>
  );
}

function OwnerRow({ usage, totalBytes, onStop }: { usage: OwnerUsage; totalBytes: number; onStop: (process: MonitoredProcess, owner: ProcessOwner) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const Icon = usage.owner.kind === "session" ? Bot : SquareTerminal;
  return (
    <div className="system-owner">
      <button type="button" className="system-owner-head" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={usage.owner.cwd}>
        <ChevronRight size={12} strokeWidth={2} aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform var(--dur-fast)" }} />
        <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
        <span className="system-owner-name">{ownerLabel(usage.owner)}</span>
        <span className="system-dim">{t("systemPanel.processCount", { count: usage.processCount })}</span>
        <span className="system-owner-size">{formatBytes(usage.totalRssBytes)}</span>
      </button>
      <Meter percent={totalBytes > 0 ? (usage.totalRssBytes / totalBytes) * 100 : 0} tone="var(--accent)" />
      {open && (
        <ul className="system-process-list">
          <li className="system-process">
            <span className="system-process-command" title={usage.owner.kind === "session" ? "omp" : t("terminal.title")}>
              {usage.owner.kind === "session" ? "omp" : t("systemPanel.shell")} <span className="system-dim">· {usage.rootPid}</span>
            </span>
            <span className="system-process-size">{formatBytes(usage.rootRssBytes)}</span>
          </li>
          {usage.top.map((process) => (
            <li key={process.pid} className="system-process">
              <span className="system-process-command" title={process.command}>{process.command} <span className="system-dim">· {process.pid}</span></span>
              <span className="system-process-size">{formatBytes(process.rssBytes)}</span>
              <button type="button" className="system-stop" onClick={() => onStop(process, usage.owner)}>{t("systemPanel.stop")}</button>
            </li>
          ))}
          {usage.top.length === 0 && <li className="system-dim system-process-empty">{t("systemPanel.noCommands")}</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Right-panel System tab: memory and CPU gauges, memory per agent session and
 * terminal (with the commands they run), and the memory guard's settings and
 * recent actions (lib/memory-guard.ts).
 */
export function SystemPanel({ active, onWarningChange }: { active: boolean; onWarningChange: (warning: boolean) => void }) {
  const { t, locale } = useI18n();
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<{ process: MonitoredProcess; owner: ProcessOwner } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/system", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSnapshot(await response.json() as SystemSnapshot);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, active ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const memory = snapshot?.memory ?? null;
  const availablePercent = memory && memory.totalBytes > 0 ? (memory.availableBytes / memory.totalBytes) * 100 : null;
  const guard = snapshot?.guard;
  const warning = availablePercent !== null && guard !== undefined && availablePercent < guard.warnBelowPercent;
  useEffect(() => { onWarningChange(warning); }, [warning, onWarningChange]);

  const stop = async () => {
    if (!confirm) return;
    const { process } = confirm;
    setConfirm(null);
    try {
      const response = await fetch("/api/system", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stopPid: process.pid }) });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${response.status}`);
      void load();
    } catch (error) {
      toast.error(t("systemPanel.stopFailed"), error instanceof Error ? error.message : String(error));
    }
  };

  if (snapshot && !snapshot.supported) {
    return <div className="terminal-empty"><Activity size={26} strokeWidth={1.5} aria-hidden="true" /><div className="terminal-empty-text">{t("systemPanel.unsupported")}</div></div>;
  }
  if (!snapshot) {
    return <div className="terminal-empty"><div className="terminal-empty-text">{failed ? t("systemPanel.loadFailed") : t("systemPanel.loading")}</div></div>;
  }

  const usedPercent = availablePercent !== null ? 100 - availablePercent : 0;
  const critical = availablePercent !== null && guard !== undefined && availablePercent < guard.killBelowPercent;
  const memoryTone = critical ? "var(--status-error)" : warning ? "var(--status-warning)" : "var(--status-success)";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const managedTotal = snapshot.owners.reduce((sum, usage) => sum + usage.totalRssBytes, 0);

  return (
    <div className="system-panel">
      <section className="system-card wallpaper-surface">
        <div className="system-card-head">
          <MemoryStick size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{t("systemPanel.memory")}</span>
          {memory && <span className="system-card-value" style={{ color: memoryTone }}>{t("systemPanel.available", { value: formatBytes(memory.availableBytes), percent: Math.round(availablePercent ?? 0) })}</span>}
        </div>
        {memory && guard && (
          <>
            <Meter percent={usedPercent} tone={memoryTone} markers={guard.enabled ? [
              { at: 100 - guard.warnBelowPercent, color: "var(--status-warning)", label: t("systemPanel.warnLine") },
              { at: 100 - guard.killBelowPercent, color: "var(--status-error)", label: t("systemPanel.killLine") },
            ] : []} />
            <div className="system-row system-dim">
              <span>{t("systemPanel.used", { used: formatBytes(memory.totalBytes - memory.availableBytes), total: formatBytes(memory.totalBytes) })}</span>
              <span>{memory.swapTotalBytes > 0 ? t("systemPanel.swap", { used: formatBytes(memory.swapTotalBytes - memory.swapFreeBytes), total: formatBytes(memory.swapTotalBytes) }) : t("systemPanel.noSwap")}</span>
            </div>
            <div className="system-row system-dim">
              <span>{t("systemPanel.agentsUse", { value: formatBytes(managedTotal) })}</span>
              <span>{t("systemPanel.serverUses", { value: formatBytes(snapshot.serverRssBytes) })}</span>
            </div>
          </>
        )}
      </section>

      <section className="system-card wallpaper-surface">
        <div className="system-card-head">
          <Cpu size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{t("systemPanel.cpu")}</span>
          <span className="system-card-value">{snapshot.cpuPercent === null ? "…" : `${Math.round(snapshot.cpuPercent)}%`}</span>
        </div>
        <Meter percent={snapshot.cpuPercent ?? 0} tone="var(--accent)" />
        <div className="system-row system-dim">
          <span>{t("systemPanel.cores", { count: snapshot.cpuCount })}</span>
          {snapshot.loadAverage && <span>{t("systemPanel.load", { value: snapshot.loadAverage.map((value) => value.toFixed(2)).join(" · ") })}</span>}
        </div>
      </section>

      <section className="system-card wallpaper-surface">
        <div className="system-card-head">
          <Bot size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{t("systemPanel.byOwner")}</span>
        </div>
        {snapshot.owners.length === 0
          ? <div className="system-dim system-process-empty">{t("systemPanel.noOwners")}</div>
          : snapshot.owners.map((usage) => (
            <OwnerRow key={`${usage.owner.kind}:${usage.rootPid}`} usage={usage} totalBytes={memory?.totalBytes ?? 0} onStop={(process, owner) => setConfirm({ process, owner })} />
          ))}
      </section>

      <section className="system-card wallpaper-surface">
        <div className="system-card-head">
          <ShieldAlert size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{t("systemPanel.guard")}</span>
          <span className="system-card-value" style={{ color: snapshot.guard.enabled ? "var(--status-success)" : "var(--text-dim)" }}>
            {snapshot.guard.enabled ? t("systemPanel.guardOn") : t("systemPanel.guardOff")}
          </span>
        </div>
        <GuardSettingsEditor guard={snapshot.guard} totalBytes={memory?.totalBytes ?? 0} onSaved={(saved) => setSnapshot((current) => current && { ...current, guard: saved })} />
        <div className="system-subhead">{t("systemPanel.recentActions")}</div>
        {snapshot.events.length === 0 ? (
          <div className="system-dim system-process-empty">{t("systemPanel.noActions")}</div>
        ) : (
          <ul className="system-process-list">
            {snapshot.events.map((event) => (
              <li key={`${event.at}-${event.process.pid}`} className="system-event">
                <span className="system-dim">{time.format(event.at)}</span>
                <span className="system-process-command" title={event.process.command}>{event.process.command}</span>
                <span className="system-process-size">{formatBytes(event.process.rssBytes)}</span>
                <span className="system-dim system-event-meta">
                  {event.reason === "manual" ? t("systemPanel.reasonManual") : t("systemPanel.reasonLowMemory", { value: formatBytes(event.availableBytes) })}
                  {" · "}{event.signal}{" · "}{ownerLabel(event.owner)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={t("systemPanel.stopTitle")}
        description={confirm ? t("systemPanel.stopDescription", { command: confirm.process.command.slice(0, 200), owner: ownerLabel(confirm.owner) }) : undefined}
        confirmLabel={t("systemPanel.stop")}
        danger
        onConfirm={() => void stop()}
      />
    </div>
  );
}
