"use client";

import { memo, useEffect, useState, type RefObject } from "react";
import {
  AtSign,
  ChevronsDownUp,
  Copy,
  Download,
  Files,
  Folder,
  GitBranch,
  LocateFixed,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import { TabBar, type Tab } from "./TabBar";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { GitChangesPanel } from "./GitChangesPanel";
import { FileViewer } from "./FileViewer";
import { TerminalPanel } from "./TerminalPanel";
import { SystemPanel } from "./SystemPanel";
import { StatusBoardPanel } from "./StatusBoardPanel";
import { useI18n } from "@/lib/i18n";
import { getFileName } from "@/lib/file-paths";
import type { FileEditorStatus, FileMutation } from "@/lib/file-editing";
import { PluginFrame, type OpenPluginPage } from "./PluginPage";

export type RightPanelView = "explorer" | "git" | "terminal" | "system" | "status" | "file" | "plugin";

interface Props {
  fileTabs: Tab[];
  activeFileTabId: string | null;
  rightView: RightPanelView;
  onSelectView: (view: RightPanelView) => void;
  rightPanelOpen: boolean;
  /** The chat is collapsed: the panel takes the chat's room (no resize handle). */
  rightPanelFill?: boolean;
  rightPanelWidth: number | null;
  rightPanelResizing: boolean;
  rightPanelRef: RefObject<HTMLDivElement | null>;
  fileExplorerRef: RefObject<FileExplorerHandle | null>;
  revealPath: string | null;
  onRevealDone: () => void;
  explorerCwd: string | null;
  activeCwd: string | null;
  explorerRefreshKey: number;
  fileSearchOpen: boolean;
  onToggleFileSearch: () => void;
  onFileSearchOpenChange: (open: boolean) => void;
  explorerUploadBusy: boolean;
  onUploadBusyChange: (busy: boolean) => void;
  explorerGitCount: number;
  explorerIsRepo: boolean;
  explorerRefreshing: boolean;
  isMobile: boolean;
  isCompactOverlay: boolean;
  onOpenFile: (filePath: string, fileName: string, sourceSessionId?: string | null) => void;
  fileEditorStates: ReadonlyMap<string, FileEditorStatus>;
  onEditorStateChange: (filePath: string, status: FileEditorStatus) => void;
  onBeforeFileMutation: (paths: string[]) => boolean;
  onFileMutation: (mutation: FileMutation) => void;
  onSelectFileTab: (id: string) => void;
  onCloseFileTab: (id: string) => void;
  onCloseOtherFileTabs: (id: string) => void;
  onCloseAllFileTabs: () => void;
  onMentionFileTab: (id: string) => void;
  onCopyFileTabPath: (id: string) => void;
  onDownloadFileTab: (id: string) => void;
  onRevealFileTab: (id: string) => void;
  onExplorerRefresh: () => void;
  onExplorerRefreshDone: () => void;
  onAtMention: (relativePath: string, isDir: boolean) => void;
  onAtMentions: (relativePaths: string[]) => void;
  onMentionLines: (relativePath: string, startLine: number, endLine: number) => void;
  onExplorerGitStatus: (changedCount: number, isRepo: boolean) => void;
  onResetRightPanelWidth: () => void;
  onRightPanelResizeStart: (e: React.MouseEvent) => void;
  onRightPanelResizeKey: (e: React.KeyboardEvent) => void;
  /** Latest "Open in terminal" request; a new id starts a shell in its cwd. */
  terminalRequest: { id: number; cwd: string } | null;
  /** Web plugin page shown as its own tab (opened from the sidebar plugin list). */
  openPlugin: OpenPluginPage | null;
  pluginFrameKey: number;
  onReloadPlugin: () => void;
  onClosePlugin: () => void;
  /** The chat on screen: its status board section comes first. */
  currentSessionId: string | null;
  /** Status board: open another session's chat. */
  onOpenSession: (sessionId: string, cwd: string) => void;
}

// Memo boundary: AppShell re-renders on polls, timers, and session updates
// while agents run. The panel hosts the full file tree, the changes list, and
// every open viewer — reconciling all of that per update janks the chat, so
// this component only re-renders when one of its own props actually changes
// (all callbacks are useCallback-stable in AppShell for the same reason).
export const RightPanel = memo(function RightPanel({
  fileTabs,
  activeFileTabId,
  rightView,
  onSelectView,
  rightPanelOpen,
  rightPanelFill = false,
  rightPanelWidth,
  rightPanelResizing,
  rightPanelRef,
  fileExplorerRef,
  revealPath,
  onRevealDone,
  explorerCwd,
  activeCwd,
  explorerRefreshKey,
  fileSearchOpen,
  onToggleFileSearch,
  onFileSearchOpenChange,
  explorerUploadBusy,
  onUploadBusyChange,
  explorerGitCount,
  explorerIsRepo,
  explorerRefreshing,
  isMobile,
  isCompactOverlay,
  onOpenFile,
  fileEditorStates,
  onEditorStateChange,
  onBeforeFileMutation,
  onFileMutation,
  onSelectFileTab,
  onCloseFileTab,
  onCloseOtherFileTabs,
  onCloseAllFileTabs,
  onMentionFileTab,
  onCopyFileTabPath,
  onDownloadFileTab,
  onRevealFileTab,
  onExplorerRefresh,
  onExplorerRefreshDone,
  onAtMention,
  onAtMentions,
  onMentionLines,
  onExplorerGitStatus,
  onResetRightPanelWidth,
  onRightPanelResizeStart,
  onRightPanelResizeKey,
  terminalRequest,
  openPlugin,
  pluginFrameKey,
  onReloadPlugin,
  onClosePlugin,
  currentSessionId,
  onOpenSession,
}: Props) {
  const { t } = useI18n();
  const [systemWarning, setSystemWarning] = useState(false);
  const [statusBadge, setStatusBadge] = useState<{ live: number; failed: boolean }>({ live: 0, failed: false });
  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const gitBadge = explorerIsRepo ? explorerGitCount : 0;
  const [visitedViews, setVisitedViews] = useState<Set<RightPanelView>>(() => new Set(["explorer"]));
  useEffect(() => {
    setVisitedViews((previous) => {
      if (previous.has(rightView)) return previous;
      const next = new Set(previous);
      next.add(rightView);
      return next;
    });
  }, [rightView]);

  return (
    <>
      {/* Resize handle — desktop only, hidden while the panel is closed */}
      {!isMobile && rightPanelOpen && !rightPanelFill && (
        <div
          className="right-panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("appShell.resizeFilePanel")}
          tabIndex={0}
          onMouseDown={onRightPanelResizeStart}
          onDoubleClick={onResetRightPanelWidth}
          onKeyDown={onRightPanelResizeKey}
          title={t("appShell.resizeFilePanelTitle")}
          style={{
            width: 5,
            flexShrink: 0,
            marginRight: -5,
            cursor: "col-resize",
            background: "transparent",
            zIndex: 205,
            outline: "none",
            transition: "background var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
        />
      )}
      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <aside
        id="workspace-file-panel"
        ref={rightPanelRef}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelFill ? " right-panel-fill" : ""}${rightPanelResizing ? " right-panel-resizing" : ""}`}
        role={isCompactOverlay && rightPanelOpen ? "dialog" : undefined}
        aria-modal={isCompactOverlay && rightPanelOpen ? true : undefined}
        aria-label={t("appShell.filePanel")}
        aria-hidden={!rightPanelOpen}
        tabIndex={isCompactOverlay ? -1 : undefined}
        inert={!rightPanelOpen ? true : undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          zIndex: isCompactOverlay ? 210 : undefined,
          ...(!isMobile && rightPanelWidth !== null ? { "--right-panel-width": `${rightPanelWidth}px` } : {}),
        }}
      >
        {/* Right panel toolbar: tabs + editor integrations (chat, path, explorer) */}
        <div className="right-panel-toolbar wallpaper-surface" style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", minHeight: isMobile ? 44 : 36, paddingRight: isMobile ? 44 : 36, flexWrap: "wrap" }}>
          <div style={{ flex: isMobile ? "1 0 100%" : "1 1 160px", overflow: "hidden", minWidth: 0 }}>
            <TabBar
              tabs={fileTabs.map((tab) => fileEditorStates.has(tab.filePath) ? { ...tab, label: `${tab.label} *` } : tab)}
              activeTabId={rightView === "file" ? activeFileTabId ?? "" : ""}
              onSelectTab={onSelectFileTab}
              onCloseTab={onCloseFileTab}
              explorerSelected={rightView === "explorer"}
              onSelectExplorer={() => onSelectView("explorer")}
              explorerBadge={gitBadge}
              gitSelected={rightView === "git"}
              onSelectGit={() => onSelectView("git")}
              gitBadge={gitBadge}
              terminalSelected={rightView === "terminal"}
              onSelectTerminal={() => onSelectView("terminal")}
              systemSelected={rightView === "system"}
              onSelectSystem={() => onSelectView("system")}
              statusSelected={rightView === "status"}
              onSelectStatus={() => onSelectView("status")}
              statusBadge={statusBadge}
              pluginTab={openPlugin ? { name: openPlugin.name, iconUrl: openPlugin.iconUrl } : null}
              pluginSelected={rightView === "plugin"}
              onSelectPlugin={() => onSelectView("plugin")}
              onClosePlugin={onClosePlugin}
              systemWarning={systemWarning}
              onCloseOtherTabs={onCloseOtherFileTabs}
              onCloseAllTabs={onCloseAllFileTabs}
              onMentionTab={onMentionFileTab}
              onCopyTabPath={onCopyFileTabPath}
              onRevealTab={onRevealFileTab}
              onDownloadTab={onDownloadFileTab}
            />
          </div>
          {rightView === "explorer" ? (
            explorerCwd && (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={t("sessionSidebar.explorer")}>
              <button
                onClick={onToggleFileSearch}
                title={t("fileExplorer.searchFiles")}
                aria-label={t("fileExplorer.searchFiles")}
                aria-pressed={fileSearchOpen}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: fileSearchOpen ? "var(--bg-hover)" : "none", border: "none", borderRadius: "var(--radius-control)", color: fileSearchOpen ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Search size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sessionSidebar.uploadFilesTitle")}
                aria-label={t("sessionSidebar.uploadFiles")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: explorerUploadBusy ? "default" : "pointer", opacity: explorerUploadBusy ? 0.6 : 1 }}
                onMouseEnter={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Upload size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={() => fileExplorerRef.current?.collapseAll()}
                title={t("sessionSidebar.collapseExplorer")}
                aria-label={t("sessionSidebar.collapseExplorer")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: isMobile ? "auto" : 26, height: 26, padding: isMobile ? "0 8px" : 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
              >
                <ChevronsDownUp size={isMobile ? 16 : 13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />
                {isMobile && <span>{t("sessionSidebar.collapseExplorer")}</span>}
              </button>
              <button
                aria-label={t("sessionSidebar.refreshExplorer")}
                onClick={onExplorerRefresh}
                title={t("sessionSidebar.refreshExplorer")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: explorerRefreshing ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <RefreshCw size={13} strokeWidth={2} aria-hidden="true" className={explorerRefreshing ? "icon-spin" : undefined} />
              </button>
            </div>
            )
          ) : rightView === "git" ? (
            explorerCwd && (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={t("tabBar.git")}>
              <button
                aria-label={t("gitChanges.refreshChanges")}
                onClick={onExplorerRefresh}
                title={t("gitChanges.refreshChanges")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: explorerRefreshing ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <RefreshCw size={13} strokeWidth={2} aria-hidden="true" className={explorerRefreshing ? "icon-spin" : undefined} />
              </button>
            </div>
            )
          ) : rightView === "plugin" ? (
            openPlugin && (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={openPlugin.name}>
              <button
                aria-label={t("plugins.reloadPage")}
                onClick={onReloadPlugin}
                title={t("plugins.reloadPage")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            )
          ) : activeFileTab && (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={activeFileTab.filePath}>
              <button
                onClick={() => onMentionFileTab(activeFileTab.id)}
                title={t("appShell.mentionFileInChat")}
                aria-label={t("appShell.mentionFileInChat")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--accent)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
              >
                <AtSign size={13} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <button
                onClick={() => onCopyFileTabPath(activeFileTab.id)}
                title={t("appShell.copyFilePath")}
                aria-label={t("appShell.copyFilePath")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Copy size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={() => onRevealFileTab(activeFileTab.id)}
                title={t("appShell.revealInExplorer")}
                aria-label={t("appShell.revealInExplorer")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: revealPath ? "var(--bg-hover)" : "none", border: "none", borderRadius: "var(--radius-control)", color: revealPath ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = revealPath ? "var(--accent)" : "var(--text-dim)"; e.currentTarget.style.background = revealPath ? "var(--bg-hover)" : "none"; }}
              >
                <LocateFixed size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={() => onDownloadFileTab(activeFileTab.id)}
                title={t("fileExplorer.downloadFile")}
                aria-label={t("fileExplorer.downloadFile")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Download size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              {fileTabs.length > 1 && (
                <button
                  onClick={() => onCloseOtherFileTabs(activeFileTab.id)}
                  title={t("appShell.closeOtherTabs")}
                  aria-label={t("appShell.closeOtherTabs")}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 26, padding: "0 7px", background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  {t("appShell.closeOthers")}
                </button>
              )}
              <button
                onClick={onCloseAllFileTabs}
                title={t("appShell.closeAllTabs")}
                aria-label={t("appShell.closeAllTabs")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* Explorer tab view — kept mounted so expansion survives tab switches. */}
        <div id="workspace-file-panel-explorer" role="tabpanel" aria-label={t("sessionSidebar.explorer")} style={{ display: rightView === "explorer" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {visitedViews.has("explorer") && (explorerCwd ? (
            <>
              <div
                className="wallpaper-surface"
                title={explorerCwd}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  margin: "8px 8px 4px",
                  padding: "5px 8px",
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text-muted)",
                  minWidth: 0,
                  flexShrink: 0,
                }}
              >
                <Folder size={13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {getFileName(explorerCwd)}
                  </span>
                  <span style={{ display: "block", fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>
                    {explorerCwd}
                  </span>
                </span>
                {explorerIsRepo && (
                  <span
                    title={explorerGitCount > 0 ? t("sessionSidebar.explorerChanged", { count: explorerGitCount }) : t("sessionSidebar.explorerClean")}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: explorerGitCount > 0 ? "var(--status-modified)" : "var(--status-success)",
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                <FileExplorer
                  ref={fileExplorerRef}
                  cwd={explorerCwd}
                  onOpenFile={onOpenFile}
                  refreshKey={explorerRefreshKey}
                  onAtMention={onAtMention}
                  onAtMentions={onAtMentions}
                  onUploadBusyChange={onUploadBusyChange}
                  onRefreshDone={onExplorerRefreshDone}
                  fileSearchOpen={fileSearchOpen}
                  onFileSearchOpenChange={onFileSearchOpenChange}
                  activeFilePath={activeFileTab?.filePath ?? null}
                  revealPath={revealPath}
                  onRevealDone={onRevealDone}
                  onGitStatusChange={onExplorerGitStatus}
                  onBeforeMutation={onBeforeFileMutation}
                  onMutation={onFileMutation}
                />
              </div>
            </>
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
              <Folder size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("sessionSidebar.explorer")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("sessionSidebar.selectProjectFirst")}</div>
            </div>
          ))}
        </div>
        {/* Git changes tab view — kept mounted so selection survives tab switches. */}
        <div id="workspace-file-panel-git" role="tabpanel" aria-label={t("tabBar.git")} style={{ display: rightView === "git" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {visitedViews.has("git") && (explorerCwd ? (
            <GitChangesPanel
              cwd={explorerCwd}
              refreshKey={explorerRefreshKey}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              onRefreshDone={onExplorerRefreshDone}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
              <GitBranch size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("tabBar.git")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("sessionSidebar.selectProjectFirst")}</div>
            </div>
          ))}
        </div>
        {/* Terminal tab view — kept mounted once opened so the shell view survives tab switches. */}
        <div id="workspace-file-panel-terminal" role="tabpanel" aria-label={t("terminal.title")} style={{ display: rightView === "terminal" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {visitedViews.has("terminal") && (
            <TerminalPanel cwd={explorerCwd ?? activeCwd ?? null} active={rightPanelOpen && rightView === "terminal"} request={terminalRequest} />
          )}
        </div>
        {/* System tab view — resource dashboard and memory guard (polls only while mounted). */}
        <div id="workspace-file-panel-system" role="tabpanel" aria-label={t("systemPanel.title")} style={{ display: rightView === "system" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {visitedViews.has("system") && (
            <SystemPanel active={rightPanelOpen && rightView === "system"} onWarningChange={setSystemWarning} />
          )}
        </div>
        {/* Status board view — always mounted (it keeps the tab badge current); renders only while shown. */}
        <div id="workspace-file-panel-status" role="tabpanel" aria-label={t("statusBoard.title")} style={{ display: rightView === "status" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          <StatusBoardPanel active={rightPanelOpen && rightView === "status"} currentSessionId={currentSessionId} onOpenSession={onOpenSession} onSummaryChange={setStatusBadge} />
        </div>
        {/* Plugin tab view — the page stays mounted while other tabs are shown.
            The frosted glass comes from this host element: an iframe's own
            backdrop-filter cannot see the wallpaper behind it. */}
        <div id="workspace-file-panel-plugin" className="wallpaper-surface" role="tabpanel" aria-label={openPlugin?.name ?? t("plugins.title")} style={{ display: rightView === "plugin" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {openPlugin && <PluginFrame plugin={openPlugin} frameKey={pluginFrameKey} />}
        </div>
        {/* Keep open viewers mounted so switching tabs preserves scroll and preview state. */}
        <div id="workspace-file-panel-file" role="tabpanel" aria-label={activeFileTab?.filePath ?? t("appShell.filePanel")} style={{ display: rightView === "file" ? "block" : "none", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {fileTabs.length > 0 ? fileTabs.map((tab) => (
            <div key={tab.id} style={{ display: tab.id === activeFileTabId ? "block" : "none", height: "100%" }}>
              <FileViewer
                filePath={tab.filePath}
                cwd={activeCwd ?? undefined}
                sourceSessionId={tab.sourceSessionId}
                gitRefreshKey={explorerRefreshKey}
                onEditorStateChange={onEditorStateChange}
                onSaved={onExplorerRefresh}
                active={tab.id === activeFileTabId && rightPanelOpen && rightView === "file"}
                onMentionLines={tab.id === activeFileTabId && rightPanelOpen && rightView === "file" ? onMentionLines : undefined}
                onOpenFile={(filePath) => onOpenFile(
                  filePath,
                  getFileName(filePath),
                  tab.sourceSessionId,
                )}
              />
            </div>
          )) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
              <Files size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("appShell.noFileOpen")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("appShell.noFileOpenHint")}</div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
});
