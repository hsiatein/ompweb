"use client";

import { memo, useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, useDeferredValue, type ReactNode } from "react";
import type { ExitedRpcSession, ManagedProject, ProjectLaunchConfig, SessionInfo } from "@/lib/types";
import type { AttentionItem } from "@/lib/attention";
import { useI18n } from "@/lib/i18n";
import { useHomeDir } from "@/lib/home-dir";
import { formatApiError } from "@/lib/i18n/api-error";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProjectLaunchConfigDialog } from "./ProjectLaunchConfigDialog";
import { ProviderUsageBar } from "./ProviderUsageBar";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import { clearLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { groupSessionsByProject, moveManagedProject, projectActivityCounts, shiftManagedProject, sortManagedProjects, type ProjectDropTarget } from "@/lib/project-ordering";
import { comparableProjectPath } from "@/lib/comparable-path";
import { Archive, CalendarClock, Check, ChevronRight, FileUp, Plus, Puzzle, RefreshCw, Search, Settings2 } from "lucide-react";
import { openScheduledTasks } from "@/lib/scheduled-tasks-ui";
import { PluginsPanel } from "./PluginsPanel";
import type { WebPluginInfo } from "@/lib/web-plugin-types";
import {
  countActiveSessionFilters,
  DEFAULT_SESSION_FILTERS,
  matchesSessionFilters,
  SESSION_STATUS_FILTERS,
  sessionActiveWithin,
  sessionHasStatus,
  type SessionFilterContext,
  type SessionFilters,
} from "@/lib/session-filters";
import { SessionFilterChips, SessionFilterMenu, type SessionFilterCounts } from "./SessionSidebar-filters";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import { subscribeAppEvents } from "@/lib/app-events";
import {
  EMPTY_PROJECT_SET,
  INITIAL_RESTORE_MAX_ATTEMPTS,
  INITIAL_RESTORE_RETRY_MS,
  MAX_PROJECT_SESSIONS,
  buildSessionTree,
  displayCwd,
  loadExpandedProjects,
  loadUnreadSessionIds,
  normalizeProjectKey,
  projectLabel,
  saveExpandedProjects,
  saveUnreadSessionIds,
  type WorktreeEntry,
  type WorktreeState,
} from "./SessionSidebar-helpers";
import { OmpWebTitle, SIDEBAR_BUTTON_TRANSITION, SidebarIconButton } from "./SessionSidebar-chrome";
import { ProjectRow, ProjectSectionDropZone, ProjectSectionLabel, ProjectWorktreeSwitcher } from "./SessionSidebar-rows";

/** Deadline for one /api/sessions fetch. A wedged-but-listening server never
 * answers; without this the initial spinner would pend forever. */
const SESSIONS_FETCH_TIMEOUT_MS = 15_000;

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  /** The active session can exist in memory before its JSONL file is flushed. */
  optimisticSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  /** A workspace header was clicked: show that workspace's new-chat page. */
  onOpenWorkspace?: (cwd: string) => void;
  /** Pending "needs you" dialogs from the running-sessions stream. */
  onAttentionChange?: (items: AttentionItem[]) => void;
  /** Number of sessions mid-run, from the same stream (update dialog warning). */
  onRunningCountChange?: (count: number) => void;
  /** Rendered first among the header utilities (the attention bell). */
  headerAccessory?: ReactNode;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  onWorkspaceOptionsChange?: (projects: ManagedProject[], selectedProject: string | null, cwd: string | null) => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  /** Shows the provider usage bar above Settings; toggle lives in Settings. */
  usageVisible?: boolean;
  /** Opens the app settings (pinned sidebar footer row). */
  onOpenSettings?: () => void;
  /** True when an omp/ompweb update is available — shows a badge on the gear. */
  updateAvailable?: boolean;
  /** Opens the archived sessions browser. */
  onOpenArchive?: () => void;
  /** True when settings full-page view is currently open. */
  settingsOpen?: boolean;
  /** Plugin whose page is open in the main area (highlighted in the plugin list). */
  activePluginId?: string | null;
  onOpenPlugin: (plugin: WebPluginInfo) => void;
  onClosePlugin: (id: string) => void;
}

const SIDEBAR_PLUGINS_MODE_KEY = "omp-web:sidebar-plugins";




