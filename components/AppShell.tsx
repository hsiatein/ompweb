"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useShortcuts } from "@/hooks/useShortcuts";
import { matchesShortcut, shortcutAria, shortcutHint, shortcutLabel } from "@/lib/keyboard-shortcuts";
import { useSidebarHistory } from "@/hooks/useSidebarHistory";
import { useModalDialog } from "@/hooks/useModalDialog";
import { SessionSidebar } from "./SessionSidebar";
import { ToastProvider } from "./ui/toast";
import { toast } from "./ui/toast";
import { ConfirmDialog, Select } from "./ui/field";
import { ContextMenuHost } from "./ui/context-menu";
import { quoteMarkdown, type ContextMenuSection } from "@/lib/context-menu";
import { OPEN_TERMINAL_EVENT, type OpenTerminalDetail } from "@/lib/terminal-request";
import { ChatWindow } from "./ChatWindow";
import { PetCompanion } from "./PetCompanion";
import { WallpaperBackground } from "./WallpaperBackground";
import { MemoPanel } from "./MemoPanel";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";
import { AskpassDialog, focusAskpassRequest } from "./AskpassDialog";
import { AttentionCenter } from "./AttentionCenter";
import { useAskpassRequests } from "@/hooks/useAskpassRequests";
import { sortAttention, type AttentionItem } from "@/lib/attention";
import { openMemos } from "@/lib/memos";
import "./wallpapers.css";
import "./pets.css";
import type { PetActivity } from "@/lib/pets";
import { type Tab } from "./TabBar";
import { type FileExplorerHandle } from "./FileExplorer";
import type { RightPanelView } from "./RightPanel";
import { BranchNavigator } from "./BranchNavigator";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { CommandPaletteMount } from "./CommandPaletteMount";
import { Archive, Check, ChevronsLeft, ChevronsRight, Command, Ellipsis, Folder, History, Image as ImageIcon, Menu, MessageSquarePlus, PanelLeft, PanelRight, Settings, StickyNote, Terminal, Wand2, X, Zap } from "lucide-react";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { formatGenerationSpeed } from "@/lib/generation-speed";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsCompactOverlay } from "@/hooks/useIsCompactOverlay";
import { copyText } from "@/lib/clipboard";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { isFileWithinPath, type FileEditorStatus, type FileMutation } from "@/lib/file-editing";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import { comparableProjectPath } from "@/lib/comparable-path";
import { clearDraft } from "@/lib/draft-store";
import { showCompletionNotification } from "@/lib/browser-notifications";
import { playAttentionSound } from "@/hooks/useAudio";
import {
  APP_UPDATE_COMPLETED_RELOAD_MS,
  APP_UPDATE_POLL_MS,
  APP_UPDATE_PREPARING_MIN_MS,
  APP_UPDATE_STOPPING_POLL_MS,
  APP_UPDATE_TIMEOUT_MS,
  APP_UPDATE_VISIBLE_STAGE_MIN_MS,
  AppUpdateTransportError,
  COMPLETED_APP_UPDATE_KEY,
  DISMISSED_APP_UPDATE_KEY,
  fetchAppUpdateJson,
  isExactLegacyTargetCompletion,
  readDismissedVersion,
  rememberDismissedVersion,
  sanitizeAppUpdateError,
  waitForAppUpdateDwell,
} from "./AppShell-app-update";
import {
  PanelLoadingFallback,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampRightPanelWidth,
  clampSidebarWidth,
  loadRightPanelWidth,
  loadSidebarWidth,
  projectLabel,
  WorkspaceState,
  workspaceSelectOptions,
} from "./AppShell-layout";
import type { CrossSessionHostToolCall, ManagedProject, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { WebPluginInfo } from "@/lib/web-plugin-types";
import { readOpenPluginPage, writeOpenPluginPage, type OpenPluginPage } from "./PluginPage";
import { runHostTool } from "@/hooks/useAgentSession-stream";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo, GenerationSpeedInfo } from "@/lib/pi-types";
import type { AppearanceTab, SettingsTab } from "./SettingsTabs";
import { SettingsConfig } from "./SettingsConfig";
import { GenerationSpeedPanel } from "./GenerationSpeedPanel";
import {
  AppUpdateDialog,
  getAppUpdateStageIndex,
  getNextAppUpdateStage,
  getMonotonicAppUpdateStage,
  type AppUpdateInfo,
  type AppUpdatePhase,
  type AppUpdateStage,
} from "./AppUpdateDialog";
import { ArchiveBrowser } from "./ArchiveBrowser";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import { subscribeAppEvents } from "@/lib/app-events";
// The settings shell is part of the app bundle so opening it does not fetch or compile a modal chunk. The right panel (viewer included) remains on demand.
const RightPanel = dynamic(() => import("./RightPanel").then((m) => m.RightPanel), {
  ssr: false,
  loading: () => <PanelLoadingFallback />,
});

const TOOL_CALLS_COLLAPSED_STORAGE_KEY = "omp-web:tool-calls-collapsed";
const PROVIDER_USAGE_VISIBLE_STORAGE_KEY = "omp-web:provider-usage-visible";
const NATIVE_SELECT_ALL_STORAGE_KEY = "omp-web:scope-native-select-all";
const OPEN_URL_AUTOMATICALLY_STORAGE_KEY = "omp-web:open-url-automatically";
const OPEN_FILE_AUTOMATICALLY_STORAGE_KEY = "omp-web:open-file-automatically";


