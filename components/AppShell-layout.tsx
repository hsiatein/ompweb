"use client";

import type { ReactNode } from "react";
import { comparableProjectPath } from "@/lib/comparable-path";
import type { ManagedProject } from "@/lib/types";
import { CircleAlert, MessageSquareText } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** Options of the workspace selector shared by the new-session screen and the
 * scheduled-task editor: an "add workspace" entry (value ""), then the managed
 * projects in sidebar order (alias, or folder name with the path appended when
 * two names collide). `current` (possibly a worktree of `currentProject`) is
 * the selected value; it is listed even if it is not a managed project. */
export function workspaceSelectOptions(
  projects: readonly ManagedProject[],
  current: string,
  currentProject: string,
  addLabel: ReactNode,
): { value: string; label: ReactNode; title?: string }[] {
  const currentKey = currentProject ? comparableProjectPath(currentProject) : null;
  const listed = currentKey !== null && projects.some((project) => comparableProjectPath(project.path) === currentKey);
  return [
    { value: "", label: addLabel },
    ...(current && !listed ? [{ value: current, label: projectLabel(current), title: current }] : []),
    ...projects.map((project) => {
      const label = project.alias ?? projectLabel(project.path);
      const duplicate = projects.some((other) => other.path !== project.path && (other.alias ?? projectLabel(other.path)) === label);
      const isCurrent = currentKey !== null && comparableProjectPath(project.path) === currentKey;
      return { value: isCurrent ? current : project.path, label: duplicate ? `${label} — ${project.path}` : label, title: project.path };
    }),
  ];
}

// Resizable desktop sidebar: the width is stored on the container as the
// --sidebar-width CSS variable (globals.css) and persisted between sessions.
export const SIDEBAR_WIDTH_STORAGE_KEY = "omp-web:sidebar-width";
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 260;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const width = raw ? Number(raw) : NaN;
    return Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

// Resizable right (file) panel: null means the fluid 42% default; a number is
// a user-chosen pixel width persisted between sessions (same drag pattern as
// the left sidebar, mirrored — the handle sits on the panel's left edge).
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "omp-web:right-panel-width";
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 900;

export function clampRightPanelWidth(width: number): number {
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

export function loadRightPanelWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const width = Number(raw);
    return Number.isFinite(width) ? clampRightPanelWidth(width) : null;
  } catch {
    return null;
  }
}

type WorkspaceStateKind = "loading" | "error" | "empty";

export function WorkspaceState({
  kind,
  title,
  detail,
}: {
  kind: WorkspaceStateKind;
  title: string;
  detail?: ReactNode;
}) {
  return (
    <div
      className={`workspace-state workspace-state-${kind}`}
      role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}
      aria-busy={kind === "loading" ? true : undefined}
      aria-label={kind === "loading" ? title : undefined}
    >
      <div className="workspace-state-surface">
        {kind === "loading" ? (
          <div className="workspace-state-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : kind === "error" ? (
          <CircleAlert className="workspace-state-icon" size={18} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <MessageSquareText className="workspace-state-icon" size={18} strokeWidth={1.8} aria-hidden="true" />
        )}
        <div className="workspace-state-copy">
          <div className="workspace-state-title">{title}</div>
          {detail ? <div className="workspace-state-detail">{detail}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function PanelLoadingFallback() {
  const { t } = useI18n();
  return <WorkspaceState kind="loading" title={t("appShell.loading")} />;
}
