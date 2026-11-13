"use client";

import { useI18n } from "@/lib/i18n";
import { BarChart3, Bot, Cable, KeyRound, Palette, RefreshCw, Settings2 } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";

export type SettingsTab =
  | "general"
  | "appearance"
  | "providers"
  | "usage"
  | "agents"
  | "extensions"
  | "system";

export type AppearanceTab = "display" | "wallpapers" | "pets" | "motion";
export type ProvidersTab = "connected" | "custom" | "system" | "defaults";

export interface TabItem {
  id: SettingsTab;
  label: string;
  description: string;
  Icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false"; style?: CSSProperties }>;
  needsWorkspace?: boolean;
}

export const SETTINGS_CATEGORIES: TabItem[] = [
  { id: "general", label: "Interface & Behavior", description: "UI preferences, keyboard shortcuts, and submission behavior", Icon: Settings2 },
  { id: "appearance", label: "Appearance & Personalization", description: "Themes, wallpapers, glass, pets, motion, and text size", Icon: Palette },
  { id: "providers", label: "Models & Providers", description: "Accounts, model registry, and global model defaults", Icon: KeyRound },
  { id: "usage", label: "Usage", description: "Tokens, costs, cache analytics, and model breakdown", Icon: BarChart3 },
  { id: "agents", label: "Agents & Policies", description: "Instructions, subagents, context, memory, retries, and tool approvals", Icon: Bot },
  { id: "extensions", label: "Extensions & Skills", description: "Built-in image generation, MCP servers, and the Skills library", Icon: Cable },
  { id: "system", label: "System & Updates", description: "App updates, runtime version, and active session restart", Icon: RefreshCw },
];


export function SettingsTabs({
  active,
  onSelect,
  workspaceReady = true,
  layout = "vertical",
  attentionTabs,
}: {
  active: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  workspaceReady?: boolean;
  layout?: "horizontal" | "vertical";
  attentionTabs?: Partial<Record<SettingsTab, boolean | string>>;
}) {
  const { t } = useI18n();
  const currentActive = active;

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const enabled = SETTINGS_CATEGORIES.filter((tab) => !(tab.needsWorkspace && !workspaceReady));
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = index + 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = index - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = enabled.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const next = enabled[nextIndex] ?? enabled[index];
      if (next) {
        onSelect(next.id);
        const targetBtn = document.getElementById("settings-tab-" + next.id);
        targetBtn?.focus();
      }
    }
  };

  if (layout === "vertical") {
    return (
      <nav
        aria-label={t("settingsTabs.ariaLabel")}
        role="tablist"
        aria-orientation="vertical"
        className="settings-nav"
      >
        {SETTINGS_CATEGORIES.map(({ id, label, description, Icon, needsWorkspace }, index) => {
          const labelKey = `settingsTabs.${id}.label`;
          const descKey = `settingsTabs.${id}.description`;
          const trLabel = t(labelKey);
          const trDesc = t(descKey);
          const displayLabel = trLabel !== labelKey ? trLabel : label;
          const displayDescription = trDesc !== descKey ? trDesc : description;
          const selected = id === currentActive;
          const disabled = Boolean(needsWorkspace && !workspaceReady);
          const attention = attentionTabs?.[id];
          const hasAttention = Boolean(attention);
          const attentionLabel = typeof attention === "string" ? attention : t("settingsTabs.attentionRequired");
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={selected}
              aria-controls={`settings-panel-${id}`}
              aria-label={hasAttention ? `${displayLabel}: ${displayDescription} (${attentionLabel})` : undefined}
              title={hasAttention ? `${displayDescription} (${attentionLabel})` : displayDescription}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onSelect(id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`settings-nav-item${selected ? " active" : ""}`}
              style={{
                opacity: disabled ? 0.5 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, marginTop: 2, color: selected ? "var(--accent)" : "currentColor" }}>
                <Icon size={16} aria-hidden="true" />
                {hasAttention && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: -3,
                      right: -4,
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      border: "1px solid var(--bg-panel)",
                    }}
                  />
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: selected ? 600 : 500, lineHeight: 1.3, color: selected ? "var(--text)" : "inherit" }}>
                {displayLabel}
              </div>
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="settings-nav-horizontal" aria-label={t("settingsTabs.ariaLabel")} role="tablist" style={{ display: "flex", gap: 3, padding: "7px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0, overflowX: "auto" }}>
      {SETTINGS_CATEGORIES.map(({ id, label, description, Icon, needsWorkspace }, index) => {
        const labelKey = `settingsTabs.${id}.label`;
        const descKey = `settingsTabs.${id}.description`;
        const trLabel = t(labelKey);
        const trDesc = t(descKey);
        const displayLabel = trLabel !== labelKey ? trLabel : label;
        const displayDescription = trDesc !== descKey ? trDesc : description;
        const selected = id === currentActive;
        const disabled = Boolean(needsWorkspace && !workspaceReady);
        const attention = attentionTabs?.[id];
        const hasAttention = Boolean(attention);
        const attentionLabel = typeof attention === "string" ? attention : t("settingsTabs.attentionRequired");
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={selected}
            aria-controls={`settings-panel-${id}`}
            aria-label={hasAttention ? `${displayLabel}: ${displayDescription} (${attentionLabel})` : `${displayLabel}: ${displayDescription}`}
            title={hasAttention ? `${displayDescription} (${attentionLabel})` : displayDescription}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: selected ? "var(--bg-selected)" : "transparent", color: selected ? "var(--text)" : "var(--text-muted)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, fontSize: 12, whiteSpace: "nowrap", textAlign: "left" }}
          >
            <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, marginTop: 1 }}>
              <Icon size={13} aria-hidden="true" />
              {hasAttention && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: -3,
                    right: -4,
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    border: "1px solid var(--bg-panel)",
                  }}
                />
              )}
            </span>
            <span style={{ fontWeight: selected ? 600 : 500 }}>{displayLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}