type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };
type TimerHandle = NodeJS.Timeout;

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const isCompactOverlay = useIsCompactOverlay();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [workspaceOptions, setWorkspaceOptions] = useState<{ projects: ManagedProject[]; selectedProject: string | null; cwd: string | null }>({ projects: [], selectedProject: null, cwd: null });
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const handleWorkspaceOptionsChange = useCallback((projects: ManagedProject[], selectedProject: string | null, cwd: string | null) => {
    setWorkspaceOptions({ projects, selectedProject, cwd });
  }, []);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [explorerRefreshing, setExplorerRefreshing] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [appearanceTab, setAppearanceTab] = useState<AppearanceTab>("display");
  const shortcutBindings = useShortcuts();
  const [petActivity, setPetActivity] = useState<PetActivity>({ sessionKey: "", state: "idle" });
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  // "Needs you" items: session dialogs (from the sidebar's running stream) and sudo prompts.
  const [sessionAttention, setSessionAttention] = useState<AttentionItem[]>([]);
  const [runningSessionCount, setRunningSessionCount] = useState(0);
  const askpassRequests = useAskpassRequests();
  const attentionItems = useMemo(() => sortAttention([
    ...sessionAttention,
    ...askpassRequests.map((request): AttentionItem => ({
      id: request.id,
      kind: "password",
      sessionId: request.sessionId,
      ...(request.sessionName ? { sessionName: request.sessionName } : {}),
      cwd: request.cwd,
      title: request.command.join(" "),
      createdAt: request.createdAt,
    })),
  ]), [sessionAttention, askpassRequests]);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Desktop: hide the chat so the right panel takes its room (sidebar unchanged).
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const updateChatCollapsed = useCallback((collapsed: boolean) => setChatCollapsed(collapsed), []);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const [toolCallsDefaultCollapsed, setToolCallsDefaultCollapsed] = useState(true);
  const [providerUsageVisible, setProviderUsageVisible] = useState(true);
  const [scopeNativeSelectAll, setScopeNativeSelectAll] = useState(false);
  const [openUrlAutomatically, setOpenUrlAutomatically] = useState(false);
  const [openFileAutomatically, setOpenFileAutomatically] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  // Active drag handlers so an unmount mid-drag can detach them.
  const sidebarResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  // DOM element + live width during a drag (see handleSidebarResizeStart).
  const sidebarContainerRef = useModalDialog<HTMLElement>({
    onClose: () => setSidebarOpen(false),
    active: isMobile && mobileSidebarReady && sidebarOpen && !settingsTab,
  });
  const pendingSidebarWidthRef = useRef<number>(SIDEBAR_DEFAULT_WIDTH);
  useEffect(() => {
    setSidebarWidth(loadSidebarWidth());
    try {
      setToolCallsDefaultCollapsed(window.localStorage.getItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY) !== "false");
      setProviderUsageVisible(window.localStorage.getItem(PROVIDER_USAGE_VISIBLE_STORAGE_KEY) !== "false");
      setScopeNativeSelectAll(window.localStorage.getItem(NATIVE_SELECT_ALL_STORAGE_KEY) === "true");
      setOpenUrlAutomatically(window.localStorage.getItem(OPEN_URL_AUTOMATICALLY_STORAGE_KEY) === "true");
      setOpenFileAutomatically(window.localStorage.getItem(OPEN_FILE_AUTOMATICALLY_STORAGE_KEY) === "true");
    } catch {
      // Keep the compact default when storage is unavailable.
    }
  }, []);
  const handleToolCallsDefaultCollapsedChange = useCallback((collapsed: boolean) => {
    setToolCallsDefaultCollapsed(collapsed);
    try {
      window.localStorage.setItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleProviderUsageVisibleChange = useCallback((visible: boolean) => {
    setProviderUsageVisible(visible);
    try {
      window.localStorage.setItem(PROVIDER_USAGE_VISIBLE_STORAGE_KEY, String(visible));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleScopeNativeSelectAllChange = useCallback((enabled: boolean) => {
    setScopeNativeSelectAll(enabled);
    try {
      window.localStorage.setItem(NATIVE_SELECT_ALL_STORAGE_KEY, String(enabled));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleOpenUrlAutomaticallyChange = useCallback((enabled: boolean) => {
    setOpenUrlAutomatically(enabled);
    try {
      window.localStorage.setItem(OPEN_URL_AUTOMATICALLY_STORAGE_KEY, String(enabled));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleOpenFileAutomaticallyChange = useCallback((enabled: boolean) => {
    setOpenFileAutomatically(enabled);
    try {
      window.localStorage.setItem(OPEN_FILE_AUTOMATICALLY_STORAGE_KEY, String(enabled));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  // Persist the committed width (after each change; skipped mid-drag, then
  // written once the drag ends). The first run is skipped so the mount-time
  // default cannot overwrite the stored width before it is loaded.
  const sidebarWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!sidebarWidthMountedRef.current) {
      sidebarWidthMountedRef.current = true;
      return;
    }
    if (sidebarResizing) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [sidebarWidth, sidebarResizing]);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [appUpdateDialogOpen, setAppUpdateDialogOpen] = useState(false);
  const [appUpdatePhase, setAppUpdatePhase] = useState<AppUpdatePhase>("idle");
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const appUpdateAttemptRef = useRef<string | null>(null);
  const appUpdateStartInFlightRef = useRef(false);
  const appUpdateCompletingRef = useRef(false);
  const [appUpdateVisibleStage, setAppUpdateVisibleStage] = useState<AppUpdateStage | undefined>();
  const appUpdateVisibleStageRef = useRef<AppUpdateStage | undefined>(undefined);
  const appUpdateVisibleStageStartedAtRef = useRef<number | null>(null);
  const appUpdateCommittedAttemptRef = useRef<string | null>(null);
  const appUpdateRecoveryCommitAttemptRef = useRef<string | null>(null);
  const appUpdateStageFlowRef = useRef(0);
  const appUpdateAcknowledgementsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const advanceAppUpdateVisibleStage = useCallback((next: AppUpdateStage) => {
    const visible = getMonotonicAppUpdateStage(appUpdateVisibleStageRef.current, next);
    if (visible === appUpdateVisibleStageRef.current) return;
    appUpdateVisibleStageRef.current = visible;
    appUpdateVisibleStageStartedAtRef.current = Date.now();
    setAppUpdateVisibleStage(visible);
  }, []);
  const resetAppUpdateVisibleStage = useCallback(() => {
    appUpdateVisibleStageRef.current = undefined;
    appUpdateStageFlowRef.current += 1;
    appUpdateVisibleStageStartedAtRef.current = null;
    appUpdateCommittedAttemptRef.current = null;
    appUpdateRecoveryCommitAttemptRef.current = null;
    setAppUpdateVisibleStage(undefined);
    setAppUpdate((current) => current?.appUpdateDrain
      ? { ...current, appUpdateDrain: undefined }
      : current);
  }, []);
  const showAppUpdateStagesThrough = useCallback(async (target: AppUpdateStage) => {
    const stageFlow = appUpdateStageFlowRef.current;
    const targetIndex = getAppUpdateStageIndex(target);
    if (appUpdateVisibleStageRef.current === undefined) {
      advanceAppUpdateVisibleStage(target);
      return;
    }
    while (true) {
      const current = appUpdateVisibleStageRef.current;
      if (current === undefined || getAppUpdateStageIndex(current) >= targetIndex) return;
      await waitForAppUpdateDwell(
        appUpdateVisibleStageStartedAtRef.current,
        current === "preparing" ? APP_UPDATE_PREPARING_MIN_MS : APP_UPDATE_VISIBLE_STAGE_MIN_MS,
      );
      if (appUpdateStageFlowRef.current !== stageFlow) return;
      const latest = appUpdateVisibleStageRef.current;
      if (latest === undefined || getAppUpdateStageIndex(latest) >= targetIndex) return;
      const next = getNextAppUpdateStage(latest);
      if (next === undefined) return;
      advanceAppUpdateVisibleStage(next);
    }
  }, [advanceAppUpdateVisibleStage]);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  // Chrome does not blur a focused descendant when a subtree becomes
  // aria-hidden + inert (e.g. tapping a session button closes the mobile
  // drawer), which leaves focus trapped where assistive tech cannot see it.
  // Blur synchronously in the same commit so the AX tree never observes a
  // focused element inside the hidden sidebar.
  useLayoutEffect(() => {
    if (sidebarOpen || !mobileSidebarReady) return;
    const container = sidebarContainerRef.current;
    const active = document.activeElement;
    if (container && active instanceof HTMLElement && container.contains(active)) {
      active.blur();
    }
  }, [sidebarOpen, mobileSidebarReady, sidebarContainerRef]);
  const refreshAppUpdate = useCallback(async (force = false, autoOpen = false): Promise<AppUpdateInfo | null> => {
    const data = await fetchAppUpdateJson<AppUpdateInfo>(
      force ? "/api/app-update?force=1" : "/api/app-update",
      { cache: "no-store" },
    );
    if (
      autoOpen
      && (appUpdateStartInFlightRef.current || appUpdateAttemptRef.current !== null || appUpdateCompletingRef.current)
    ) return null;

    setAppUpdate(data);

    if (autoOpen && !data.selfUpdateStatus && data.updateAvailable && data.availableVersion) {
      if (data.selfUpdateSupported === true) {
        if (readDismissedVersion(DISMISSED_APP_UPDATE_KEY) !== data.availableVersion) {
          setAppUpdatePhase("idle");
          setAppUpdateError(null);
          setAppUpdateDialogOpen(true);
        }
      } else {
        const cmd = data.updateCommand || "npm install -g @kahme247/ompweb";
        const version = data.availableVersion;
        if (readDismissedVersion(DISMISSED_APP_UPDATE_KEY) === version) return data;
        toast.info(
          translate("appShell.appUpdateAvailable"),
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div>{translate("appShell.updateVersion", { current: data.currentVersion ?? "?", available: data.availableVersion })}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <code style={{ background: "var(--bg-panel)", padding: "3px 7px", borderRadius: "var(--radius-control)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                {cmd}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copyText(cmd)
                    .then(() => toast.success(translate("appShell.commandCopied")))
                    .catch(() => toast.error(translate("appShell.commandCopyFailed")));
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
              >
                {translate("appShell.copyCommand")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettingsTab("system");
                  toast.close("app-update-available");
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
              >
                {translate("settingsConfig.appUpdateAction")}
              </button>
            </div>
          </div>,
          { id: "app-update-available", timeout: 0, onClose: () => rememberDismissedVersion(DISMISSED_APP_UPDATE_KEY, version) }
        );
      }
    }
    return data;
  }, []);

  const acknowledgeAppUpdate = useCallback((attemptId: string): Promise<boolean> => {
    const existing = appUpdateAcknowledgementsRef.current.get(attemptId);
    if (existing) return existing;
    const request = (async () => {
      try {
        const response = await fetch("/api/app-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "acknowledge", attemptId }),
        });
        return response.ok;
      } catch {
        return false;
      }
    })();
    appUpdateAcknowledgementsRef.current.set(attemptId, request);
    void request.then((acknowledged) => {
      if (!acknowledged && appUpdateAcknowledgementsRef.current.get(attemptId) === request) {
        appUpdateAcknowledgementsRef.current.delete(attemptId);
      }
    });
    return request;
  }, []);

  const showAppUpdateFailure = useCallback((error: unknown) => {
    appUpdateAttemptRef.current = null;
    appUpdateStartInFlightRef.current = false;
    appUpdateCommittedAttemptRef.current = null;
    setAppUpdateError(sanitizeAppUpdateError(error) || null);
    setAppUpdatePhase("failed");
    appUpdateStageFlowRef.current += 1;
    setAppUpdateDialogOpen(true);
  }, []);

  const submitAppUpdateCommit = useCallback((attemptId: string) => {
    void fetchAppUpdateJson<{ error?: string }>("/api/app-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "commit", attemptId }),
      keepalive: true,
    }, 202).then(() => {
      if (appUpdateAttemptRef.current === attemptId) {
        appUpdateCommittedAttemptRef.current = attemptId;
      }
    }).catch((error) => {
      if (error instanceof AppUpdateTransportError) {
        if (appUpdateRecoveryCommitAttemptRef.current === attemptId) {
          appUpdateRecoveryCommitAttemptRef.current = null;
        }
        return;
      }
      if (appUpdateAttemptRef.current !== attemptId) return;
      showAppUpdateFailure(error);
    });
  }, [showAppUpdateFailure]);

  const recoverPreparedAppUpdate = useCallback((data: AppUpdateInfo, attemptId: string) => {
    const status = data.selfUpdateStatus;
    if (
      status?.attemptId !== attemptId
      || status.state !== "prepared"
      || (status.stage !== "preparing" && status.stage !== "stopping")
    ) return;
    if (appUpdateRecoveryCommitAttemptRef.current === attemptId) return;
    appUpdateRecoveryCommitAttemptRef.current = attemptId;
    submitAppUpdateCommit(attemptId);
  }, [submitAppUpdateCommit]);

  const completeAppUpdate = useCallback(async (targetVersion: string) => {
    if (appUpdateCompletingRef.current) return;
    appUpdateCompletingRef.current = true;
    appUpdateAttemptRef.current = null;
    appUpdateCommittedAttemptRef.current = null;
    appUpdateStartInFlightRef.current = false;
    await showAppUpdateStagesThrough("finalizing");
    await waitForAppUpdateDwell(appUpdateVisibleStageStartedAtRef.current, APP_UPDATE_VISIBLE_STAGE_MIN_MS);
    setAppUpdateError(null);
    setAppUpdatePhase("completed");
    setAppUpdateDialogOpen(true);
    try {
      window.sessionStorage.setItem(COMPLETED_APP_UPDATE_KEY, JSON.stringify({ version: targetVersion }));
    } catch {}
    await new Promise<void>((resolve) => window.setTimeout(resolve, APP_UPDATE_COMPLETED_RELOAD_MS));
    appUpdateRecoveryCommitAttemptRef.current = null;
    window.location.reload();
  }, [showAppUpdateStagesThrough]);

  const handleTerminalAppUpdate = useCallback(async (
    data: AppUpdateInfo,
    attemptId: string,
    targetVersion: string,
  ): Promise<boolean> => {
    const status = data.selfUpdateStatus;
    if (status?.attemptId !== attemptId || status.cleanupReady !== true) return false;
    if (status.state === "failed") {
      if (!await acknowledgeAppUpdate(attemptId)) return false;
      showAppUpdateFailure(status.error);
      return true;
    }
    if (status.state === "succeeded" && data.currentVersion === targetVersion) {
      if (!await acknowledgeAppUpdate(attemptId)) return false;
      await completeAppUpdate(targetVersion);
      return true;
    }
    return false;
  }, [acknowledgeAppUpdate, completeAppUpdate, showAppUpdateFailure]);

  const monitorAppUpdate = useCallback(async (attemptId: string, targetVersion: string) => {
    if (appUpdateAttemptRef.current === attemptId) return;
    appUpdateAttemptRef.current = attemptId;
    const deadline = Date.now() + APP_UPDATE_TIMEOUT_MS;
    while (appUpdateAttemptRef.current === attemptId && Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(
        resolve,
        appUpdateVisibleStageRef.current === "stopping" ? APP_UPDATE_STOPPING_POLL_MS : APP_UPDATE_POLL_MS,
      ));
      try {
        const data = await refreshAppUpdate();
        if (!data) continue;
        const status = data.selfUpdateStatus;
        if (status?.attemptId === attemptId && status.stage !== undefined) {
          if (status.stage !== "preparing") appUpdateCommittedAttemptRef.current = attemptId;
          await showAppUpdateStagesThrough(status.stage);
        }
        recoverPreparedAppUpdate(data, attemptId);
        if (await handleTerminalAppUpdate(data, attemptId, targetVersion)) return;
        if (isExactLegacyTargetCompletion(data, targetVersion)) {
          // Legacy targets do not expose the status/acknowledge contract. Exact
          // version equality is the completion proof; updater artifacts expire
          // through the backend's terminal-status TTL instead of UI cleanup.
          await completeAppUpdate(targetVersion);
          return;
        }
      } catch (error) {
        if (error instanceof AppUpdateTransportError) {
          if (appUpdateCommittedAttemptRef.current === attemptId) {
            advanceAppUpdateVisibleStage("installing");
          }
          // Connection failures are expected after commit while the server is offline.
          continue;
        }
        showAppUpdateFailure(error);
        return;
      }
    }
    if (appUpdateAttemptRef.current === attemptId) {
      showAppUpdateFailure(t("appUpdateDialog.timeout"));
    }
  }, [advanceAppUpdateVisibleStage, completeAppUpdate, handleTerminalAppUpdate, recoverPreparedAppUpdate, refreshAppUpdate, showAppUpdateFailure, showAppUpdateStagesThrough, t]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(COMPLETED_APP_UPDATE_KEY);
      if (raw) {
        const completed = JSON.parse(raw) as { version?: unknown };
        window.sessionStorage.removeItem(COMPLETED_APP_UPDATE_KEY);
        if (typeof completed.version === "string") {
          toast.success(t("appUpdateDialog.completed", { version: completed.version }));
        }
      }
    } catch {}
    void refreshAppUpdate(false, true)
      .then(async (data) => {
        const status = data?.selfUpdateStatus;
        if (!data || !status) return;
        const recoveredStage = status.stage ?? "stopping";
        const initialStage = recoveredStage === "preparing" ? "preparing" : "stopping";
        if (initialStage === "stopping") appUpdateCommittedAttemptRef.current = status.attemptId;
        advanceAppUpdateVisibleStage(initialStage);
        setAppUpdatePhase(initialStage === "preparing" ? "preparing" : "restarting");
        setAppUpdateDialogOpen(true);
        await showAppUpdateStagesThrough(recoveredStage);
        if (await handleTerminalAppUpdate(data, status.attemptId, status.targetVersion)) return;
        void monitorAppUpdate(status.attemptId, status.targetVersion);
        recoverPreparedAppUpdate(data, status.attemptId);
      })
      .catch(() => {});
  }, [advanceAppUpdateVisibleStage, handleTerminalAppUpdate, monitorAppUpdate, recoverPreparedAppUpdate, refreshAppUpdate, showAppUpdateStagesThrough, t]);

  const proceedWithAppUpdate = useCallback(async () => {
    if (appUpdateStartInFlightRef.current) return;
    appUpdateStartInFlightRef.current = true;
    appUpdateCompletingRef.current = false;
    resetAppUpdateVisibleStage();
    advanceAppUpdateVisibleStage("preparing");
    setAppUpdatePhase("preparing");
    setAppUpdateError(null);
    try {
      const prepared = await fetchAppUpdateJson<{ attemptId?: string; targetVersion?: string }>("/api/app-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare" }),
      });
      if (!prepared.attemptId || !prepared.targetVersion) {
        throw new Error("Invalid update response");
      }
      submitAppUpdateCommit(prepared.attemptId);
      void monitorAppUpdate(prepared.attemptId, prepared.targetVersion);
      await showAppUpdateStagesThrough("stopping");
      if (appUpdateAttemptRef.current !== prepared.attemptId) return;
      setAppUpdatePhase("restarting");
    } catch (error) {
      showAppUpdateFailure(error);
    }
  }, [advanceAppUpdateVisibleStage, monitorAppUpdate, resetAppUpdateVisibleStage, showAppUpdateFailure, showAppUpdateStagesThrough, submitAppUpdateCommit]);

  const availableAppVersion = appUpdate?.availableVersion;
  const dismissAppUpdate = useCallback(() => {
    if (appUpdatePhase === "idle" && availableAppVersion) {
      rememberDismissedVersion(DISMISSED_APP_UPDATE_KEY, availableAppVersion);
      toast.info(t("appUpdateDialog.settingsLater"));
    }
    setAppUpdateDialogOpen(false);
    setAppUpdatePhase("idle");
    setAppUpdateError(null);
    appUpdateAttemptRef.current = null;
    resetAppUpdateVisibleStage();
  }, [availableAppVersion, appUpdatePhase, resetAppUpdateVisibleStage, t]);

  const requestAppUpdateFromSettings = useCallback(() => {
    setSettingsTab(null);
    resetAppUpdateVisibleStage();
    setAppUpdateError(null);
    setAppUpdatePhase("idle");
    window.requestAnimationFrame(() => setAppUpdateDialogOpen(true));
  }, [resetAppUpdateVisibleStage]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);
  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemPromptLoading(false);
  }, []);

  const handleSystemPromptLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemPromptLoadIdRef.current += 1;
    systemPromptLoaderRef.current = loader;
    setSystemPromptLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<TimerHandle | undefined>(undefined);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const archiveRetryTimerRef = useRef<TimerHandle | undefined>(undefined);
  useEffect(() => () => clearTimeout(archiveRetryTimerRef.current), []);
  useLayoutEffect(() => {
    activeSessionIdRef.current = selectedSession?.id ?? null;
  }, [selectedSession?.id]);
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "speed" | null>(null);
  const mobileToolsRef = useRef<HTMLDetailsElement>(null);
  const mobileToolsContentRef = useRef<HTMLDivElement>(null);
  const restoreToolsFocusRef = useRef(false);
  const [compactTopbar, setCompactTopbar] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (compactTopbar && restoreToolsFocusRef.current) {
      mobileToolsRef.current?.querySelector("summary")?.focus();
      restoreToolsFocusRef.current = false;
    }
  }, [compactTopbar]);
  useEffect(() => {
    if (!compactTopbar) return;
    const closeOnOutside = (event: PointerEvent) => {
      const tools = mobileToolsRef.current;
      if (tools?.open && !tools.contains(event.target as Node)) {
        tools.open = false;
        setActiveTopPanel(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const tools = mobileToolsRef.current;
      // Nested pickers and session panels handle their own Escape first.
      if (event.key !== "Escape" || event.defaultPrevented || activeTopPanel || !tools?.open) return;
      event.stopPropagation();
      tools.open = false;
      tools.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [compactTopbar, activeTopPanel]);
  const toggleTopPanel = useCallback((panel: "branches" | "system" | "speed") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  // Generation speed — current live t/s and the session average.
  const [generationSpeed, setGenerationSpeed] = useState<GenerationSpeedInfo | null>(null);
  const handleGenerationSpeedChange = useCallback((speed: GenerationSpeedInfo | null) => {
    setGenerationSpeed(speed);
  }, []);
  const handleSystemPromptToggle = useCallback(() => {
    const opening = activeTopPanel !== "system";
    toggleTopPanel("system");
    if (!opening || systemPromptLoading || systemPrompt !== null) return;

    const load = systemPromptLoaderRef.current;
    if (!load) return;
    const loadId = ++systemPromptLoadIdRef.current;
    setSystemPromptLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system prompt:", error);
    }).finally(() => {
      if (systemPromptLoadIdRef.current === loadId) setSystemPromptLoading(false);
    });
  }, [activeTopPanel, systemPrompt, systemPromptLoading, toggleTopPanel]);

  // The topbar session panel is gone (its content lives in the composer ring
  // popover), so /session opens that instead.
  const openSessionStatsPanel = useCallback(() => {
    chatInputRef.current?.openContextPanel();
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      if (mobileToolsRef.current) mobileToolsRef.current.open = false;
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  const changeSidebarWidth = useCallback((delta: number) => {
    setSidebarWidth((prev) => clampSidebarWidth(prev + delta));
  }, []);

  const handleSidebarResizeKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      changeSidebarWidth(-10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeSidebarWidth(10);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetSidebarWidth();
    }
  }, [changeSidebarWidth, resetSidebarWidth]);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    // Interface Scale (html[data-ui-scale] zoom) leaves clientX in viewport
    // pixels while the sidebar width is zoomed layout pixels: scale the drag
    // delta so the edge tracks the pointer at any zoom (same --ui-scale
    // ground truth as the zoom-aware menus in SessionSidebar-chrome).
    let uiScale = 1;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const value = parseFloat(raw);
      if (Number.isFinite(value) && value > 0) uiScale = value;
    } catch {
      // SSR/unavailable: fall back to unscaled math.
    }
    setSidebarResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = clampSidebarWidth(startWidth + (ev.clientX - startX) / uiScale);
      // Write the CSS variable straight to the DOM: the flex row follows the
      // pointer without re-rendering the whole AppShell on every mousemove.
      sidebarContainerRef.current?.style.setProperty("--sidebar-width", `${next}px`);
      pendingSidebarWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidebarResizeHandlersRef.current = null;
      setSidebarResizing(false);
      // Commit the final width so state and the persisted value agree with
      // what the user actually dragged to.
      setSidebarWidth(pendingSidebarWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingSidebarWidthRef.current = startWidth;
    sidebarResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile, sidebarWidth, sidebarContainerRef]);

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(() => () => {
    const handlers = sidebarResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    sidebarResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelHasOpened, setRightPanelHasOpened] = useState(false);
  const [rightView, setRightView] = useState<RightPanelView>("explorer");
  // User-chosen pixel width (null = fluid 42% default), persisted.
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelRef = useModalDialog<HTMLDivElement>({
    onClose: () => setRightPanelOpen(false),
    active: isCompactOverlay && rightPanelHasOpened && rightPanelOpen && !settingsTab,
  });
  const rightPanelIsModal = isCompactOverlay && rightPanelHasOpened && rightPanelOpen && !settingsTab;
  /** The chat pane is collapsed and the (desktop) right panel fills its room. */
  const chatHidden = chatCollapsed && rightPanelOpen && !isMobile && !isCompactOverlay && !settingsTab;
  // Closing the right panel brings the chat back rather than leaving the collapse armed.
  useEffect(() => {
    if (!rightPanelOpen) setChatCollapsed(false);
  }, [rightPanelOpen]);
  // Web plugin page: a right-panel tab beside Explorer/Git/Terminal/System
  // (kept mounted while another tab is shown, so it keeps its state).
  const [openPlugin, setOpenPlugin] = useState<OpenPluginPage | null>(null);
  const [pluginFrameKey, setPluginFrameKey] = useState(0);
  useEffect(() => {
    setOpenPlugin(readOpenPluginPage());
  }, []);
  useEffect(() => {
    writeOpenPluginPage(openPlugin);
  }, [openPlugin]);
  const handleOpenPlugin = useCallback((plugin: WebPluginInfo) => {
    setOpenPlugin((current) => current?.id === plugin.id && current.entryUrl === plugin.entryUrl
      ? current
      : { id: plugin.id, name: plugin.name, entryUrl: plugin.entryUrl, iconUrl: plugin.iconUrl });
    setSettingsTab(null);
    setRightView("plugin");
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  /** Close the plugin tab (any plugin, or only `id` when it is the open one). */
  const handleClosePlugin = useCallback((id?: string) => {
    setOpenPlugin((current) => (id === undefined || current?.id === id ? null : current));
    setRightView((view) => (view === "plugin" ? "explorer" : view));
  }, []);
  const handleReloadPlugin = useCallback(() => setPluginFrameKey((key) => key + 1), []);
  const pendingRightPanelWidthRef = useRef<number | null>(null);
  const rightResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  useEffect(() => {
    setRightPanelWidth(loadRightPanelWidth());
  }, []);
  useEffect(() => {
    if (rightPanelOpen) setRightPanelHasOpened(true);
  }, [rightPanelOpen]);
  const resetRightPanelWidth = useCallback(() => {
    rightPanelRef.current?.style.removeProperty("--right-panel-width");
    setRightPanelWidth(null);
  }, [rightPanelRef]);

  const changeRightPanelWidth = useCallback((delta: number) => {
    setRightPanelWidth((prev) => {
      // Keyboard steps from the fluid default start at the panel's live
      // width so the first press doesn't jump to the clamp minimum.
      const base = prev ?? rightPanelRef.current?.getBoundingClientRect().width ?? RIGHT_PANEL_MIN_WIDTH;
      const next = clampRightPanelWidth(base + delta);
      rightPanelRef.current?.style.setProperty("--right-panel-width", `${next}px`);
      return next;
    });
  }, [rightPanelRef]);

  const handleRightPanelResizeKey = useCallback((e: React.KeyboardEvent) => {
    // The handle sits on the panel's left edge: left widens, right narrows.
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      changeRightPanelWidth(10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeRightPanelWidth(-10);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetRightPanelWidth();
    }
  }, [changeRightPanelWidth, resetRightPanelWidth]);

  const handleRightPanelResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    // Live rect, not state: it always reflects the committed width (custom or
    // fluid default), and keeps this callback above the state declarations
    // without a TDZ cycle. The handle only exists while the panel is open.
    const startWidth = rightPanelRef.current?.getBoundingClientRect().width
      ?? RIGHT_PANEL_MIN_WIDTH;
    // Same --ui-scale ground truth as the left sidebar handle: clientX is in
    // viewport pixels while the panel width is zoomed layout pixels.
    let uiScale = 1;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const value = parseFloat(raw);
      if (Number.isFinite(value) && value > 0) uiScale = value;
    } catch {
      // SSR/unavailable: fall back to unscaled math.
    }
    setRightPanelResizing(true);
    const onMove = (ev: MouseEvent) => {
      // Dragging the left edge left grows the panel: inverse of the sidebar.
      const next = clampRightPanelWidth(startWidth - (ev.clientX - startX) / uiScale);
      // Write the CSS variable straight to the DOM: the flex row follows the
      // pointer without re-rendering the whole AppShell on every mousemove.
      rightPanelRef.current?.style.setProperty("--right-panel-width", `${next}px`);
      pendingRightPanelWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      rightResizeHandlersRef.current = null;
      setRightPanelResizing(false);
      // Commit the final width so state and the persisted value agree with
      // what the user actually dragged to.
      setRightPanelWidth(pendingRightPanelWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingRightPanelWidthRef.current = startWidth;
    rightResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile, rightPanelRef]);

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(() => () => {
    const handlers = rightResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    rightResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);


  // Dismiss topbar dropdowns first; don't propagate into application shortcuts.
  useEffect(() => {
    // The branch panel manages its own outside-click and Escape dismissal.
    if (!activeTopPanel || activeTopPanel === "branches") return;
    const onPointerDown = (event: MouseEvent) => {
      // InfoHint popups are portaled; clicking one stays inside the panel.
      if (event.target instanceof Element && event.target.closest("[data-top-panel], .info-hint-popup")) return;
      setActiveTopPanel(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setActiveTopPanel(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeTopPanel]);

  // Right panel tabs: Explorer | Git changes | open files (Tauri parity).
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [fileEditorStates, setFileEditorStates] = useState<Map<string, FileEditorStatus>>(new Map());
  const [pendingFileClose, setPendingFileClose] = useState<string[] | null>(null);
  const handleFileEditorState = useCallback((filePath: string, status: FileEditorStatus) => {
    setFileEditorStates((previous) => {
      if ((previous.get(filePath) ?? "clean") === status) return previous;
      const next = new Map(previous);
      if (status === "clean") next.delete(filePath); else next.set(filePath, status);
      return next;
    });
  }, []);
  useEffect(() => {
    if (fileEditorStates.size === 0) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [fileEditorStates.size]);
  // One-shot request asking the explorer tab to expand + scroll to a file.
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [explorerGitCount, setExplorerGitCount] = useState(0);
  const [explorerIsRepo, setExplorerIsRepo] = useState(false);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const handleExplorerGitStatus = useCallback((changedCount: number, isRepo: boolean) => {
    setExplorerGitCount(changedCount);
    setExplorerIsRepo(isRepo);
  }, []);
  // Same guard as the left sidebar: skip the mount run and mid-drag writes. A
  // reset (null) removes the key so the fluid default returns.
  const rightPanelWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!rightPanelWidthMountedRef.current) {
      rightPanelWidthMountedRef.current = true;
      return;
    }
    if (rightPanelResizing) return;
    try {
      if (rightPanelWidth === null) window.localStorage.removeItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
      else window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [rightPanelWidth, rightPanelResizing]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // During the initial URL restore the sidebar adopts the restored cwd and
  // notifies us; that first onCwdChange must not bump sessionKey. We store the
  // expected cwd string and only skip when it matches, so a failure to fire
  // can't leave the suppression armed for the user's next genuine switch.
  const suppressCwdRef = useRef<string | null>(null);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string; code?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error || data.code ? formatApiError(data) : `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdRef.current = data.cwd;
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd) return;
    // Skip only when the notification matches the cwd we're suppressing for.
    if (suppressCwdRef.current !== null && suppressCwdRef.current === cwd) {
      suppressCwdRef.current = null;
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    // Compare case-folded: the same folder can be spelled with different
    // casing (Windows/NTFS) between the session's projectRoot and the
    // sidebar's resolved project root.
    const newProject = projectRoot ?? cwd;
    const sessionProject = selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null;
    if (sessionProject && comparableProjectPath(sessionProject) === comparableProjectPath(newProject)) {
      return;
    }
    // Already showing this cwd's new chat (handleOpenWorkspace got there first).
    if (!selectedSession && newSessionCwd === cwd) return;
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router, selectedSession, newSessionCwd]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Re-picking the already-open session (sidebar double-click, palette
    // re-select, notification click) must not bump sessionKey: that remounts
    // ChatWindow, reconnects SSE, and drops the mid-run streaming view.
    setSettingsTab(null);
    if (!isRestore) updateChatCollapsed(false);
    // Re-picking the current conversation still closes/rearms the drawer,
    // without remounting the chat or disturbing its draft.
    if (isMobile && !isRestore) {
      setSidebarOpen(false);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    }
    if (!isRestore && session.id === selectedSession?.id) return;
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar. We
      // arm the expected cwd (compared in handleCwdChange) rather than a
      // sticky flag so a missed notification can't suppress the next
      // genuine project switch.
      suppressCwdRef.current = session.cwd;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile, selectedSession?.id, updateChatCollapsed]);

  const showNewChat = useCallback((cwd: string) => {
    setSettingsTab(null);
    updateChatCollapsed(false);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router, updateChatCollapsed]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    showNewChat(cwd);
    if (isMobile) {
      setSidebarOpen(false);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    }
  }, [showNewChat, isMobile]);

  // Workspace header click. Unlike the cwd sync it also leaves an open session
  // of that same workspace; the mobile drawer stays open to browse its sessions.
  const handleOpenWorkspace = useCallback((cwd: string) => {
    if (!selectedSession && (newSessionCwd ?? activeCwd) === cwd) {
      setSettingsTab(null);
      return;
    }
    showNewChat(cwd);
  }, [showNewChat, selectedSession, newSessionCwd, activeCwd]);

  // Leave settings and open a session known only by id (attention items,
  // scheduled task runs). The sidebar list supplies its metadata when it has it.
  const openSessionById = useCallback(async (sessionId: string, cwd: string, sessionName?: string) => {
    setSettingsTab(null);
    if (sessionId === selectedSession?.id) {
      if (isMobile) setSidebarOpen(false);
      return;
    }
    let session: SessionInfo | undefined;
    try {
      const response = await fetch("/api/sessions");
      if (response.ok) session = (await response.json() as { sessions: SessionInfo[] }).sessions.find((s) => s.id === sessionId);
    } catch {
      // Fall back to a transient entry; the chat loads by id either way.
    }
    handleSelectSession(session ?? {
      id: sessionId,
      path: "",
      cwd,
      ...(sessionName ? { name: sessionName } : {}),
      created: "",
      modified: "",
      messageCount: 0,
      firstMessage: "",
    });
  }, [selectedSession?.id, isMobile, handleSelectSession]);

  // Jump to where an attention item can be answered: its session shows the
  // pending dialog above the composer (replayed on connect).
  // A sudo prompt is answered in its floating card wherever you are; other items need their chat.
  const handleOpenAttention = useCallback((item: AttentionItem) => {
    if (item.kind === "password") {
      focusAskpassRequest(item.id);
      return;
    }
    return openSessionById(item.sessionId, item.cwd, item.sessionName);
  }, [openSessionById]);

  const handleOpenScheduledRun = useCallback((sessionId: string, cwd: string) => {
    void openSessionById(sessionId, cwd);
  }, [openSessionById]);

  // New dialogs and sudo prompts chime once per batch (visible or not); a background tab
  // also gets an OS notification for each new dialog (sudo prompts notify from
  // AskpassDialog). Never asks for permission here.
  const notifiedAttentionRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const seen = notifiedAttentionRef.current;
    const current = new Set(attentionItems.map((item) => item.id));
    for (const id of seen) if (!current.has(id)) seen.delete(id);
    if (attentionItems.some((item) => !seen.has(item.id))) playAttentionSound();
    for (const item of attentionItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (item.kind === "password" || document.visibilityState === "visible") continue;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
      showCompletionNotification(t("attention.notificationTitle"), `${item.title || t(`attention.kind.${item.kind}`)} — ${item.sessionName || getFileName(item.cwd)}`, () => {
        window.focus();
        void handleOpenAttention(item);
      });
    }
  }, [attentionItems, handleOpenAttention, t]);


  // Configurable global shortcuts, including stop and new session.
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
    scopeNativeSelectAll,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (document.visibilityState !== "hidden" || !("Notification" in window)) return;

    const targetSession = selectedSession;
    const notify = () => {
      showCompletionNotification(
        targetSession?.name ?? translate("appShell.sessionComplete"),
        translate("appShell.taskFinished"),
        () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      );
    };
    if (Notification.permission === "granted") notify();
    else if (Notification.permission === "default") {
      void Notification.requestPermission().then((permission) => { if (permission === "granted") notify(); });
    } else {
      // "denied": the OS blocks notifications, so surface the completion as an
      // in-app toast instead of leaving background completions silent.
      toast.info(targetSession?.name ?? translate("appShell.sessionComplete"), translate("appShell.taskFinished"));
    }
  }, [handleSelectSession, selectedSession]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string; code?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || body.code ? formatApiError(body) : `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      if (activeSessionIdRef.current !== sessionId) return;
      setRefreshKey((key) => key + 1);
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshing(true);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleExplorerRefreshDone = useCallback(() => {
    setExplorerRefreshing(false);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      // path === "" is the sidebar's optimistic-row marker; keep it so the
      // fork shows up immediately instead of waiting for a refresh.
      path: "",
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    // The composer for this session can never be reopened, so its draft would
    // otherwise keep the exit guard armed for unreachable content.
    clearDraft(sessionId);
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);
  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleArchiveRestored = useCallback(async (sessionId: string) => {
    setArchiveBrowserOpen(false);
    publishSessionsChanged([sessionId]);
    setRefreshKey((k) => k + 1);

    // The poll must not yank the UI back to the restored session if the user
    // picks another one while we wait, and an untracked setTimeout chain would
    // keep retrying after unmount — so freeze the selection at start, bail out
    // of every attempt + the fallback when it changed, and track the timer.
    const sessionAtRestoreStart = activeSessionIdRef.current;
    const selectRestoredSession = async (attemptsLeft = 5): Promise<void> => {
      if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const data = (await res.json()) as { sessions?: SessionInfo[] };
          const found = data.sessions?.find((s) => s.id === sessionId);
          if (found) {
            if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
            handleSelectSession(found, false);
            return;
          }
        }
      } catch {
        // network error / abort
      }

      if (attemptsLeft > 0) {
        archiveRetryTimerRef.current = setTimeout(() => void selectRestoredSession(attemptsLeft - 1), 300);
      } else if (activeSessionIdRef.current === sessionAtRestoreStart) {
        router.replace(`?session=${encodeURIComponent(sessionId)}`, { scroll: false });
      }
    };

    void selectRestoredSession();
  }, [handleSelectSession, router]);

  const closeFileTabs = useCallback((ids: string[]) => {
    const closed = new Set(ids);
    const next = fileTabs.filter((tab) => !closed.has(tab.id));
    setFileTabs(next);
    if (next.length === 0) setRightView("explorer");
    setActiveFileTabId((current) => current && closed.has(current) ? next.at(-1)?.id ?? null : current);
    setPendingFileClose(null);
  }, [fileTabs]);

  const requestCloseFileTabs = useCallback((ids: string[]) => {
    const affected = fileTabs.filter((tab) => ids.includes(tab.id));
    if (affected.some((tab) => fileEditorStates.get(tab.filePath) === "saving")) {
      toast.info(t("fileEditing.saving"));
    } else if (affected.some((tab) => fileEditorStates.has(tab.filePath))) {
      setPendingFileClose(ids);
    } else closeFileTabs(ids);
  }, [fileTabs, fileEditorStates, closeFileTabs, t]);

  const handleCloseFileTab = useCallback((id: string) => requestCloseFileTabs([id]), [requestCloseFileTabs]);

  const handleBeforeFileMutation = useCallback((paths: string[]) => {
    if ([...fileEditorStates.keys()].some((file) => paths.some((target) => isFileWithinPath(file, target)))) {
      toast.error(t("fileEditing.finishEdits"));
      return false;
    }
    return true;
  }, [fileEditorStates, t]);

  const handleFileMutation = useCallback(({ path, newPath }: FileMutation) => {
    const remap = (tab: Tab): Tab | null => {
      if (!isFileWithinPath(tab.filePath, path)) return tab;
      if (!newPath) return null;
      const filePath = newPath + tab.filePath.slice(path.length);
      return { ...tab, filePath, id: `file:${filePath}`, label: getFileName(filePath) };
    };
    const next = [...new Map(fileTabs.map(remap).filter((tab): tab is Tab => tab !== null).map((tab) => [tab.id, tab])).values()];
    const active = fileTabs.find((tab) => tab.id === activeFileTabId);
    setFileTabs(next);
    setActiveFileTabId(active ? remap(active)?.id ?? next.at(-1)?.id ?? null : null);
    if (!next.length) setRightView("explorer");
    setExplorerRefreshKey((key) => key + 1);
  }, [fileTabs, activeFileTabId]);

  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) return [...prev, { id: tabId, label: fileName, filePath, sourceSessionId }];
      if (!sourceSessionId || existing.sourceSessionId === sourceSessionId) return prev;
      return prev.map((t) => t.id === tabId ? { ...t, sourceSessionId } : t);
    });
    setActiveFileTabId(tabId);
    setRightView("file");
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // URLs from other sessions always ask. Files from other sessions ask unless
  // the user explicitly allows automatic file opening. The separate URL
  // preference only covers the viewed session; confirmation supplies the
  // user gesture needed by browser pop-up blockers.
  const [pendingOpens, setPendingOpens] = useState<Array<{ kind: "url" | "file"; target: string; name: string; sessionId: string; crossSession: boolean }>>([]);
  const pendingOpen = pendingOpens[0] ?? null;
  // Keep the last request on screen while the dialog animates closed.
  const shownOpenRef = useRef(pendingOpen);
  if (pendingOpen) shownOpenRef.current = pendingOpen;
  const shownOpen = pendingOpen ?? shownOpenRef.current;
  const dismissPendingOpen = useCallback(() => setPendingOpens((queue) => queue.slice(1)), []);
  const requestOpenUrl = useCallback((url: string, sessionId: string, crossSession: boolean): string => {
    if (!crossSession && openUrlAutomatically) {
      window.open(url, "_blank", "noopener,noreferrer")?.focus?.();
      return `Opened ${url}`;
    }
    setPendingOpens((queue) => [...queue, { kind: "url", target: url, name: url, sessionId, crossSession }]);
    return crossSession
      ? `Asked the user to confirm opening ${url}; they are viewing another omp-web session.`
      : `Asked the user to confirm opening ${url}.`;
  }, [openUrlAutomatically]);
  const handleSessionOpenUrl = useCallback((url: string) => requestOpenUrl(url, selectedSession?.id ?? "", false), [requestOpenUrl, selectedSession?.id]);
  const handleCrossSessionHostTool = useCallback(async (call: CrossSessionHostToolCall) => {
    // Full-page Settings hides the chat, so its session counts as not viewed.
    const viewing = call.sessionId === selectedSession?.id && !settingsTab;
    const { text, isError } = await runHostTool(call.toolName, call.arguments, {
      cwd: call.cwd,
      sessionId: call.sessionId,
      openUrl: (url) => requestOpenUrl(url, call.sessionId, !viewing),
      openFile: (path, name) => {
        if (viewing || openFileAutomatically) {
          // Opening the file must reveal the panel, even from full-page Settings.
          setSettingsTab(null);
          return handleOpenFile(path, name, call.sessionId);
        }
        setPendingOpens((queue) => [...queue, { kind: "file", target: path, name, sessionId: call.sessionId, crossSession: true }]);
        return `Asked the user to confirm opening ${path}; they are viewing another omp-web session.`;
      },
    });
    try {
      await sendAgentCommand(call.sessionId, {
        type: "host_tool_result",
        id: call.id,
        isError,
        result: { content: [{ type: "text", text }] },
      });
    } catch (e) {
      console.error("Failed to send host tool result:", e);
    }
  }, [handleOpenFile, requestOpenUrl, openFileAutomatically, selectedSession?.id, settingsTab]);
  const crossSessionHostToolRef = useRef(handleCrossSessionHostTool);
  useEffect(() => { crossSessionHostToolRef.current = handleCrossSessionHostTool; }, [handleCrossSessionHostTool]);
  useEffect(() => subscribeAppEvents({
    // Mounted with the shell (not the sidebar) so it keeps listening on the
    // full-page Settings view too.
    onFrame: (frame) => {
      const call = frame as Partial<CrossSessionHostToolCall> & { type?: string };
      if (call.type === "host_tool_call" && call.sessionId && call.id && call.toolName) {
        void crossSessionHostToolRef.current({ sessionId: call.sessionId, cwd: call.cwd, id: call.id, toolName: call.toolName, arguments: call.arguments ?? {} });
      }
    },
  }), []);

  // Explorer tab browses the active workspace: live cwd first, then the
  // selected / new-session cwd (mirrors what the sidebar used to pass down).
  const explorerCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null;
  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null);
  }, [handleOpenFile, selectedSession?.id]);

  // File-panel integrations act on a given tab: the toolbar passes the active
  // one, a tab's right-click menu the tab that was clicked.
  const handleMentionFileTab = useCallback((tabId: string) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    if (!tab) return;
    handleAtMention(getRelativeFilePath(tab.filePath, activeCwd ?? undefined), false);
  }, [fileTabs, activeCwd, handleAtMention]);

  const handleCopyFileTabPath = useCallback((tabId: string) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    if (!tab) return;
    const relative = getRelativeFilePath(tab.filePath, activeCwd ?? undefined);
    copyText(relative).then(
      () => toast.success(t("appShell.copied")),
      () => toast.error(t("appShell.commandCopyFailed")),
    );
  }, [fileTabs, activeCwd, t]);

  const handleDownloadFileTab = useCallback((tabId: string) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    if (!tab) return;
    const link = document.createElement("a");
    link.href = `/api/files/${encodeFilePathForApi(tab.filePath)}?type=download`;
    link.download = tab.label;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [fileTabs]);
  const handleRevealFileTab = useCallback((tabId: string) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    if (!tab) return;
    setRevealPath(tab.filePath);
    setRightView("explorer");
    setRightPanelOpen(true);
  }, [fileTabs]);

  const handleSelectFileTab = useCallback((tabId: string) => {
    setActiveFileTabId(tabId);
    setRightView("file");
  }, []);
  // Stable selectors for the memoized RightPanel: inline arrows here would be
  // new identities every render and defeat the memo boundary.
  const handleSelectRightView = useCallback((view: RightPanelView) => {
    setRightView(view);
  }, []);

  // Toggle the Terminal panel using the configured application shortcut.
  const terminalShowingRef = useRef(false);
  useEffect(() => {
    terminalShowingRef.current = rightPanelOpen && rightView === "terminal";
  }, [rightPanelOpen, rightView]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut("toggleTerminal", event)) return;
      event.preventDefault();
      if (terminalShowingRef.current) {
        setRightPanelOpen(false);
        return;
      }
      setSettingsTab(null);
      setRightView("terminal");
      setRightPanelOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // "Open in terminal" from the sidebar, explorer or a context menu.
  const [terminalRequest, setTerminalRequest] = useState<{ id: number; cwd: string } | null>(null);
  useEffect(() => {
    const onOpenTerminal = (event: Event) => {
      const cwd = (event as CustomEvent<OpenTerminalDetail>).detail?.cwd;
      if (!cwd) return;
      setSettingsTab(null);
      setRightView("terminal");
      setRightPanelOpen(true);
      if (isMobile) setSidebarOpen(false);
      setTerminalRequest((previous) => ({ id: (previous?.id ?? 0) + 1, cwd }));
    };
    window.addEventListener(OPEN_TERMINAL_EVENT, onOpenTerminal);
    return () => window.removeEventListener(OPEN_TERMINAL_EVENT, onOpenTerminal);
  }, [isMobile]);

  const handleRevealDone = useCallback(() => {
    setRevealPath(null);
  }, []);

  const handleToggleFileSearch = useCallback(() => {
    setFileSearchOpen((open) => !open);
  }, []);

  const handleCloseOtherFileTabs = useCallback((tabId: string) => {
    requestCloseFileTabs(fileTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
  }, [fileTabs, requestCloseFileTabs]);

  const handleCloseAllFileTabs = useCallback(() => {
    requestCloseFileTabs(fileTabs.map((tab) => tab.id));
  }, [fileTabs, requestCloseFileTabs]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const newSessionProject = (workspaceOptions.cwd === effectiveNewSessionCwd ? workspaceOptions.selectedProject : null) ?? effectiveNewSessionCwd ?? "";
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const currentRate = generationSpeed?.current;
  const rate = currentRate ?? generationSpeed?.average;
  const speed = showChat ? formatGenerationSpeed(rate) : null;
  const hasGenerationSpeed = speed !== null;
  useLayoutEffect(() => {
    const header = topBarRef.current;
    const details = mobileToolsRef.current;
    const content = mobileToolsContentRef.current;
    const right = header?.querySelector<HTMLElement>("[data-topbar-right-group]");
    const tools = header?.querySelector<HTMLElement>(".shell-topbar-tools");
    if (!header || !details || !content || !right || !tools) return;
    const update = () => {
      const hadControlsFocus = content.contains(document.activeElement);
      // Measure the real controls even while their disclosure is closed.
      const closed = !details.open;
      const display = content.style.display;
      const visibility = content.style.visibility;
      const width = content.style.width;
      content.style.visibility = "hidden";
      content.style.display = "flex";
      content.style.width = "max-content";
      details.open = true;
      const children = Array.from(content.children).filter((child) =>
        !["absolute", "fixed"].includes(getComputedStyle(child).position));
      const contentStyle = getComputedStyle(content);
      const headerStyle = getComputedStyle(header);
      const rightStyle = getComputedStyle(right);
      // DOM rectangles include interface zoom; clientWidth and CSS gaps do not.
      const scale = header.getBoundingClientRect().width / header.offsetWidth || 1;
      const controlsWidth = children.reduce((width, child) => {
        const style = getComputedStyle(child);
        return width + child.getBoundingClientRect().width / scale
          + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
      }, 0) + Math.max(0, children.length - 1) * parseFloat(contentStyle.columnGap);
      const required = controlsWidth
        + (tools.firstElementChild?.getBoundingClientRect().width ?? 0) / scale
        + parseFloat(getComputedStyle(tools).columnGap)
        + parseFloat(headerStyle.paddingLeft) + parseFloat(headerStyle.paddingRight)
        + parseFloat(headerStyle.columnGap)
        + parseFloat(rightStyle.minWidth)
        + parseFloat(rightStyle.paddingLeft) + parseFloat(rightStyle.paddingRight);
      if (closed) details.open = false;
      content.style.display = display;
      content.style.visibility = visibility;
      content.style.width = width;
      const compact = required > header.clientWidth;
      if (compact && details.dataset.compact !== "true" && hadControlsFocus) {
        restoreToolsFocusRef.current = true;
      }
      setCompactTopbar(compact);
    };
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(content);
    for (const child of content.children) observer.observe(child);
    document.fonts.addEventListener("loadingdone", update);
    update();
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", update);
    };
  }, [hasGenerationSpeed, isMobile, locale, rightPanelOpen, showChat]);
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const sidebarHistory = useSidebarHistory({
    active: isMobile && (showChat || Boolean(initialSessionId)),
    ready: mobileSidebarReady,
    sidebarOpen,
    setSidebarOpen,
    url: searchParams.toString(),
  });
  useEffect(() => {
    if (sidebarHistory.exitNeedsNativeBack) {
      toast.info(t("appShell.exitNativeBackTitle"), t("appShell.exitNativeBackDescription"));
    }
  }, [sidebarHistory.exitNeedsNativeBack, t]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = `${attentionItems.length > 0 ? `(${attentionItems.length}) ` : ""}${activeCwdName ? `${activeCwdName} - omp web` : "omp web"}`;
  // Memoized: a fresh element each render would defeat SessionSidebar's memo.
  const attentionBell = useMemo(
    () => <AttentionCenter items={attentionItems} onOpen={(item) => void handleOpenAttention(item)} />,
    [attentionItems, handleOpenAttention],
  );

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  // New chat from the palette or the app context menu: the active workspace,
  // else the server's default cwd (~/omp-cwd-<date>). An empty cwd is truthy,
  // so showChat would render the shell while useAgentSession refuses to start
  // — every send a silent no-op.
  const handleQuickNewSession = useCallback(() => {
    if (activeCwd) {
      handleNewSession(`palette-${Date.now()}`, activeCwd);
      return;
    }
    void fetch("/api/default-cwd", { method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { cwd?: string };
        if (!data.cwd) throw new Error("Empty cwd returned");
        handleNewSession(`palette-${Date.now()}`, data.cwd);
      })
      .catch(() => toast.error(translate("errors.generic")));
  }, [activeCwd, handleNewSession]);

  // Right-click on anything without a menu of its own.
  const buildAppContextMenu = useCallback((): ContextMenuSection => ({
    id: "app",
    items: [
      { id: "new-chat", label: t("contextMenu.newChat"), icon: MessageSquarePlus, onSelect: handleQuickNewSession },
      { id: "command-palette", label: t("contextMenu.commandPalette"), icon: Command, shortcut: shortcutLabel("commandPalette", shortcutBindings), onSelect: () => window.dispatchEvent(new Event("omp:open-command-palette")) },
      { id: "toggle-sidebar", label: t("contextMenu.toggleSidebar"), icon: PanelLeft, onSelect: handleSidebarToggle },
      { id: "toggle-file-panel", label: t("contextMenu.toggleFilePanel"), icon: PanelRight, onSelect: () => { setSettingsTab(null); setRightPanelOpen((open) => !open); } },
      { id: "terminal", label: t("contextMenu.terminal"), icon: Terminal, shortcut: shortcutLabel("toggleTerminal", shortcutBindings), onSelect: () => { setSettingsTab(null); setRightView("terminal"); setRightPanelOpen(true); } },
      { id: "archive", label: t("contextMenu.archivedSessions"), icon: Archive, onSelect: () => setArchiveBrowserOpen(true) },
      { id: "settings", label: t("contextMenu.settings"), icon: Settings, onSelect: () => setSettingsTab("general") },
    ],
  }), [t, handleQuickNewSession, handleSidebarToggle, shortcutBindings]);

  const handleQuoteSelection = useCallback((text: string) => {
    chatInputRef.current?.insertQuote(quoteMarkdown(text));
  }, []);

  const sidebarContent = (
    <SessionSidebar
      selectedSessionId={selectedSession?.id ?? null}
      optimisticSession={selectedSession?.path === "" ? selectedSession : null}
      onSelectSession={handleSelectSession}
      onNewSession={handleNewSession}
      initialSessionId={initialSessionId}
      skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
      onInitialRestoreDone={handleInitialRestoreDone}
      refreshKey={refreshKey}
      onSessionDeleted={handleSessionDeleted}
      selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
      onCwdChange={handleCwdChange}
      onOpenWorkspace={handleOpenWorkspace}
      onAttentionChange={setSessionAttention}
      onRunningCountChange={setRunningSessionCount}
      headerAccessory={attentionBell}
      onWorkspaceOptionsChange={handleWorkspaceOptionsChange}
      addProjectOpen={addProjectOpen}
      setAddProjectOpen={setAddProjectOpen}
      usageVisible={providerUsageVisible}
      settingsOpen={Boolean(settingsTab)}
      onOpenSettings={() => setSettingsTab((prev) => prev ? null : "general")}
      onOpenArchive={() => setArchiveBrowserOpen(true)}
      updateAvailable={Boolean(appUpdate?.updateAvailable)}
      activePluginId={openPlugin?.id ?? null}
      onOpenPlugin={handleOpenPlugin}
      onClosePlugin={handleClosePlugin}
    />
  );

  return (
    <>
    <ToastProvider>
      <ConfirmDialog
        open={pendingFileClose !== null}
        onOpenChange={(open) => { if (!open) setPendingFileClose(null); }}
        title={t("fileEditing.discardTitle")}
        description={t("fileEditing.discardDescription")}
        confirmLabel={t("fileEditing.discard")}
        cancelLabel={t("fileEditing.cancel")}
        danger
        busy={fileTabs.some((tab) => pendingFileClose?.includes(tab.id) && fileEditorStates.get(tab.filePath) === "saving")}
        onConfirm={() => { if (pendingFileClose) closeFileTabs(pendingFileClose); }}
      />
      <ConfirmDialog
        open={sidebarHistory.exitConfirmationOpen}
        onOpenChange={(open) => { if (!open) sidebarHistory.cancelExit(); }}
        title={t("appShell.exitTitle")}
        description={t("appShell.exitDescription")}
        confirmLabel={t("appShell.exitLeave")}
        cancelLabel={t("appShell.exitStay")}
        danger
        onConfirm={sidebarHistory.leave}
      />
      <ConfirmDialog
        open={pendingOpen !== null}
        onOpenChange={(open) => { if (!open) dismissPendingOpen(); }}
        title={t(shownOpen?.kind === "file" ? "appShell.openFileTitle" : shownOpen?.crossSession ? "appShell.openUrlTitle" : "appShell.openUrlSameSessionTitle")}
        description={t(shownOpen?.crossSession ? "appShell.openUrlDescription" : "appShell.openUrlSameSessionDescription", { url: shownOpen?.target ?? "" })}
        confirmLabel={t("appShell.openUrlConfirm")}
        cancelLabel={t("appShell.openUrlCancel")}
        onConfirm={() => {
          if (pendingOpen?.kind === "url") window.open(pendingOpen.target, "_blank", "noopener,noreferrer");
          else if (pendingOpen) {
            // The file panel is hidden behind full-page Settings.
            setSettingsTab(null);
            handleOpenFile(pendingOpen.target, pendingOpen.name, pendingOpen.sessionId);
          }
          dismissPendingOpen();
        }}
      />
      <CommandPaletteMount
        onSelectSession={handleSelectSession}
        onNewSession={handleQuickNewSession}
        currentModel={null}
      />
      <ContextMenuHost appSection={buildAppContextMenu} onQuote={showChat && !settingsTab ? handleQuoteSelection : null} />
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: visible;
        transform-origin: top right;
        animation: session-info-pop var(--dur-slow) var(--ease-out-warm) both;
        will-change: transform, opacity;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash var(--dur-slow) var(--ease-out-warm) both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}
    </style>
    <WallpaperBackground />
    <a href="#main-content" className="skip-link">{t("appShell.skipToContent")}</a>
    <div className="wallpaper-shell" style={{ display: "flex", height: "100%", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", background: "var(--bg)" }}>
      {/* Left sidebar: hidden on full-page Settings, but kept mounted. Remounting it
          re-ran its first-load restore (the page's original ?session= or the top
          project) and switched away from the open chat on leaving Settings. */}
      {!settingsTab && (
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "color-mix(in srgb, var(--text) 28%, transparent)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity var(--dur-slow) var(--ease-out-warm)",
        }}
      />
      )}

      <nav
        id="workspace-sidebar"
        role={isMobile && sidebarOpen ? "dialog" : undefined}
        aria-modal={isMobile && sidebarOpen ? true : undefined}
        tabIndex={-1}
        ref={sidebarContainerRef}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizing ? " sidebar-resizing" : ""}`}
        aria-label={t("projects.heading")}
        aria-hidden={mobileSidebarReady && (!sidebarOpen || rightPanelIsModal) ? true : undefined}
        inert={mobileSidebarReady && (!sidebarOpen || rightPanelIsModal) ? true : undefined}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: settingsTab ? "none" : "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          // Desktop-only: the width is user-adjustable via the resize handle.
          ...(!isMobile ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
        }}
      >
        {sidebarContent}
      </nav>

      {/* Resize handle — desktop only, hidden while the sidebar is closed */}
      {!settingsTab && !isMobile && sidebarOpen && (
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("appShell.resizeSidebar")}
          tabIndex={0}
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={resetSidebarWidth}
          onKeyDown={handleSidebarResizeKey}
          title={t("appShell.resizeSidebarTitle")}
          style={{
            width: 5,
            flexShrink: 0,
            marginLeft: -5,
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

      {/* Center: chat */}
      {chatHidden && (
        <button
          type="button"
          className="chat-collapsed-rail wallpaper-surface ui-focus-ring"
          onClick={() => updateChatCollapsed(false)}
          title={t("appShell.showChat")}
          aria-label={t("appShell.showChat")}
          aria-controls="main-content"
          aria-expanded={false}
        >
          <ChevronsRight size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      <main id="main-content" tabIndex={-1} inert={rightPanelIsModal || chatHidden ? true : undefined} style={{ flex: 1, display: chatHidden ? "none" : "flex", flexDirection: "column", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
        {settingsTab ? (
          <SettingsConfig
            activeTab={settingsTab}
            appearanceTab={appearanceTab}
            onAppearanceTabChange={setAppearanceTab}
            toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
            onToolCallsDefaultCollapsedChange={handleToolCallsDefaultCollapsedChange}
            providerUsageVisible={providerUsageVisible}
            onProviderUsageVisibleChange={handleProviderUsageVisibleChange}
            scopeNativeSelectAll={scopeNativeSelectAll}
            onScopeNativeSelectAllChange={handleScopeNativeSelectAllChange}
            openUrlAutomatically={openUrlAutomatically}
            onOpenUrlAutomaticallyChange={handleOpenUrlAutomaticallyChange}
            openFileAutomatically={openFileAutomatically}
            onOpenFileAutomaticallyChange={handleOpenFileAutomaticallyChange}
            cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
            sessionId={selectedSession?.id ?? null}
            onModelsSaved={() => setModelsRefreshKey((k) => k + 1)}
            appUpdate={appUpdate}
            onRefreshAppUpdate={refreshAppUpdate}
            onRequestAppUpdate={requestAppUpdateFromSettings}
            onSelectTab={setSettingsTab}
            onClose={() => setSettingsTab(null)}
          />
        ) : (
          <>
        {/* Top bar: 3-zone segmented control bar */}
        <div ref={topBarRef} className="shell-topbar" style={{
          position: "relative",
          alignItems: "center",
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
          minHeight: isMobile ? "calc(44px + env(safe-area-inset-top))" : 36,
          background: "var(--bg-panel)",
          padding: isMobile ? "env(safe-area-inset-top) 4px 0" : "0 8px",
          gap: "0 8px",
          minWidth: 0,
        }}>
          {/* Left Zone: Utility group (sidebar, theme, language) & session controls (history, branches, system) */}
          <div className="shell-topbar-tools" style={{ display: "flex", alignItems: "center", gap: 4, height: isMobile ? 43 : 35, minWidth: 0, flexShrink: 0 }}>
            <button
              onClick={handleSidebarToggle}
              aria-expanded={sidebarOpen}
              aria-controls="workspace-sidebar"
              data-attention={!sidebarOpen && attentionItems.length > 0 ? "true" : undefined}
              title={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              aria-label={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              className="shell-toolbar-btn ui-focus-ring"
            >
              {sidebarOpen ? <PanelLeft size={16} strokeWidth={1.8} aria-hidden="true" /> : <Menu size={16} strokeWidth={1.8} aria-hidden="true" />}
            </button>
            {!isMobile && !isCompactOverlay && (
              <button
                type="button"
                onClick={() => { setRightPanelOpen(true); updateChatCollapsed(true); }}
                title={t("appShell.hideChat")}
                aria-label={t("appShell.hideChat")}
                aria-controls="main-content"
                aria-expanded={true}
                className="shell-toolbar-btn ui-focus-ring"
              >
                <ChevronsLeft size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <details
              ref={mobileToolsRef}
              className="shell-topbar-overflow"
              data-compact={isMobile ? "true" : compactTopbar === null ? "pending" : compactTopbar}
              open={isMobile ? undefined : compactTopbar ? undefined : true}
              onToggle={(event) => {
                if (!event.currentTarget.open) setActiveTopPanel(null);
              }}
            >
              <summary
                className="shell-toolbar-btn ui-focus-ring"
                title={t("chatInput.moreControls")}
                aria-label={t("chatInput.moreControls")}
              >
                <Ellipsis size={16} strokeWidth={1.8} aria-hidden="true" />
              </summary>
              <div ref={mobileToolsContentRef} className="shell-topbar-overflow-content">
                {showChat && (
                  <span
                    className="shell-mobile-context"
                    title={`${projectLabel(selectedSession?.projectRoot ?? selectedSession?.cwd ?? activeCwd ?? "")} · ${selectedSession?.name || selectedSession?.firstMessage || t("appShell.newSession")}`}
                  >
                    {selectedSession?.name || selectedSession?.firstMessage || t("appShell.newSession")}
                  </span>
                )}
            <ThemeSwitcher />
            <button type="button" onClick={() => { setAppearanceTab("wallpapers"); setSettingsTab("appearance"); }} title={t("appShell.wallpapers")} aria-label={t("appShell.wallpapers")} className="shell-toolbar-btn ui-focus-ring"><ImageIcon size={16} strokeWidth={1.8} aria-hidden="true" /></button>
            <LanguageSwitcher />
            <button type="button" onClick={openMemos} title={shortcutHint(t("memos.title"), "toggleMemos", shortcutBindings)} aria-label={t("memos.title")} aria-keyshortcuts={shortcutAria("toggleMemos", shortcutBindings)} className="shell-toolbar-btn ui-focus-ring"><StickyNote size={16} strokeWidth={1.8} aria-hidden="true" /></button>
                <button
                  type="button"
                  onClick={() => {
                    if (isMobile && mobileToolsRef.current) {
                      mobileToolsRef.current.open = false;
                      setActiveTopPanel(null);
                    }
                    window.dispatchEvent(new Event("omp:open-command-palette"));
                  }}
                  title={shortcutHint(t("commandPalette.label"), "commandPalette", shortcutBindings)}
                  aria-label={t("commandPalette.label")}
                  aria-keyshortcuts={shortcutAria("commandPalette", shortcutBindings)}
                  className="shell-toolbar-btn ui-focus-ring"
                >
                  <Command size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
            {showChat && (
              <>
                <div className="shell-toolbar-divider" aria-hidden="true" />
                <button
                  onClick={handleViewFullHistory}
                  disabled={!selectedSession}
                  title={selectedSession ? t("appShell.fullHistory") : t("appShell.fullHistoryUnavailable")}
                  aria-label={t("appShell.fullHistory")}
                  className="shell-toolbar-btn ui-focus-ring"
                >
                  <History size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <BranchNavigator
                  tree={branchTree}
                  activeLeafId={branchActiveLeafId}
                  onLeafChange={handleBranchLeafChange}
                  inline
                  containerRef={compactTopbar ? mobileToolsContentRef : topBarRef}
                  open={activeTopPanel === "branches"}
                  onToggle={() => toggleTopPanel("branches")}
                  hasSession
                />
                <button
                  ref={systemBtnRef}
                  onClick={handleSystemPromptToggle}
                  title={t("appShell.system")}
                  aria-label={t("appShell.system")}
                  aria-pressed={activeTopPanel === "system"}
                  className="shell-toolbar-btn ui-focus-ring"
                >
                  <Terminal size={16} strokeWidth={1.8} aria-hidden="true" style={{ color: systemPrompt ? "var(--accent)" : undefined }} />
                </button>
              </>
            )}
          {activeTopPanel === "system" && (
            <div data-top-panel className="dropdown-surface" style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: isMobile ? 4 : 8,
              right: "auto",
              width: "auto",
              minWidth: isMobile ? undefined : 420,
              maxWidth: "min(680px, calc(100vw - 24px))",
              maxHeight: "min(70vh, calc(100dvh - 56px))",
              overflowY: "auto",
              overflowX: "hidden",
              zIndex: 500,
            }}>
              {activeTopPanel === "system" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "var(--shadow-pop)",
                  minWidth: isMobile ? undefined : 420,
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("appShell.systemPromptEmpty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {systemPromptLoading ? t("appShell.systemPromptLoading") : t("appShell.systemPromptLoadHint")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
              </div>
            </details>
          </div>

          {/* Center Zone: Workspace & Session Breadcrumb + Auto-name action */}
          {showChat && (() => {
            const effectiveProject = selectedSession?.projectRoot ?? selectedSession?.cwd ?? activeCwd ?? "";
            const sessionTitle = selectedSession?.name || selectedSession?.firstMessage || t("appShell.newSession");
            const hasMessages = Boolean(
              selectedSession
              && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
            );
            const wandDisabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
            const wandIsSuccess = autoNameStatus.kind === "success";
            const wandIsError = autoNameStatus.kind === "error";
            const wandLabel = autoNameStatus.kind === "naming"
              ? t("appShell.generating")
              : wandIsSuccess
                ? t("appShell.titleUpdated")
                : wandIsError
                  ? t("appShell.generationFailed")
                  : t("appShell.generateTitle");
            const wandTooltip = !selectedSession
              ? t("appShell.titleGenUnavailable")
              : !hasMessages
                ? t("appShell.titleGenNeedsMessage")
                : wandIsError
                  ? autoNameStatus.message
                  : t("appShell.generateSessionTitle");

            return (
              <div
                className="shell-topbar-center"
                style={{
                  minWidth: 0,
                  containerType: "inline-size",
                  containerName: "breadcrumb",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  className="shell-topbar-breadcrumb wallpaper-inset"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-control)",
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    maxWidth: "min(400px, 100%)",
                    flexShrink: 1,
                  }}
                >
                  {effectiveProject ? (
                    <span className="shell-topbar-project-context" style={{ display: "contents" }}>
                      <Folder size={12} strokeWidth={1.8} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden="true" />
                      <span
                        style={{
                          fontWeight: 600,
                          color: "var(--text)",
                          flexShrink: 0,
                          maxWidth: 120,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={effectiveProject}
                      >
                        {projectLabel(effectiveProject)}
                      </span>
                      <span style={{ color: "var(--text-dim)", flexShrink: 0, opacity: 0.5 }}>/</span>
                    </span>
                  ) : null}
                  <span
                    style={{
                      color: "var(--text)",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                    title={sessionTitle}
                  >
                    {sessionTitle}
                  </span>
                  {selectedSession && (
                    <button
                      type="button"
                      onClick={() => void handleAutoName()}
                      disabled={wandDisabled}
                      title={wandTooltip}
                      aria-label={wandLabel}
                      className="ui-focus-ring"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        padding: 0,
                        marginLeft: 2,
                        border: "none",
                        borderRadius: 4,
                        background: "transparent",
                        color: wandIsSuccess ? "var(--accent)" : wandIsError ? "var(--status-error)" : "var(--text-dim)",
                        cursor: wandDisabled ? "default" : "pointer",
                        flexShrink: 0,
                        opacity: autoNameStatus.kind === "naming" ? 1 : wandDisabled ? 0.35 : 0.75,
                        transition: "color var(--dur-fast), opacity var(--dur-fast)",
                      }}
                    >
                      {autoNameStatus.kind === "naming" ? (
                        <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      ) : wandIsSuccess ? (
                        <Check size={12} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <Wand2 size={12} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Right Zone: Segmented metric pills (Provider limits, Session Stats/Usage, Speed) */}
          <div
            data-topbar-right-group
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 6,
              paddingRight: rightPanelOpen ? 8 : 44,
              minWidth: hasGenerationSpeed ? "calc(10ch + 33px)" : 0,
              width: hasGenerationSpeed ? 200 : 0,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              containerType: "inline-size",
              containerName: "topbar-speed",
              flexShrink: 1,
            }}
          >

            {/* Generation speed pill */}
            {showChat && (() => {
              if (!speed || rate == null) return null;
              const isLive = currentRate != null;
              const speedTitle = t(isLive ? "appShell.tooltipCurrentSpeed" : "appShell.tooltipAverageSpeed", {
                value: `${rate.toFixed(1)} t/s`,
              });

              return (
                <button
                  type="button"
                  title={speedTitle}
                  aria-label={speedTitle}
                  aria-pressed={activeTopPanel === "speed"}
                  aria-expanded={activeTopPanel === "speed"}
                  data-top-panel
                  onClick={() => toggleTopPanel("speed")}
                  className="shell-metric-pill shell-pill-extra wallpaper-inset"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-control)",
                    border: `1px solid ${activeTopPanel === "speed" ? "var(--accent)" : "var(--border)"}`,
                    background: activeTopPanel === "speed" ? "var(--bg-selected)" : "var(--bg-subtle)",
                    color: isLive ? "var(--accent)" : "var(--text-muted)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    width: "calc(10ch + 33px)",
                    flexShrink: 0,
                  }}
                >
                  {isLive ? (
                    <Zap size={11} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />
                  ) : (
                    <span aria-hidden="true" style={{ width: 11, lineHeight: "11px", textAlign: "center", flexShrink: 0, color: "var(--text-dim)" }}>~</span>
                  )}
                  <span style={{ display: "inline-flex", gap: "1ch", fontWeight: isLive ? 600 : 400 }}>
                    <span style={{ width: "5ch", textAlign: "right" }}>{speed.value}</span>
                    <span style={{ width: "4ch" }}>{speed.unit}</span>
                  </span>
                </button>
              );
            })()}
          </div>
          {showChat && activeTopPanel === "speed" && generationSpeed && (
            <div data-top-panel className="dropdown-surface" style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: rightPanelOpen ? 8 : 44,
              width: "min(620px, calc(100vw - 16px))",
              maxHeight: "min(70vh, calc(100dvh - 56px))",
              overflowY: "auto",
              zIndex: 500,
            }}>
              <GenerationSpeedPanel samples={generationSpeed.samples} />
            </div>
          )}

        </div>

        {/* Chat content */}
        <div className="wallpaper-chat-pane" style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              newSessionWorkspace={effectiveNewSessionCwd && (
                <div className="new-session-workspace wallpaper-workspace">
                  <label id="new-session-workspace-label" htmlFor="new-session-workspace" className="new-session-workspace-label wallpaper-surface">
                    {t("settingsConfig.chipWorkspace")}
                  </label>
                  <div className="new-session-workspace-control wallpaper-workspace-select wallpaper-surface">
                    <span className="new-session-workspace-icon" aria-hidden="true">
                      <Folder size={17} strokeWidth={1.8} />
                    </span>
                    <Select
                      id="new-session-workspace"
                      aria-describedby="new-session-workspace-path"
                      value={effectiveNewSessionCwd}
                      onChange={(nextValue) => {
                        const cwd = nextValue;
                        if (!cwd) {
                          setAddProjectOpen(true);
                          return;
                        }
                        if (cwd === effectiveNewSessionCwd) return;
                        suppressCwdRef.current = cwd;
                        setActiveCwd(cwd);
                        handleNewSession("", cwd);
                      }}
                      options={workspaceSelectOptions(workspaceOptions.projects, effectiveNewSessionCwd, newSessionProject, <>+ {t("projects.add")}</>)}
                    />
                  </div>
                  <div id="new-session-workspace-path" className="new-session-workspace-path wallpaper-surface" title={effectiveNewSessionCwd}>
                    {effectiveNewSessionCwd}
                  </div>
                </div>
              )}
              onAgentEnd={handleAgentEnd}
              onPetActivityChange={setPetActivity}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onOpenFile={handleOpenLinkedFile}
              onOpenUrl={handleSessionOpenUrl}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onGenerationSpeedChange={handleGenerationSpeedChange}
              onOpenProviders={() => setSettingsTab("providers")}
              toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
            />
          ) : initialCwdStatus === "validating" ? (
            <WorkspaceState
              kind="loading"
              title={t("appShell.openingWorkspace")}
              detail={<span className="workspace-state-path">{initialNavigation.requestedCwd}</span>}
            />
          ) : initialCwdStatus === "error" ? (
            <WorkspaceState
              kind="error"
              title={t("appShell.unableToOpenWorkspace")}
              detail={(
                <>
                  <span className="workspace-state-path">{initialNavigation.requestedCwd}</span>
                  <span>{initialCwdError}</span>
                </>
              )}
            />
          ) : !showPlaceholder ? (
            <PanelLoadingFallback />
          ) : activeCwd ? (
            <WorkspaceState kind="empty" title={t("appShell.selectSessionHint")} />
          ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div className="display-serif" style={{ fontSize: 20, color: "var(--text)", marginBottom: 8 }}>{t("appShell.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("appShell.getStartedStep1")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>
                    {(() => {
                      // One translatable sentence; the {models} slot is rendered
                      // as the emphasized button name so word order stays free.
                      const [before, after] = t("appShell.getStartedStep2").split("{models}");
                      return (
                        <>
                          {before}
                          <strong style={{ color: "var(--text)" }}>{t("appShell.models")}</strong>
                          {after}
                        </>
                      );
                    })()}
                  <button
                    type="button"
                    onClick={() => {
                      setSidebarOpen(true);
                      setAddProjectOpen(true);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 6, width: "fit-content", minHeight: 36, marginTop: 12, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 12, fontWeight: 600, boxShadow: "var(--shadow-card)" }}
                    className="ui-focus-ring"
                  >
                    <Folder size={14} strokeWidth={1.8} aria-hidden="true" />
                    {t("appShell.openWorkspaces")}
                  </button>
                  </div>
                </div>
              </div>
          )}
        </div>
          </>
        )}
      </main>
      {!settingsTab && rightPanelHasOpened && rightPanelIsModal && (
        <div
          className="right-panel-backdrop"
          aria-hidden="true"
          onClick={() => setRightPanelOpen(false)}
        />
      )}
      {rightPanelHasOpened && (
        <RightPanel
        fileTabs={fileTabs}
        activeFileTabId={activeFileTabId}
        rightView={rightView}
        onSelectView={handleSelectRightView}
        rightPanelOpen={rightPanelOpen && !settingsTab}
        rightPanelFill={chatHidden}
        openPlugin={openPlugin}
        pluginFrameKey={pluginFrameKey}
        onReloadPlugin={handleReloadPlugin}
        currentSessionId={selectedSession?.id ?? null}
        onOpenSession={handleOpenScheduledRun}
        onClosePlugin={handleClosePlugin}
        rightPanelWidth={rightPanelWidth}
        rightPanelResizing={rightPanelResizing}
        rightPanelRef={rightPanelRef}
        fileExplorerRef={fileExplorerRef}
        revealPath={revealPath}
        onRevealDone={handleRevealDone}
        explorerCwd={explorerCwd}
        activeCwd={activeCwd}
        explorerRefreshKey={explorerRefreshKey}
        fileSearchOpen={fileSearchOpen}
        onToggleFileSearch={handleToggleFileSearch}
        onFileSearchOpenChange={setFileSearchOpen}
        explorerUploadBusy={explorerUploadBusy}
        onUploadBusyChange={setExplorerUploadBusy}
        explorerGitCount={explorerGitCount}
        explorerIsRepo={explorerIsRepo}
        explorerRefreshing={explorerRefreshing}
        isMobile={isMobile}
        isCompactOverlay={isCompactOverlay}
        onOpenFile={handleOpenFile}
        fileEditorStates={fileEditorStates}
        onEditorStateChange={handleFileEditorState}
        onBeforeFileMutation={handleBeforeFileMutation}
        onFileMutation={handleFileMutation}
        onSelectFileTab={handleSelectFileTab}
        onCloseFileTab={handleCloseFileTab}
        onCloseOtherFileTabs={handleCloseOtherFileTabs}
        onCloseAllFileTabs={handleCloseAllFileTabs}
        onMentionFileTab={handleMentionFileTab}
        onCopyFileTabPath={handleCopyFileTabPath}
        onDownloadFileTab={handleDownloadFileTab}
        onRevealFileTab={handleRevealFileTab}
        onExplorerRefresh={handleExplorerRefresh}
        onExplorerRefreshDone={handleExplorerRefreshDone}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onMentionLines={handleFileLineMention}
        onExplorerGitStatus={handleExplorerGitStatus}
        onResetRightPanelWidth={resetRightPanelWidth}
        onRightPanelResizeStart={handleRightPanelResizeStart}
        onRightPanelResizeKey={handleRightPanelResizeKey}
        terminalRequest={terminalRequest}
      />
      )}

    </div>
    {!settingsTab && (
      <button
        type="button"
        className="wallpaper-panel-toggle shell-toolbar-btn shell-panel-toggle ui-focus-ring"
        onClick={() => setRightPanelOpen((v) => !v)}
        aria-expanded={rightPanelOpen}
        aria-controls="workspace-file-panel"
        aria-pressed={rightPanelOpen}
        title={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
        aria-label={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
        style={{
          position: "fixed", top: "env(safe-area-inset-top, 0px)", right: "env(safe-area-inset-right, 0px)", zIndex: 300,
          width: isMobile ? 44 : 36, height: isMobile ? 44 : 36, padding: 0,
          borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        }}
      >
        {rightPanelOpen ? <X size={16} strokeWidth={1.8} aria-hidden="true" /> : <PanelRight size={16} strokeWidth={1.8} aria-hidden="true" />}
      </button>
    )}
    {!settingsTab && <PetCompanion
      activity={!settingsTab && petActivity.sessionKey === (selectedSession?.id ?? effectiveNewSessionCwd ?? "") ? petActivity : { sessionKey: "", state: "idle" }}
      onSettings={() => { setAppearanceTab("pets"); setSettingsTab("appearance"); }}
    />}
    <AppUpdateDialog open={appUpdateDialogOpen} update={appUpdate} phase={appUpdatePhase} visibleStage={appUpdateVisibleStage} error={appUpdateError} runningSessions={runningSessionCount} onProceed={() => void proceedWithAppUpdate()} onNotNow={dismissAppUpdate} />
    {archiveBrowserOpen && (
      <ArchiveBrowser
        open={archiveBrowserOpen}
        onClose={() => setArchiveBrowserOpen(false)}
        onRestored={handleArchiveRestored}
      />
    )}
    <MemoPanel />
    <ScheduledTasksPanel
      currentSessionId={selectedSession?.path ? selectedSession.id : null}
      currentCwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
      onOpenSession={handleOpenScheduledRun}
    />
    <AskpassDialog requests={askpassRequests} />
    </ToastProvider>
    </>
  );
}
