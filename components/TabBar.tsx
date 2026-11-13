"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Activity, AtSign, Copy, Download, Folder, GitBranch, LayoutDashboard, LocateFixed, SquareTerminal, X } from "lucide-react";
import { PluginIcon } from "./PluginsPanel";
import { useI18n } from "@/lib/i18n";
import { contributeContextMenu, type ContextMenuItem } from "@/lib/context-menu";
import { getFileIcon } from "./FileIcons";
import { useShortcuts } from "@/hooks/useShortcuts";
import { shortcutAria, shortcutHint } from "@/lib/keyboard-shortcuts";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Pinned Explorer tab rendered before the file tabs (right-panel tab redesign). */
  explorerSelected?: boolean;
  onSelectExplorer?: () => void;
  /** Changed-file count badge on the Explorer tab. */
  explorerBadge?: number;
  /** Pinned Git changes tab rendered after Explorer (Tauri parity). */
  gitSelected?: boolean;
  onSelectGit?: () => void;
  /** Changed-file count badge on the Git tab. */
  gitBadge?: number;
  /** Pinned Terminal tab rendered after Git. */
  terminalSelected?: boolean;
  onSelectTerminal?: () => void;
  /** Pinned System (resource dashboard) tab rendered after Terminal. */
  systemSelected?: boolean;
  onSelectSystem?: () => void;
  /** Amber dot on the System tab: available memory is in the warning band. */
  systemWarning?: boolean;
  /** Pinned Status board tab rendered after System. */
  statusSelected?: boolean;
  onSelectStatus?: () => void;
  /** Live (running/paused) status items, and whether any failed (red dot). */
  statusBadge?: { live: number; failed: boolean };
  /** The open web plugin page, rendered as a closable tab after System. */
  pluginTab?: { name: string; iconUrl: string | null } | null;
  pluginSelected?: boolean;
  onSelectPlugin?: () => void;
  onClosePlugin?: () => void;
  /** File-tab right-click actions; each acts on the tab that was clicked. */
  onCloseOtherTabs?: (id: string) => void;
  onCloseAllTabs?: () => void;
  onMentionTab?: (id: string) => void;
  onCopyTabPath?: (id: string) => void;
  onRevealTab?: (id: string) => void;
  onDownloadTab?: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, explorerSelected = false, onSelectExplorer, explorerBadge = 0, gitSelected = false, onSelectGit, gitBadge = 0, terminalSelected = false, onSelectTerminal, systemSelected = false, onSelectSystem, systemWarning = false, statusSelected = false, onSelectStatus, statusBadge, pluginTab = null, pluginSelected = false, onSelectPlugin, onClosePlugin, onCloseOtherTabs, onCloseAllTabs, onMentionTab, onCopyTabPath, onRevealTab, onDownloadTab }: Props) {
  const { t } = useI18n();
  const shortcutBindings = useShortcuts();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const orderedTabIds = [
    ...(onSelectExplorer ? ["explorer"] : []),
    ...(onSelectGit ? ["git"] : []),
    ...(onSelectTerminal ? ["terminal"] : []),
    ...(onSelectSystem ? ["system"] : []),
    ...(onSelectStatus ? ["status"] : []),
    ...(pluginTab && onSelectPlugin ? ["plugin"] : []),
    ...tabs.map((tab) => tab.id),
  ];

  const selectTabById = (id: string) => {
    if (id === "explorer") onSelectExplorer?.();
    else if (id === "git") onSelectGit?.();
    else if (id === "terminal") onSelectTerminal?.();
    else if (id === "system") onSelectSystem?.();
    else if (id === "status") onSelectStatus?.();
    else if (id === "plugin") onSelectPlugin?.();
    else {
      const tab = tabs.find((item) => item.id === id);
      if (tab) onSelectTab(tab.id);
    }
  };

  const focusTabById = (id: string) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTabById(id);
      return;
    }

    const index = orderedTabIds.indexOf(id);
    if (index < 0 || orderedTabIds.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % orderedTabIds.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + orderedTabIds.length) % orderedTabIds.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = orderedTabIds.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const nextId = orderedTabIds[nextIndex];
      selectTabById(nextId);
      focusTabById(nextId);
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && tabs.some((tab) => tab.id === id)) {
      event.preventDefault();
      onCloseTab(id);
    }
  };

  // Keep the active tab visible when the bar overflows horizontally.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < listRect.left) {
      list.scrollLeft -= listRect.left - tabRect.left;
    } else if (tabRect.right > listRect.right) {
      list.scrollLeft += tabRect.right - listRect.right;
    }
  }, [activeTabId, tabs]);

  // A mouse wheel only scrolls vertically; turn it into horizontal scrolling
  // of the tab strip. Native listener: React's onWheel is passive and cannot
  // preventDefault. Trackpad sideways swipes (deltaX) keep their own behavior.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (list.scrollWidth <= list.clientWidth) return;
      const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * list.clientWidth : event.deltaY;
      event.preventDefault();
      list.scrollLeft += step;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t("appShell.filePanel")}
      aria-orientation="horizontal"
      className="tabbar-scroll"
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: "var(--tab-height)",
      }}
    >
      {onSelectExplorer && (
        <div
          data-tab-id="explorer"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectExplorer}
          role="tab"
          tabIndex={explorerSelected ? 0 : -1}
          aria-selected={explorerSelected}
          aria-label={t("sessionSidebar.explorer")}
          aria-controls="workspace-file-panel-explorer"
          title={explorerBadge > 0 ? t("sessionSidebar.explorerChanged", { count: explorerBadge }) : t("sessionSidebar.explorer")}
          onKeyDown={(event) => handleTabKeyDown(event, "explorer")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "var(--tab-height)",
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: explorerSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            color: explorerSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {explorerSelected && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: "var(--accent)",
                borderTopLeftRadius: "var(--radius-control)",
                borderTopRightRadius: "var(--radius-control)",
              }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: explorerSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: explorerSelected ? "var(--accent)" : undefined }}>
            <Folder size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: explorerSelected ? 500 : 400 }}>
            {t("sessionSidebar.explorer")}
          </span>
          {explorerBadge > 0 && (
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minWidth: 16,
                height: 15,
                padding: "0 4px",
                borderRadius: 8,
                background: "color-mix(in srgb, var(--status-modified) 18%, transparent)",
                color: "var(--status-modified)",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {explorerBadge > 99 ? "99+" : explorerBadge}
            </span>
          )}
        </div>
      )}
      {onSelectGit && (
        <div
          data-tab-id="git"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectGit}
          role="tab"
          tabIndex={gitSelected ? 0 : -1}
          aria-selected={gitSelected}
          aria-label={t("tabBar.git")}
          aria-controls="workspace-file-panel-git"
          title={gitBadge > 0 ? t("sessionSidebar.explorerChanged", { count: gitBadge }) : t("tabBar.git")}
          onKeyDown={(event) => handleTabKeyDown(event, "git")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "var(--tab-height)",
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: gitSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            color: gitSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {gitSelected && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: "var(--accent)",
                borderTopLeftRadius: "var(--radius-control)",
                borderTopRightRadius: "var(--radius-control)",
              }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: gitSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: gitSelected ? "var(--accent)" : undefined }}>
            <GitBranch size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: gitSelected ? 500 : 400 }}>
            {t("tabBar.git")}
          </span>
          {gitBadge > 0 && (
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minWidth: 16,
                height: 15,
                padding: "0 4px",
                borderRadius: 8,
                background: "color-mix(in srgb, var(--status-modified) 18%, transparent)",
                color: "var(--status-modified)",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {gitBadge > 99 ? "99+" : gitBadge}
            </span>
          )}
        </div>
      )}
      {onSelectTerminal && (
        <div
          data-tab-id="terminal"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectTerminal}
          role="tab"
          tabIndex={terminalSelected ? 0 : -1}
          aria-selected={terminalSelected}
          aria-label={t("terminal.title")}
          aria-controls="workspace-file-panel-terminal"
          title={shortcutHint(t("terminal.title"), "toggleTerminal", shortcutBindings)}
          aria-keyshortcuts={shortcutAria("toggleTerminal", shortcutBindings)}
          onKeyDown={(event) => handleTabKeyDown(event, "terminal")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "var(--tab-height)",
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: terminalSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            color: terminalSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {terminalSelected && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: "var(--accent)",
                borderTopLeftRadius: "var(--radius-control)",
                borderTopRightRadius: "var(--radius-control)",
              }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: terminalSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: terminalSelected ? "var(--accent)" : undefined }}>
            <SquareTerminal size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: terminalSelected ? 500 : 400 }}>
            {t("terminal.title")}
          </span>
        </div>
      )}
      {onSelectSystem && (
        <div
          data-tab-id="system"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectSystem}
          role="tab"
          tabIndex={systemSelected ? 0 : -1}
          aria-selected={systemSelected}
          aria-label={t("systemPanel.title")}
          aria-controls="workspace-file-panel-system"
          title={systemWarning ? t("systemPanel.lowMemoryTitle") : t("systemPanel.title")}
          onKeyDown={(event) => handleTabKeyDown(event, "system")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "var(--tab-height)",
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: systemSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            color: systemSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {systemSelected && (
            <span
              aria-hidden="true"
              style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "var(--accent)", borderTopLeftRadius: "var(--radius-control)", borderTopRightRadius: "var(--radius-control)" }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: systemSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: systemWarning ? "var(--status-warning)" : systemSelected ? "var(--accent)" : undefined }}>
            <Activity size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: systemSelected ? 500 : 400 }}>
            {t("systemPanel.title")}
          </span>
          {systemWarning && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--status-warning)", flexShrink: 0 }} />}
        </div>
      )}
      {onSelectStatus && (
        <div
          data-tab-id="status"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectStatus}
          role="tab"
          tabIndex={statusSelected ? 0 : -1}
          aria-selected={statusSelected}
          aria-label={t("statusBoard.title")}
          aria-controls="workspace-file-panel-status"
          title={t("statusBoard.title")}
          onKeyDown={(event) => handleTabKeyDown(event, "status")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "var(--tab-height)",
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: statusSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            color: statusSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {statusSelected && (
            <span
              aria-hidden="true"
              style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "var(--accent)", borderTopLeftRadius: "var(--radius-control)", borderTopRightRadius: "var(--radius-control)" }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: statusSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: statusSelected ? "var(--accent)" : undefined }}>
            <LayoutDashboard size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: statusSelected ? 500 : 400 }}>
            {t("statusBoard.title")}
          </span>
          {statusBadge && statusBadge.live > 0 && (
            <span style={{ minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 10, lineHeight: "16px", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{statusBadge.live}</span>
          )}
          {statusBadge?.failed && <span aria-label={t("statusBoard.state.failed")} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--status-error)", flexShrink: 0 }} />}
        </div>
      )}
      {pluginTab && onSelectPlugin && (
        <div
          data-tab-id="plugin"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectPlugin}
          role="tab"
          tabIndex={pluginSelected ? 0 : -1}
          aria-selected={pluginSelected}
          aria-label={pluginTab.name}
          aria-controls="workspace-file-panel-plugin"
          title={pluginTab.name}
          onKeyDown={(event) => handleTabKeyDown(event, "plugin")}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            onClosePlugin?.();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "var(--tab-height)",
            paddingLeft: 12,
            paddingRight: 6,
            borderRight: "1px solid var(--border)",
            background: pluginSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            color: pluginSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            maxWidth: 180,
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {pluginSelected && (
            <span
              aria-hidden="true"
              style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "var(--accent)", borderTopLeftRadius: "var(--radius-control)", borderTopRightRadius: "var(--radius-control)" }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: pluginSelected ? 1 : 0.7, display: "flex", alignItems: "center" }}>
            <PluginIcon iconUrl={pluginTab.iconUrl} size={13} />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1, fontWeight: pluginSelected ? 500 : 400 }}>
            {pluginTab.name}
          </span>
          {onClosePlugin && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClosePlugin(); }}
              tabIndex={pluginSelected ? 0 : -1}
              onKeyDown={(event) => event.stopPropagation()}
              onMouseEnter={() => setHoveredClose("plugin")}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "var(--icon-control-size-compact)", height: "var(--icon-control-size-compact)",
                background: hoveredClose === "plugin" ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: hoveredClose === "plugin" ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
              }}
              title={t("plugins.close")}
              aria-label={t("plugins.close")}
            >
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className="tabbar-tab ui-focus-ring"
            onClick={() => onSelectTab(tab.id)}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-label={tab.filePath}
            aria-controls="workspace-file-panel-file"
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            onContextMenu={(event) => {
              const items: ContextMenuItem[] = [
                { id: "close", label: t("contextMenu.close"), icon: X, onSelect: () => onCloseTab(tab.id) },
              ];
              if (onCloseOtherTabs) items.push({ id: "close-others", label: t("contextMenu.closeOthers"), disabled: tabs.length < 2, onSelect: () => onCloseOtherTabs(tab.id) });
              if (onCloseAllTabs) items.push({ id: "close-all", label: t("contextMenu.closeAll"), onSelect: onCloseAllTabs });
              if (onMentionTab) items.push({ id: "mention", label: t("contextMenu.mention"), icon: AtSign, onSelect: () => onMentionTab(tab.id) });
              if (onCopyTabPath) items.push({ id: "copy-path", label: t("contextMenu.copyRelativePath"), icon: Copy, onSelect: () => onCopyTabPath(tab.id) });
              if (onRevealTab) items.push({ id: "reveal", label: t("contextMenu.revealInExplorer"), icon: LocateFixed, onSelect: () => onRevealTab(tab.id) });
              if (onDownloadTab) items.push({ id: "download", label: t("contextMenu.download"), icon: Download, onSelect: () => onDownloadTab(tab.id) });
              contributeContextMenu(event, { id: "file-tab", title: tab.label, items });
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: "var(--tab-height)",
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: "var(--text-sm)",
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              position: "relative",
              transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
            }}
          >
            {isActive && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2,
                  background: "var(--accent)",
                  borderTopLeftRadius: "var(--radius-control)",
                  borderTopRightRadius: "var(--radius-control)",
                }}
              />
            )}
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={(event) => event.stopPropagation()}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "var(--icon-control-size-compact)", height: "var(--icon-control-size-compact)",
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
              }}
              title={t("tabBar.close")}
              aria-label={t("tabBar.closeTab", { label: tab.label })}
            >
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