export const SessionSidebar = memo(function SessionSidebar({ selectedSessionId, optimisticSession, onSelectSession, onNewSession, onOpenWorkspace, onAttentionChange, onRunningCountChange, headerAccessory, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onWorkspaceOptionsChange, addProjectOpen, setAddProjectOpen, usageVisible = true, onOpenSettings, onOpenArchive, updateAvailable, settingsOpen = false, activePluginId = null, onOpenPlugin, onClosePlugin }: Props) {


  const { t } = useI18n();
  // Plugin mode swaps the workspace list for the web plugins (kept across reloads).
  const [pluginsMode, setPluginsMode] = useState(false);
  useEffect(() => {
    try { setPluginsMode(window.localStorage.getItem(SIDEBAR_PLUGINS_MODE_KEY) === "1"); } catch { /* storage unavailable */ }
  }, []);
  const togglePluginsMode = useCallback(() => {
    setPluginsMode((current) => {
      try { window.localStorage.setItem(SIDEBAR_PLUGINS_MODE_KEY, current ? "0" : "1"); } catch { /* storage unavailable */ }
      return !current;
    });
  }, []);
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const homeDir = useHomeDir() ?? "";
  // Managed + session-discovered projects (server-merged, hidden excluded).
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [draggedProjectPath, setDraggedProjectPath] = useState<string | null>(null);
  // The drag source is tracked in a ref immediately (drop handlers read it)
  // while the state that re-renders the list is deferred one frame: mutating
  // layout synchronously inside dragstart makes Chrome abort the drag.
  const draggedProjectRef = useRef<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // Add-project picker state.
  const [addProjectBusy, setAddProjectBusy] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  // Per-project expansion, persisted to localStorage (null = nothing stored).
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(() => loadExpandedProjects());
  // Project currently being removed (hide) — serializes remove requests.
  const [removeProjectPath, setRemoveProjectPath] = useState<string | null>(null);
  const [launchConfigProject, setLaunchConfigProject] = useState<ManagedProject | null>(null);
  // Worktree/branch/Git state is scoped per repository. It is cached in a
  // map keyed by the normalized repository root so switching workspaces never
  // leaks one project's branch/worktree data into another's UI (each project
  // keeps its own loaded Git state; a late async response for a previous repo
  // only updates that repo's entry, never the active one).
  const [worktreeStateByProject, setWorktreeStateByProject] = useState<Record<string, WorktreeState>>({});
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const wtToggleRef = useRef<HTMLButtonElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [subagentCounts, setSubagentCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [runningSessionCwds, setRunningSessionCwds] = useState<Record<string, string>>({});
  const [exitedSessions, setExitedSessions] = useState<Map<string, ExitedRpcSession>>(() => new Map());
  const knownRunningCwdsRef = useRef<Map<string, string>>(new Map());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Relative session times must age while the sidebar stays open; one shared
  // minute clock avoids a timer per session row.
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  // Client-side workspace/session filtering (Workspaces header controls).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sessionFilters, setSessionFilters] = useState<SessionFilters>(DEFAULT_SESSION_FILTERS);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionsEtagRef = useRef<string | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  // Set once the first /api/sessions fetch settles (success OR failure) so the
  // initial-restore effect can stop waiting on a load that never yields rows.
  const initialLoadedRef = useRef(false);
  // True while a load that shows the skeleton is pending. A newer load aborts
  // the older one and inherits this: otherwise the aborted first load would
  // drop the skeleton and the sidebar would show every project as empty until
  // the replacement answers (it can sit queued behind the browser's per-host
  // connection limit).
  const loadingOwnerRef = useRef(false);
  const loadSessions = useCallback(async (showLoading = false) => {
    const ownsLoading = showLoading || loadingOwnerRef.current;
    sessionsAbortRef.current?.abort();
    const controller = new AbortController();
    sessionsAbortRef.current = controller;
    // A wedged-but-listening server (the long-idle failure mode) accepts the
    // TCP connection and never answers: without a deadline the fetch pends
    // forever and the sidebar shows its initial spinner indefinitely. Abort
    // with a TimeoutError so the catch surfaces an error and the
    // visibility/online recovery below can retry later.
    const timeout = setTimeout(() => controller.abort(new DOMException("Session list request timed out", "TimeoutError")), SESSIONS_FETCH_TIMEOUT_MS);
    try {
      if (ownsLoading) {
        loadingOwnerRef.current = true;
        setLoading(true);
      }
      const headers: Record<string, string> = {};
      if (sessionsEtagRef.current) headers["If-None-Match"] = sessionsEtagRef.current;
      const res = await fetch("/api/sessions", { headers, signal: controller.signal });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get("ETag");
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; runningSessions?: Array<{ id: string; cwd: string }> };
      setAllSessions(data.sessions);
      // Only now does the list match this ETag. Storing it before the body is
      // read lets a superseded (aborted) load leave the list empty while every
      // later request gets a 304 for it.
      if (etag) sessionsEtagRef.current = etag;
      if (data.runningSessions) {
        for (const rs of data.runningSessions) {
          if (rs.id && rs.cwd) knownRunningCwdsRef.current.set(rs.id, rs.cwd);
        }
      }
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        if (data.runningSessions) {
          const nextCwds: Record<string, string> = {};
          for (const rs of data.runningSessions) {
            if (rs.id && rs.cwd) nextCwds[rs.id] = rs.cwd;
          }
          setRunningSessionCwds(nextCwds);
        }
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!ownsLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(t("sessionSidebar.loadFailed", { detail: e instanceof Error ? e.message : String(e) }));
    } finally {
      clearTimeout(timeout);
      // A superseded load leaves loading/initial state to its replacement.
      if (sessionsAbortRef.current === controller) {
        initialLoadedRef.current = true;
        if (ownsLoading) {
          loadingOwnerRef.current = false;
          setLoading(false);
        }
      }
    }
  }, [t]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const projectsLoadSeqRef = useRef(0);
  const loadProjects = useCallback(async () => {
    const seq = ++projectsLoadSeqRef.current;
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { projects?: ManagedProject[] };
      // A newer request superseded this one — drop the stale response.
      if (seq !== projectsLoadSeqRef.current) return;
      setProjects(data.projects ?? []);
      setProjectsError(null);
      projectsLoadedRef.current = true;
    } catch (e) {
      if (seq !== projectsLoadSeqRef.current) return;
      setProjectsError(t("projects.loadFailed", { detail: e instanceof Error ? e.message : String(e) }));
    }
  }, [t]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshKey]);

  useEffect(() => {
    const interval = setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Persist expansion state; null means nothing was stored yet.
  useEffect(() => {
    if (expandedProjects === null) return;
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  // Debounce refresh bursts (agent_start + session_info_update + file-appear signal can fire within 250ms)
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (pendingRefreshRef.current) return;
    pendingRefreshRef.current = setTimeout(() => {
      pendingRefreshRef.current = null;
      void loadSessions(false);
    }, 300);
  }, [loadSessions]);
  useEffect(() => () => {
    if (sessionRefreshTimerRef.current) {
      clearTimeout(sessionRefreshTimerRef.current);
      sessionRefreshTimerRef.current = null;
    }
  }, []);

  const onAttentionChangeRef = useRef(onAttentionChange);
  const onRunningCountChangeRef = useRef(onRunningCountChange);
  useLayoutEffect(() => {
    onAttentionChangeRef.current = onAttentionChange;
    onRunningCountChangeRef.current = onRunningCountChange;
  }, [onAttentionChange, onRunningCountChange]);
  useEffect(() => {
    // Live running status and session-list invalidations arrive on the
    // page-wide /api/events stream; the sidebar never has to poll while an
    // agent is working.
    const unsubscribe = subscribeAppEvents({
      onFrame: (frame) => {
        const data = frame as {
          type?: string;
          runningSessionIds?: string[];
          runningSessions?: Array<{ id: string; cwd: string }>;
          subagentSessions?: Array<{ id: string; count: number }>;
          exitedSessions?: ExitedRpcSession[];
          attention?: AttentionItem[];
          refreshSessionList?: boolean;
          sessionIds?: string[];
        };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          onAttentionChangeRef.current?.(data.attention ?? []);
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          setSubagentCounts(new Map((data.subagentSessions ?? []).map((entry) => [entry.id, entry.count])));
          onRunningCountChangeRef.current?.(data.runningSessionIds?.length ?? 0);
          setExitedSessions(new Map((data.exitedSessions ?? []).map((session) => [session.id, session])));
          if (data.runningSessions) {
            const nextCwds: Record<string, string> = {};
            for (const rs of data.runningSessions) {
              if (rs.id && rs.cwd) {
                knownRunningCwdsRef.current.set(rs.id, rs.cwd);
                nextCwds[rs.id] = rs.cwd;
              }
            }
            setRunningSessionCwds(nextCwds);
          }
          if (data.refreshSessionList) scheduleRefresh();
        } else if (data.type === "sessions-changed") {
          if (data.refreshSessionList) scheduleRefresh();
          publishSessionsChanged(data.sessionIds ?? []);
        }
      },
      // EventSource auto-reconnects; until a fresh frame arrives, let the
      // polled /api/sessions fallback own running state again.
      onError: () => {
        sseAuthoritativeRef.current = false;
      },
    });
    return () => {
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
      unsubscribe();
    };
  }, [loadSessions, scheduleRefresh]);
  // Long-idle recovery: while the tab is hidden the SSE connection can die
  // (laptop sleep, network change, tab freeze) and its EventSource reconnect
  // carries no list invalidation. Refresh whenever the user actually comes
  // back or the network returns, so the list is never left stale/empty.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadSessions(false);
    };
    const onOnline = () => void loadSessions(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [loadSessions]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    // A brand-new session's JSONL does not exist until the first assistant
    // turn makes progress — but its running badge must show immediately
    // via the optimistic row. Once any session completes (or a new session
    // appears on disk), reload so it replaces the optimistic placeholder
    // without waiting for another refresh trigger.
    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      loadSessions(false);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  const restoredRef = useRef(false);
  /** Set once the first /api/projects fetch succeeds; guards the expansion
   *  prune against running on an empty (still-loading) project list. */
  const projectsLoadedRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available.
   *  The worktree/branch cache is keyed per repository, so this lookup is
   *  scoped: a worktree belongs to the repository whose cached GitState lists
   *  it — never to a different repository's state. */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    for (const state of Object.values(worktreeStateByProject)) {
      if (state.worktrees.some((w) => normalizeProjectKey(w.path) === normalizeProjectKey(cwd))) {
        return state.projectRoot;
      }
    }
    // Fall back to the project registry, then to session cwd→root matches, so
    // a session whose projectKey was normalized server-side still resolves to
    // the registry's case-preserved path — the caller gets a canonical value.
    const registered = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cwd));
    if (registered) return registered.path;
    const foldedCwd = comparableProjectPath(cwd);
    const match = allSessions.find((s) => comparableProjectPath(s.cwd) === foldedCwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeStateByProject, allSessions, projects]);

  // ---- Expansion (used by the sync/notify effects below, so declared first) --
  // Keys are stored in comparableProjectPath form so case-variant spellings of
  // the same Windows path map to one entry (the server lowercases projectKey
  // on win32, while project.path preserves registry casing).
  const expandProject = useCallback((path: string) => {
    const key = comparableProjectPath(path);
    setExpandedProjects((prev) => {
      if (prev?.has(key)) return prev;
      const next = new Set(prev ?? []);
      next.add(key);
      return next;
    });
  }, []);

  const collapseProject = useCallback((path: string) => {
    const key = comparableProjectPath(path);
    setExpandedProjects((prev) => {
      if (!prev?.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleProjectExpanded = useCallback((path: string) => {
    const key = comparableProjectPath(path);
    setExpandedProjects((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);


  /** Activate a project (effective cwd = its root), expand it, and open its
   *  new-chat page. The cwd sync alone would keep an open session of the same
   *  project, and fires nothing when the cwd is already this root. */
  const activateProject = useCallback((path: string) => {
    provisionalSelectionRef.current = false;
    setSelectedCwd(path);
    expandProject(path);
    onOpenWorkspace?.(path);
  }, [expandProject, onOpenWorkspace]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back. Sessions
  // picked outside the sidebar (URL restore, command palette) also expand
  // their containing project.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    // A withdrawn command must not swallow the next one: without this reset,
    // re-commanding a cwd the sidebar already synced (A -> sidebar B -> A)
    // stays stuck on B.
    if (!selectedCwdProp) {
      lastSyncedCwdPropRef.current = null;
      return;
    }
    if (selectedCwdProp !== lastSyncedCwdPropRef.current) {
      provisionalSelectionRef.current = false;
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
      const project = projectRootFor(selectedCwdProp);
      if (project) expandProject(project);
    }
  }, [selectedCwdProp, projectRootFor, expandProject]);

  // Load worktrees/branch data for the repository containing the current
  // effective cwd. Results are cached in worktreeStateByProject keyed by the
  // normalized repository root, so each workspace keeps its own Git context:
  //  • switching to another repo leaves this repo's cached state intact, and
  //  • a late response for the previously-selected repo writes only that
  //    repo's entry (never the active repo's, so it can't overwrite the UI).
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) return;
    let cancelled = false;
    const requestedCwd = selectedCwd;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(requestedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        if (d.error || !d.projectRoot) {
          // This cwd is not a Git repo (or the lookup failed) — the selected
          // workspace should show no branch/worktrees. Other repos' cached
          // state is left intact: a non-Git workspace never inherits another
          // repo's branch, and we never discard previously-visited repos' Git
          // state.
          return;
        }
        const projectRoot = d.projectRoot;
        const entry: WorktreeState = {
          forCwd: requestedCwd,
          projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          worktrees: d.worktrees ?? [],
        };
        setWorktreeStateByProject((prev) => {
          const key = normalizeProjectKey(projectRoot);
          const existing = prev[key];
          if (existing && normalizeProjectKey(existing.projectRoot) !== key) {
            const next = { ...prev };
            delete next[normalizeProjectKey(existing.projectRoot)];
            next[key] = entry;
            return next;
          }
          return { ...prev, [key]: entry };
        });
      })
      .catch(() => { /* leave any cached state; refetch on demand */ });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Keep a just-created session and its project visible while omp is still
  // flushing the JSONL file. The server list remains authoritative once it
  // contains the same id.
  // IMPORTANT: derive synchronously — the previous projectRootFor(cwd) needs
  // the async /api/worktrees git lookup, so the optimistic row would park in
  // cwd-bucket then jump to repo bucket. Use registered-project match first.
  const optimisticProjectRoot = (() => {
    if (!optimisticSession) return null;
    if (optimisticSession.projectRoot) return optimisticSession.projectRoot;
    if (optimisticSession.projectKey) return optimisticSession.projectKey;
    const cw = optimisticSession.cwd ?? "";
    if (!cw) return null;
    const reg = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cw));
    if (reg) return reg.path;
    return cw;
  })();
  // Stable placeholder timestamps: Date.now() inside the memo would churn every refresh and bust downstream memos.
  const placeholderTsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (optimisticSession?.id && optimisticSession.cwd) {
      knownRunningCwdsRef.current.set(optimisticSession.id, optimisticSession.cwd);
      setRunningSessionCwds((prev) => (prev[optimisticSession.id] === optimisticSession.cwd ? prev : { ...prev, [optimisticSession.id]: optimisticSession.cwd }));
    }
  }, [optimisticSession]);
  const visibleSessions = useMemo(() => {
    let base = allSessions;
    if (optimisticSession && !base.some((session) => session.id === optimisticSession.id)) {
      const stableRoot = optimisticProjectRoot ?? optimisticSession.cwd;
      const stableKey = stableRoot ? comparableProjectPath(stableRoot) : undefined;
      base = [...base, { ...optimisticSession, projectRoot: stableRoot ?? optimisticSession.cwd, ...(stableKey ? { projectKey: stableKey } : {}) }];
    }
    // A running session's JSONL may not exist yet (first turn still
    // streaming). Keep it in the list so navigating away never hides it
    // until the file lands and the next refresh replaces the placeholder.
    const known = new Set(base.map((s) => s.id));
    const placeholders: SessionInfo[] = [];
    const visibleLiveIds = new Set(runningSessionIds);
    for (const id of exitedSessions.keys()) visibleLiveIds.add(id);
    for (const id of visibleLiveIds) {
      if (known.has(id)) continue;
      let ts = placeholderTsRef.current.get(id);
      if (!ts) {
        ts = new Date().toISOString();
        placeholderTsRef.current.set(id, ts);
      }
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? exitedSessions.get(id)?.cwd
        ?? knownRunningCwdsRef.current.get(id)
        ?? selectedCwd
        ?? "";
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ?? optimisticSession.projectRoot ?? optimisticSession.cwd)
        : (projectRootFor(sessionCwd) ?? sessionCwd);
      const phRoot = resolvedRoot ?? "";
      const phKey = phRoot ? comparableProjectPath(phRoot) : undefined;
      placeholders.push({
        id,
        path: "",
        cwd: sessionCwd,
        name: undefined,
        created: ts,
        modified: ts,
        messageCount: 1,
        firstMessage: "",
        projectRoot: phRoot,
        ...(phKey ? { projectKey: phKey } : {}),
      });
    }
    // Prune timestamps and known cwds for ids that are now materialized or no longer live.
    if (placeholderTsRef.current.size > placeholders.length) {
      for (const key of [...placeholderTsRef.current.keys()]) {
        if (!visibleLiveIds.has(key) || known.has(key)) placeholderTsRef.current.delete(key);
      }
    }
    if (knownRunningCwdsRef.current.size > visibleLiveIds.size + (optimisticSession ? 1 : 0)) {
      if (optimisticSession) visibleLiveIds.add(optimisticSession.id);
      for (const key of [...knownRunningCwdsRef.current.keys()]) {
        if (!visibleLiveIds.has(key) && known.has(key)) knownRunningCwdsRef.current.delete(key);
      }
    }
    return placeholders.length ? [...base, ...placeholders] : base;
  }, [allSessions, optimisticSession, optimisticProjectRoot, runningSessionIds, runningSessionCwds, exitedSessions, projectRootFor, selectedCwd]);
  const visibleProjects = useMemo(() => {
    let base = projects;
    const hasOpt = optimisticProjectRoot ? base.some((p) => comparableProjectPath(p.path) === comparableProjectPath(optimisticProjectRoot)) : false;
    if (optimisticProjectRoot && !hasOpt) {
      base = [...base, { path: optimisticProjectRoot }];
    }
    // Running placeholders may belong to a project not yet in the managed list
    // (new session's cwd wasn't registered as a project). Keep that workspace
    // visible so the placeholder row has a bucket to render in.
    const knownFolded = new Set(base.map((p) => comparableProjectPath(p.path)));
    const visibleLiveIds = new Set(runningSessionIds);
    for (const id of exitedSessions.keys()) visibleLiveIds.add(id);
    for (const id of visibleLiveIds) {
      if (allSessions.some((s) => s.id === id)) continue;
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? exitedSessions.get(id)?.cwd
        ?? knownRunningCwdsRef.current.get(id)
        ?? selectedCwd
        ?? "";
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ?? optimisticSession.projectRoot ?? optimisticSession.cwd)
        : (projectRootFor(sessionCwd) ?? sessionCwd);
      const phPath = resolvedRoot ?? "";
      if (phPath && !knownFolded.has(comparableProjectPath(phPath))) {
        base = [...base, { path: phPath }];
        knownFolded.add(comparableProjectPath(phPath));
      }
    }
    return base;
  }, [optimisticProjectRoot, projects, runningSessionIds, runningSessionCwds, exitedSessions, allSessions, optimisticSession, projectRootFor, selectedCwd]);

  // ---- Derived project list ---------------------------------------------------
  const selectedProject = useMemo(() => projectRootFor(selectedCwd), [projectRootFor, selectedCwd]);
  // While a fresh optimistic/placeholder is pending (JSONL not yet on disk),
  // freeze ordering so the new project row does not flicker optimistic ->
  // confirmed position. New projects are allowed to append at the end.
  const hasPendingNewSession = Boolean(
    optimisticSession
    || [...runningSessionIds, ...exitedSessions.keys()].some((id) => !allSessions.some((session) => session.id === id)),
  );
  const sortedProjectsBase = useMemo(() => sortManagedProjects(visibleProjects), [visibleProjects]);
  const sortedProjectsRef = useRef<ManagedProject[] | null>(null);
  const sortedProjects = useMemo(() => {
    if (hasPendingNewSession && sortedProjectsRef.current) {
      const prev = sortedProjectsRef.current;
      const prevKeys = new Set(prev.map((p) => comparableProjectPath(p.path)));
      const next = [...prev];
      for (const p of sortedProjectsBase) if (!prevKeys.has(comparableProjectPath(p.path))) next.push(p);
      return next;
    }
    sortedProjectsRef.current = sortedProjectsBase;
    return sortedProjectsBase;
  }, [sortedProjectsBase, hasPendingNewSession]);
  useEffect(() => {
    onWorkspaceOptionsChange?.(sortedProjects, selectedProject, selectedCwd);
  }, [onWorkspaceOptionsChange, sortedProjects, selectedProject, selectedCwd]);
  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sortedProjects, visibleSessions),
    [sortedProjects, visibleSessions],
  );
  const projectActivity = useMemo(
    () => projectActivityCounts(visibleSessions, runningSessionIds, unreadSessionIds, exitedSessions.keys()),
    [visibleSessions, runningSessionIds, unreadSessionIds, exitedSessions],
  );

  // Client-side filtering (Workspaces header: search + Filter menu).
  // While a filter is active, workspaces with no matching sessions are hidden
  // so the list reads as a genuine result set; at rest every workspace stays.
  // Deferred search: typing stays responsive (input updates immediately) while the heavy
  // visibleProjectEntries filter runs at lower priority. Combines with the 200ms ETag loadSessions
  // debounce already in place — keystrokes never block the main thread on large session lists.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const sessionFiltersApplied = countActiveSessionFilters(sessionFilters) > 0;
  const filtersActive = searchOpen || sessionFiltersApplied || deferredSearchQuery.trim().length > 0;
  const filterContext = useMemo<SessionFilterContext>(() => ({
    running: runningSessionIds,
    unread: unreadSessionIds,
    exited: new Set(exitedSessions.keys()),
    now: relativeTimeNow,
  }), [runningSessionIds, unreadSessionIds, exitedSessions, relativeTimeNow]);
  const filterCounts = useMemo<SessionFilterCounts>(() => {
    const counts: SessionFilterCounts = { running: 0, unread: 0, exited: 0, "24h": 0, "7d": 0 };
    for (const session of visibleSessions) {
      for (const status of SESSION_STATUS_FILTERS) if (sessionHasStatus(session.id, status, filterContext)) counts[status]++;
      if (sessionActiveWithin(session, "24h", filterContext)) counts["24h"]++;
      if (sessionActiveWithin(session, "7d", filterContext)) counts["7d"]++;
    }
    return counts;
  }, [visibleSessions, filterContext]);
  const visibleProjectEntries = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    const entries: { project: ManagedProject; sessions: SessionInfo[] }[] = [];
    for (const project of sortedProjects) {
      let list = sessionsByProject.get(project.path) ?? [];
      if (sessionFiltersApplied) list = list.filter((s) => matchesSessionFilters(s, sessionFilters, filterContext));
      if (q) {
        list = list.filter((s) => (s.name ?? "").toLowerCase().includes(q) || s.firstMessage.toLowerCase().includes(q));
      }
      // Label/alias-only matches surface as empty workspaces; without this
      // clause a custom workspace name would be unfindable by search.
      if (list.length === 0 && (sessionFiltersApplied || (q && !projectLabel(project.path).toLowerCase().includes(q) && !(project.alias ?? "").toLowerCase().includes(q)))) continue;
      entries.push({ project, sessions: list });
    }
    return entries;
  }, [sortedProjects, sessionsByProject, sessionFiltersApplied, sessionFilters, filterContext, deferredSearchQuery]);

  const treesByProject = useMemo(() => {
    const m = new Map<string, ReturnType<typeof buildSessionTree>>();
    for (const { project, sessions } of visibleProjectEntries) m.set(project.path, buildSessionTree(sessions));
    return m;
  }, [visibleProjectEntries]);

  // Drop persisted expansion keys whose project no longer exists (removed or
  // vanished), so the storage stays bounded to real projects. Only runs after
  // the first project fetch — an empty list mid-load must never wipe storage.
  useEffect(() => {
    if (expandedProjects === null || !projectsLoadedRef.current) return;
    const known = new Set(sortedProjects.map((p) => comparableProjectPath(p.path)));
    const stale = [...expandedProjects].filter((path) => !known.has(comparableProjectPath(path)));
    if (stale.length === 0) return;
    setExpandedProjects((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      stale.forEach((path) => next.delete(path));
      return next;
    });
  }, [expandedProjects, sortedProjects]);

  // True while the auto-selected project was chosen before projects loaded
  // (ordering incomplete); cleared by any manual activation.
  const provisionalSelectionRef = useRef(false);

  // A just-started session's JSONL is not flushed until its first turn makes
  // progress, so a URL reopened in that window has no list entry yet. Retry
  // the list a few times before declaring the restore failed.
  const restoreRetryRef = useRef(0);
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (restoreRetryTimerRef.current) {
      clearTimeout(restoreRetryTimerRef.current);
      restoreRetryTimerRef.current = null;
    }
  }, []);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (skipInitialProjectSelection) return;

    // If restoring a session, set cwd to match that session
    if (initialSessionId && !restoredRef.current) {
      // An empty list only blocks while the first load is still in flight —
      // a settled-but-empty or failed load means the target will never appear
      // (shared ?session= link, deleted session), so fall through to the
      // retry/exhaustion path below instead of returning forever.
      if (allSessions.length === 0 && !initialLoadedRef.current) return; // wait for sessions to load
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        restoreRetryRef.current = 0;
        restoredRef.current = true;
        setSelectedCwd(target.cwd);
        expandProject(comparableProjectPath(workspaceKeyOf(target)));
        onSelectSession(target, true);
        return;
      }
      if (restoreRetryRef.current < INITIAL_RESTORE_MAX_ATTEMPTS) {
        restoreRetryRef.current += 1;
        if (restoreRetryTimerRef.current) {
          clearTimeout(restoreRetryTimerRef.current);
          restoreRetryTimerRef.current = null;
        }
        restoreRetryTimerRef.current = setTimeout(() => {
          restoreRetryTimerRef.current = null;
          void loadSessions(false);
        }, INITIAL_RESTORE_RETRY_MS);
        return;
      }
      restoreRetryRef.current = 0;
      restoredRef.current = true;
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }
    // No restore target: activate the top project (most recently added) so New
    // Session and Explorer have a context. When projects have not loaded yet
    // the ordering is provisional — re-pick once they arrive, unless the user
    // already activated a project by hand.
    if (selectedCwd !== null && !provisionalSelectionRef.current) return;
    const top = sortedProjects[0];
    if (!top) return;
    setSelectedCwd(top.path);
    expandProject(top.path);
    provisionalSelectionRef.current = allSessions.length === 0;
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, sortedProjects, expandProject, loadSessions]);

  // Default expansion: when the user has never stored an expansion choice,
  // expand only the active project.
  const defaultExpandedRef = useRef(false);
  useEffect(() => {
    if (defaultExpandedRef.current) return;
    const project = selectedProject;
    if (!project) return;
    defaultExpandedRef.current = true;
    if (expandedProjects === null) expandProject(project);
  }, [selectedProject, expandedProjects, expandProject]);

  const commitAddProject = useCallback(async (candidate?: string, launchConfig?: ProjectLaunchConfig) => {
    const path = (candidate ?? "").trim();
    if (!path || addProjectBusy) return;

    setAddProjectBusy(true);
    setAddProjectError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path, launchConfig }),
      });
      const data = await res.json().catch(() => ({})) as { project?: ManagedProject; error?: string; code?: string };
      if (!res.ok || data.error || !data.project) {
        setAddProjectError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      await loadProjects();
      // Activate + expand the newly added project and close the picker.
      setSelectedCwd(data.project.path);
      expandProject(data.project.path);
      setAddProjectOpen(false);
    } catch (e) {
      setAddProjectError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddProjectBusy(false);
    }
  }, [addProjectBusy, loadProjects, expandProject, setAddProjectOpen]);

  const handleUpdateProjectPresentation = useCallback(async (projectPath: string, updates: { alias?: string | null; sortOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }) => {
    try {
      const response = await fetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectPath, ...updates }) });
      if (!response.ok) throw new Error(t("projects.updateFailed"));
      await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [loadProjects, t]);

  /** Persist one whole-list order (positions + pinned state) as a single
   *  atomic batched PATCH, applied optimistically so the row lands at once. */
  const persistProjectOrder = useCallback(async (next: ManagedProject[]) => {
    // Supersede any in-flight list load so a stale response can't snap the
    // rows back before the PATCH lands.
    projectsLoadSeqRef.current += 1;
    const order = new Map(next.map((project, index) => [comparableProjectPath(project.path), { project, index }] as const));
    setProjects((prev) => {
      const seen = new Set<string>();
      const updated = prev.map((project) => {
        const key = comparableProjectPath(project.path);
        const hit = order.get(key);
        if (!hit) return project;
        seen.add(key);
        return { ...project, sortOrder: hit.index, pinned: hit.project.pinned || undefined };
      });
      // Placeholder rows (not yet in the server list) get registered by the PATCH.
      for (const [key, hit] of order) if (!seen.has(key)) updated.push({ ...hit.project, sortOrder: hit.index });
      return updated;
    });
    try {
      // One batched request: the server applies every entry in a single
      // atomic registry save, so per-project writes can't interleave and lose
      // updates. Discovered projects included here are registered server-side.
      const response = await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: next.map((project, index) => ({ cwd: project.path, sortOrder: index, pinned: Boolean(project.pinned) })) }),
      });
      if (!response.ok) throw new Error(t("projects.reorderFailed"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    // Reconcile with the server either way (reverts the optimistic order on failure).
    await loadProjects();
  }, [loadProjects, t]);

  const handleProjectDragStart = useCallback((projectPath: string) => {
    draggedProjectRef.current = projectPath;
    requestAnimationFrame(() => {
      if (draggedProjectRef.current === projectPath) setDraggedProjectPath(projectPath);
    });
  }, []);

  const handleProjectDragEnd = useCallback(() => {
    draggedProjectRef.current = null;
    setDraggedProjectPath(null);
    setProjectDropTarget(null);
  }, []);

  const handleProjectDragOver = useCallback((projectPath: string, position: "before" | "after" | null) => {
    setProjectDropTarget((prev) => {
      if (position === null) return prev === null ? prev : null;
      if (prev && "path" in prev && prev.path === projectPath && prev.position === position) return prev;
      return { path: projectPath, position };
    });
  }, []);

  const handleSectionDragOver = useCallback((pinned: boolean) => {
    setProjectDropTarget((prev) => (prev && "pinned" in prev && prev.pinned === pinned ? prev : { pinned }));
  }, []);

  const handleProjectDrop = useCallback(async (target: ProjectDropTarget) => {
    const sourcePath = draggedProjectRef.current;
    handleProjectDragEnd();
    if (!sourcePath) return;
    const next = moveManagedProject(sortedProjects, sourcePath, target);
    if (next) await persistProjectOrder(next);
  }, [handleProjectDragEnd, sortedProjects, persistProjectOrder]);

  /** Keyboard-accessible reorder: move one project up/down within its section. */
  const handleMoveProject = useCallback(async (projectPath: string, delta: -1 | 1) => {
    const next = shiftManagedProject(sortedProjects, projectPath, delta);
    if (next) await persistProjectOrder(next);
  }, [sortedProjects, persistProjectOrder]);

  const handleToggleProjectPinned = useCallback(async (projectPath: string) => {
    const project = sortedProjects.find((candidate) => candidate.path === projectPath);
    if (!project) return;
    const next = moveManagedProject(sortedProjects, projectPath, { pinned: !project.pinned });
    if (next) await persistProjectOrder(next);
  }, [sortedProjects, persistProjectOrder]);

  const handleRemoveProject = useCallback(async (projectPath: string) => {
    if (removeProjectPath) return;
    setRemoveProjectPath(projectPath);
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectPath }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!res.ok || !data.success) {
        toast.error(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      // Hiding the active project leaves nothing selected; activate the next
      // most-relevant project so New Session and Explorer stay usable.
      // Compare case-folded — the selected cwd can spell the project path
      // with different casing than this row (Windows/NTFS).
      if (selectedProject !== null && comparableProjectPath(selectedProject) === comparableProjectPath(projectPath)) {
        const next = sortedProjects.find((p) => p.path !== projectPath);
        setSelectedCwd(next ? next.path : null);
      }
      collapseProject(projectPath);
      await loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoveProjectPath(null);
    }
  }, [removeProjectPath, selectedProject, sortedProjects, collapseProject, loadProjects]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    // Operate against the active repo's own cached Git state — never a
    // globally stored path, so the branch is created in the correct repo.
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!branch || wtBusy || !activeState) return;
    const root = activeState.projectRoot;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string; code?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      const newWorktreePath: string = data.path;
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree against THIS repo's cached
      // entry so projectRootFor() resolves it to the main repo before the
      // refetch lands (keeps AppShell from treating the new cwd as a different
      // project). Other repos' cached state is untouched.
      setWorktreeStateByProject((prev) => {
        const key = normalizeProjectKey(root);
        const existing = prev[key];
        if (!existing) return prev;
        const newWt: WorktreeEntry = { path: newWorktreePath, branch, isMain: false };
        return { ...prev, [key]: { ...existing, forCwd: newWorktreePath, worktrees: [...existing.worktrees, newWt] } };
      });
      setSelectedCwd(newWorktreePath);
      setWtRefreshKey((k) => k + 1);
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, selectedProject, worktreeStateByProject, loadProjects, loadSessions]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    // Remove only from the active repo's own cached Git state.
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!activeState || wtBusy) return;
    const root = activeState.projectRoot;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean; code?: string };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      setWtConfirmRemove(null);
      // Optimistically remove the deleted worktree from the active project's state
      setWorktreeStateByProject((prev) => {
        const key = normalizeProjectKey(root);
        const existing = prev[key];
        if (!existing) return prev;
        const nextWorktrees = existing.worktrees.filter((w) => comparableProjectPath(w.path) !== comparableProjectPath(path));
        return {
          ...prev,
          [key]: {
            ...existing,
            forCwd: selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path) ? root : existing.forCwd,
            worktrees: nextWorktrees,
          },
        };
      });
      if (selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path)) {
        setSelectedCwd(root);
      }
      setWtRefreshKey((k) => k + 1);
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [selectedProject, worktreeStateByProject, wtBusy, selectedCwd, loadProjects, loadSessions]);

  // Reset the worktree dropdown's transient state (used by the portaled
  // dropdown's outside-press/Escape close, the branch toggle, and worktree
  // selection).
  const closeWorktreeDropdown = useCallback(() => {
    setWtDropdownOpen(false);
    setWtNewOpen(false);
    setWtNewBranch("");
    setWtError(null);
    setWtConfirmRemove(null);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees. Selecting a session also
  // activates and expands its containing project.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    provisionalSelectionRef.current = false;
    if (s.cwd) setSelectedCwd(s.cwd);
    expandProject(comparableProjectPath(workspaceKeyOf(s)));
    onSelectSession(s);
  }, [onSelectSession, expandProject]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImportSession = useCallback(async (file: File | null) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      const content = await file.text();
      const res = await fetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!res.ok || !data.success) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(t("sessionSidebar.imported"));
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [importing, loadSessions, loadProjects, t]);

  // Sessions of every worktree in the selected project are shown together.
  // Keys are comparableProjectPath forms (see expandProject) — comparable to
  // the folded registry paths rows are checked against.
  const expandedProjectKeys = expandedProjects ?? EMPTY_PROJECT_SET;

  // The active repo's own cached Git state, selected by repository root — never
  // a single sidebar-wide variable, so it is always the state belonging to the
  // repo the user currently has active.
  const activeGitState = selectedProject
    ? worktreeStateByProject[normalizeProjectKey(selectedProject)]
    : undefined;

  /** Inline branch label ("omp-web · main") from a project's OWN cached Git
   *  state. Returns null when the project has no Git state or is not a git
   *  repo, so a non-Git / not-yet-loaded project never shows another repo's
   *  branch. */
  const worktreeBranchForProject = useCallback((projectPath: string): string | null => {
    const state = worktreeStateByProject[normalizeProjectKey(projectPath)];
    if (!state || !state.isGit || !state.isTopLevel) return null;
    const current = state.worktrees.find((w) => normalizeProjectKey(w.path) === normalizeProjectKey(selectedCwd ?? ""))
      ?? state.worktrees.find((w) => w.isMain);
    if (!current) return null;
    return current.branch ?? displayCwd(current.path, homeDir);
  }, [worktreeStateByProject, selectedCwd, homeDir]);

  const showWorktreeSwitcher = Boolean(
    activeGitState?.isGit
    && activeGitState.isTopLevel
    && selectedCwd
    && selectedProject !== null
    // Case-folded: the active project may be spelled differently than the
    // server-resolved git root (Windows/NTFS), yet still be the same repo.
    && comparableProjectPath(selectedProject) === comparableProjectPath(activeGitState.projectRoot),
  );
  const toggleWorktrees = useCallback(() => {
    // Fold through closeWorktreeDropdown so closing never leaves the previous
    // worktree's confirm/new-branch transient state behind.
    if (wtDropdownOpen) closeWorktreeDropdown();
    else setWtDropdownOpen(true);
  }, [wtDropdownOpen, closeWorktreeDropdown]);

  // Stable callbacks for the session list so memoized children don't re-render
  // on every parent state change.
  const handleSessionDeleted = useCallback((id: string) => {
    const deleted = allSessions.find((session) => session.id === id);
    if (deleted) clearLastOpenSession(workspaceKeyOf(deleted));
    onSessionDeleted?.(id);
    loadSessions();
  }, [allSessions, onSessionDeleted, loadSessions]);

  useEffect(() => {
    const selected = allSessions.find((session) => session.id === selectedSessionId);
    if (selected) setLastOpenSession(workspaceKeyOf(selected), selected.id);
  }, [allSessions, selectedSessionId]);

  // row. Non-Git projects intentionally render no Git affordance at all. The
  // switcher shows the ACTIVE repo's own worktrees/branches only.
  const activeProjectSwitcher = showWorktreeSwitcher && activeGitState ? (
    <ProjectWorktreeSwitcher
      worktreeState={activeGitState}
      selectedCwd={selectedCwd}
      homeDir={homeDir}
      wtDropdownOpen={wtDropdownOpen}
      wtNewOpen={wtNewOpen}
      setWtNewOpen={setWtNewOpen}
      wtNewBranch={wtNewBranch}
      setWtNewBranch={setWtNewBranch}
      wtError={wtError}
      setWtError={setWtError}
      wtBusy={wtBusy}
      wtConfirmRemove={wtConfirmRemove}
      setWtConfirmRemove={setWtConfirmRemove}
      onSelectWorktree={(path) => {
        setSelectedCwd(path);
        closeWorktreeDropdown();
      }}
      onCreateWorktree={handleCreateWorktree}
      onRemoveWorktree={(path, force) => void handleRemoveWorktree(path, force)}
      anchorRef={wtToggleRef}
      newInputRef={wtNewInputRef}
      onClose={closeWorktreeDropdown}
    />
  ) : null;

  // Pinned workspaces render in their own leading section. sortedProjects is
  // pinned-first, so each section keeps the persisted order.
  const pinnedProjectEntries = visibleProjectEntries.filter((entry) => entry.project.pinned);
  const otherProjectEntries = visibleProjectEntries.filter((entry) => !entry.project.pinned);
  const draggedProject = draggedProjectPath === null ? undefined : sortedProjects.find((project) => project.path === draggedProjectPath);
  // An empty destination section still needs a drop target while dragging.
  const dragShowsPinZone = Boolean(draggedProject && !draggedProject.pinned && pinnedProjectEntries.length === 0);
  const dragShowsUnpinZone = Boolean(draggedProject?.pinned && otherProjectEntries.length === 0);
  const projectIndexByPath = new Map(sortedProjects.map((project, index) => [project.path, index] as const));
  const sameSectionNeighbor = (project: ManagedProject, delta: -1 | 1): boolean => {
    const index = projectIndexByPath.get(project.path);
    const neighbor = index === undefined ? undefined : sortedProjects[index + delta];
    return neighbor !== undefined && Boolean(neighbor.pinned) === Boolean(project.pinned);
  };

  const renderProjectRow = ({ project, sessions }: { project: ManagedProject; sessions: SessionInfo[] }) => {
    const tree = treesByProject.get(project.path) ?? buildSessionTree(sessions);
    // Sessions group under a project through the case-folded comparable
    // form (see groupSessionsByProject), so the active highlight must
    // use the same comparison: a session whose cwd/projectRoot spells
    // the project folder with different casing (Windows/NTFS) lands in
    // this row — the row must light up for it too.
    const isActive = selectedProject !== null && comparableProjectPath(selectedProject) === comparableProjectPath(project.path);
    // Each project's own branch comes from its own cached Git state —
    // a project never inherits another repo's branch. Only the active
    // repo's row owns the single switcher anchor so the dropdown opens
    // against the correct row.
    const projectBranch = worktreeBranchForProject(project.path);
    return (
      <ProjectRow
        key={project.path}
        project={project}
        isActive={isActive}
        activity={projectActivity.get(comparableProjectPath(project.path))}
        tree={tree}
        isExpanded={expandedProjectKeys.has(comparableProjectPath(project.path))}
        hiddenCount={filtersActive ? 0 : Math.max(0, tree.length - MAX_PROJECT_SESSIONS)}
        selectedSessionId={selectedSessionId}
        runningSessionIds={runningSessionIds}
        subagentCounts={subagentCounts}
        unreadSessionIds={unreadSessionIds}
        exitedSessions={exitedSessions}
        relativeTimeNow={relativeTimeNow}
        onActivate={activateProject}
        onToggleExpand={toggleProjectExpanded}
        onRemoveProject={handleRemoveProject}
        onEditLaunchConfig={setLaunchConfigProject}
        onUpdatePresentation={handleUpdateProjectPresentation}
        onTogglePinned={(path) => void handleToggleProjectPinned(path)}
        dragActive={draggedProjectPath !== null}
        isDragSource={draggedProjectPath === project.path}
        dropPosition={projectDropTarget !== null && "path" in projectDropTarget && projectDropTarget.path === project.path ? projectDropTarget.position : null}
        onDragStartProject={handleProjectDragStart}
        onDragEndProject={handleProjectDragEnd}
        onDragOverProject={handleProjectDragOver}
        onDropProject={(target) => void handleProjectDrop(target)}
        onMoveProject={(path, delta) => void handleMoveProject(path, delta)}
        canMoveUp={sameSectionNeighbor(project, -1)}
        canMoveDown={sameSectionNeighbor(project, 1)}
        removeBusy={removeProjectPath === project.path}
        onSelectSession={handleSelectSessionFromList}
        onRenamed={loadSessions}
        onSessionDeleted={handleSessionDeleted}
        activeWorktreeSwitcher={isActive ? activeProjectSwitcher : null}
        worktreeBranch={projectBranch}
        worktreeToggleRef={isActive && projectBranch ? wtToggleRef : undefined}
        worktreeOpen={isActive ? wtDropdownOpen : false}
        onToggleWorktrees={isActive ? toggleWorktrees : undefined}
        homeDir={homeDir}
      />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {addProjectOpen && (
        <DirectoryPicker
          busy={addProjectBusy}
          error={addProjectError}
          onCancel={() => {
            setAddProjectOpen(false);
            setAddProjectError(null);
          }}
          onSelect={(path, launchConfig) => void commitAddProject(path, launchConfig)}
        />
      )}
      {launchConfigProject && (
        <ProjectLaunchConfigDialog
          projectPath={launchConfigProject.path}
          initialConfig={launchConfigProject.launchConfig}
          onClose={() => setLaunchConfigProject(null)}
          onSave={async (launchConfig) => {
            await handleUpdateProjectPresentation(launchConfigProject.path, { launchConfig });
            toast.info(t("sessionSidebar.launchConfigSaved"));
          }}
        />
      )}
      {/* Header: branding + quiet utilities + New Session */}
      <div
        className="wallpaper-surface"
        style={{
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
          {/* The title clips instead of running under the buttons on narrow touch sidebars. */}
          <div style={{ minWidth: 0, overflow: "hidden" }}><OmpWebTitle /></div>
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            {headerAccessory}
            <Tooltip content={t("scheduledTasks.title")} side="bottom">
              <SidebarIconButton label={t("scheduledTasks.title")} onClick={openScheduledTasks}>
                <CalendarClock size={14} strokeWidth={1.9} aria-hidden="true" />
              </SidebarIconButton>
            </Tooltip>
            {onOpenArchive && (
              <Tooltip content={t("sessionSidebar.archiveBrowserTitle")} side="bottom">
                <SidebarIconButton
                  label={t("sessionSidebar.archiveBrowser")}
                  onClick={onOpenArchive}
                >
                  <Archive size={14} strokeWidth={1.9} aria-hidden="true" />
                </SidebarIconButton>
              </Tooltip>
            )}
            <Tooltip content={t("sessionSidebar.importTitle")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.import")}
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
              >
                <FileUp size={14} strokeWidth={1.9} aria-hidden="true" />
              </SidebarIconButton>
            </Tooltip>
            <Tooltip content={t("sessionSidebar.refresh")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.refresh")}
                active={sessionRefreshDone}
                onClick={() => {
                  loadSessions(false);
                  void loadProjects();
                }}
              >
                {sessionRefreshDone ? (
                  <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />
                )}
              </SidebarIconButton>
            </Tooltip>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".jsonl,.json,application/json,application/jsonl"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = "";
            void handleImportSession(file);
          }}
        />
        <button
          onClick={handleNewSession}
          disabled={!selectedCwd}
          className="sidebar-new-session wallpaper-inset"
          title={selectedCwd ? t("sessionSidebar.newSessionIn", { cwd: selectedCwd }) : t("sessionSidebar.selectProjectFirst")}
          style={{
            width: "100%",
            height: 38,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            color: selectedCwd ? "var(--text)" : "var(--text-dim)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            opacity: selectedCwd ? 1 : 0.65,
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => {
            if (!selectedCwd) return;
            e.currentTarget.style.background = "var(--bg-selected)";
            e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 30%, transparent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <Plus size={15} strokeWidth={2.2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
          <span>{t("sessionSidebar.new")}</span>
        </button>
      </div>

      {/* Workspaces section header: label + search / filter / add (hidden, not unmounted, in plugin mode) */}
      <div style={{ display: pluginsMode ? "none" : "contents" }}>
      <div className="wallpaper-surface" style={{ flexShrink: 0, padding: "4px 10px 2px", display: "flex", alignItems: "center", gap: 2 }}>
        <span
          style={{
            flex: 1,
            color: "var(--text-muted)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {t("projects.heading")}
        </span>
        <SidebarIconButton
          label={t("sessionSidebar.search")}
          title={t("sessionSidebar.searchTitle")}
          active={searchOpen}
          onClick={() => {
            const nextOpen = !searchOpen;
            setSearchOpen(nextOpen);
            if (nextOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
            else setSearchQuery("");
          }}
        >
          <Search size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SessionFilterMenu filters={sessionFilters} counts={filterCounts} onChange={setSessionFilters} />
        <SidebarIconButton
          label={t("projects.add")}
          title={t("projects.addTitle")}
          onClick={() => {
            setAddProjectOpen(true);
            setAddProjectError(null);
          }}
        >
          <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
      </div>
      <SessionFilterChips filters={sessionFilters} onChange={setSessionFilters} />
      {searchOpen && (
        <div style={{ padding: "0 10px 6px", flexShrink: 0 }}>
          <input
            className="sidebar-session-search"
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder={t("sessionSidebar.searchPlaceholder")}
            aria-label={t("sessionSidebar.search")}
            style={{
              width: "100%",
              height: 27,
              boxSizing: "border-box",
              padding: "0 9px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              outline: "none",
              color: "var(--text)",
              fontSize: 12,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
        </div>
      )}

      {/* Workspaces */}
        <div
          onDragLeave={(event) => {
            // Leaving the list entirely drops the stale insertion line.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setProjectDropTarget(null);
          }}
          style={{
            flex: "1 1 auto",
            overflowY: "auto",
            padding: "2px 10px 10px",
            minHeight: 80,
          }}
        >
          {loading && (
            <div role="status" aria-live="polite" aria-label={t("sessionSidebar.loading")} style={{ display: "grid", gap: 10, padding: "10px 4px" }}>
              <div aria-hidden="true" className="skeleton" style={{ width: "78%", height: 18 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "92%", height: 30 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "86%", height: 30 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "68%", height: 30 }} />
            </div>
          )}
          {projectsError && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>
              <span>{projectsError}</span>
              <button className="load-retry-button" type="button" onClick={() => { loadSessions(false); void loadProjects(); }} style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("sessionSidebar.refresh")}</button>
            </div>
          )}
          {error && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>
              <span>{error}</span>
              <button className="load-retry-button" type="button" onClick={() => { loadSessions(false); void loadProjects(); }} style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("sessionSidebar.refresh")}</button>
            </div>
          )}
          {!loading && !projectsError && !error && sortedProjects.length === 0 && (
            <div style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
              {t("projects.noProjects")}
            </div>
          )}
          {!loading && !projectsError && !error && sortedProjects.length > 0 && visibleProjectEntries.length === 0 && (
            <div style={{ padding: "14px 4px", color: "var(--text-dim)", fontSize: 11.5, lineHeight: 1.5 }}>
              {t("sessionSidebar.noMatches")}
            </div>
          )}

          {pinnedProjectEntries.length > 0 || dragShowsPinZone ? (
            <>
              <ProjectSectionLabel pinned label={t("projects.pinnedSection")} />
              {pinnedProjectEntries.length > 0 ? pinnedProjectEntries.map(renderProjectRow) : (
                <ProjectSectionDropZone
                  pinned
                  label={t("projects.dropToPin")}
                  highlighted={projectDropTarget !== null && "pinned" in projectDropTarget && projectDropTarget.pinned}
                  onDragOverZone={() => handleSectionDragOver(true)}
                  onDropZone={(target) => void handleProjectDrop(target)}
                />
              )}
              {(otherProjectEntries.length > 0 || dragShowsUnpinZone) && <ProjectSectionLabel label={t("projects.otherSection")} />}
            </>
          ) : null}
          {otherProjectEntries.length > 0 ? otherProjectEntries.map(renderProjectRow) : dragShowsUnpinZone && (
            <ProjectSectionDropZone
              pinned={false}
              label={t("projects.dropToUnpin")}
              highlighted={projectDropTarget !== null && "pinned" in projectDropTarget && !projectDropTarget.pinned}
              onDragOverZone={() => handleSectionDragOver(false)}
              onDropZone={(target) => void handleProjectDrop(target)}
            />
          )}
        </div>
      </div>
      <PluginsPanel visible={pluginsMode} activePluginId={activePluginId} onOpenPlugin={onOpenPlugin} onClosePlugin={onClosePlugin} />

      {/* Provider usage bar — pinned above Settings */}
      {usageVisible && <ProviderUsageBar />}
      {/* Pinned footer: Settings */}
      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          className="sidebar-settings-row"
          data-active={pluginsMode}
          aria-pressed={pluginsMode}
          onClick={togglePluginsMode}
          title={pluginsMode ? t("plugins.backToSessions") : t("plugins.title")}
          style={{
            width: "100%",
            height: 36,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 12px",
            background: pluginsMode ? "var(--bg-selected)" : "none",
            border: "none",
            color: pluginsMode ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = pluginsMode ? "var(--bg-selected)" : "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = pluginsMode ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = pluginsMode ? "var(--text)" : "var(--text-muted)"; }}
        >
          <Puzzle size={14} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 500 }}>
            {pluginsMode ? t("plugins.backToSessions") : t("plugins.title")}
          </span>
          <ChevronRight size={13} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />
        </button>
        <button
          className="sidebar-settings-row"
          data-active={settingsOpen}
          onClick={onOpenSettings}
          title={t("chatInput.settings")}
          aria-label={t("chatInput.settings")}
          style={{
            width: "100%",
            height: 36,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 12px",
            background: settingsOpen ? "var(--bg-selected)" : "none",
            border: "none",
            color: settingsOpen ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = settingsOpen ? "var(--bg-selected)" : "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = settingsOpen ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = settingsOpen ? "var(--text)" : "var(--text-muted)"; }}
        >
          <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
            <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
            {updateAvailable && (
              <span
                aria-label={t("skillsConfig.updateAvailable")}
                role="status"
                style={{ position: "absolute", top: -3, right: -4, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", border: "1px solid var(--bg-panel)" }}
              />
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 500 }}>
            {t("chatInput.settings")}
          </span>
          <ChevronRight size={13} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});



