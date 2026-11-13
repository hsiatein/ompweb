"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarClock, Check as CheckIcon, ChevronDown, Copy, Cpu, KeyRound, MessageSquare, Pencil, Play, Plus, RefreshCw, SquarePlus, Trash2, X } from "lucide-react";
import { Alert, Check, ConfirmDialog, Field, NumInput, Select, TextInput } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle, InfoHint, Tooltip } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { copyText } from "@/lib/clipboard";
import { formatApiError } from "@/lib/i18n/api-error";
import { DEFAULT_WEBHOOK_LISTEN_PORT, MIN_INTERVAL_MINUTES, type ScheduleRepeat } from "@/lib/schedule-recurrence";
import type { ScheduledTaskRunView, ScheduledTaskView, WebhookEndpointView } from "@/lib/scheduled-tasks";
import type { NetworkInterfaceInfo } from "@/lib/webhook-listeners";
import { SCHEDULED_TASKS_OPEN_EVENT } from "@/lib/scheduled-tasks-ui";
import { selectableThinkingLevels } from "@/lib/thinking-levels";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import { sortManagedProjects } from "@/lib/project-ordering";
import { workspaceSelectOptions } from "./AppShell-layout";
import { DirectoryPicker } from "./DirectoryPicker";
import { COMPOSER_MODELS_STORAGE_KEY, compareModelOptions, filterModelOptions, readVisibleModelKeys, type ModelOption } from "./ChatInput-model-options";
import { ModelPickerPanel } from "./ChatInput-model-picker";
import "./scheduled-tasks.css";

const NO_WORKSPACE = "\u0000no-workspace";

type T = (key: string, vars?: Record<string, string | number>) => string;

interface CatalogModel { id: string; name?: string; provider: string; thinkingLevels?: string[] }

const RECENT_RUNS = 10;
const MAX_SESSION_CHOICES = 300;

async function request<R>(url: string, init?: RequestInit): Promise<R> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({})) as R & { error?: string; code?: string };
  if (!response.ok || body.error) throw new Error(formatApiError({ ...body, error: body.error ?? `HTTP ${response.status}` }));
  return body;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function formatAt(at: number, locale: string): string {
  return new Date(at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Short weekday names, index 0 = Sunday (2026-10-18 is a Sunday). */
function weekdayNames(locale: string): string[] {
  return Array.from({ length: 7 }, (_, day) => new Date(2026, 9, 18 + day).toLocaleDateString(locale, { weekday: "short" }));
}

function describeRepeat(repeat: ScheduleRepeat, t: T, locale: string): string {
  switch (repeat.kind) {
    case "once": return t("scheduledTasks.repeatOnceAt", { time: formatAt(repeat.at, locale) });
    case "interval": {
      const interval = repeat.minutes % 60 === 0
        ? t("scheduledTasks.hours", { count: repeat.minutes / 60 })
        : t("scheduledTasks.minutes", { count: repeat.minutes });
      return t("scheduledTasks.repeatEvery", { interval });
    }
    case "daily": return t("scheduledTasks.repeatDailyAt", { time: repeat.time });
    case "weekly": {
      const names = weekdayNames(locale);
      return t("scheduledTasks.repeatWeeklyAt", { days: repeat.days.map((day) => names[day]).join(", "), time: repeat.time });
    }
    case "webhook": return t("scheduledTasks.repeatWebhook");
  }
}

function nextRunText(task: ScheduledTaskView, t: T, locale: string): string {
  if (!task.enabled) return t("scheduledTasks.paused");
  if (task.repeat.kind === "webhook") return t("scheduledTasks.waitingForWebhook");
  if (task.nextRunAt === null) return t("scheduledTasks.noNextRun");
  return t("scheduledTasks.nextRun", { time: formatAt(task.nextRunAt, locale) });
}

function runLabel(run: ScheduledTaskRunView, t: T): string {
  if (run.running) return t("scheduledTasks.runRunning");
  if (run.status === "skipped") return t("scheduledTasks.runSkipped");
  if (run.status === "failed") return t("scheduledTasks.runFailed");
  return run.timedOut ? t("scheduledTasks.runTimedOut") : t("scheduledTasks.runStarted");
}

function sessionLabel(session: SessionInfo): string {
  const title = session.name?.trim() || session.firstMessage.replace(/\s+/g, " ").trim() || session.id;
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

/** The workspace a session belongs to (worktrees group under their repo). */
function sessionWorkspace(session: SessionInfo): string {
  return session.projectRoot ?? session.cwd;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** `<input type="datetime-local">` value in local time. */
function toLocalInput(at: number): string {
  return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

interface Draft {
  target: "new" | "session";
  /** Workspace whose sessions the session picker lists. */
  sessionWorkspace: string;
  sessionId: string;
  name: string;
  cwd: string;
  message: string;
  kind: ScheduleRepeat["kind"];
  onceAt: string;
  intervalValue: string;
  intervalUnit: "minutes" | "hours";
  time: string;
  days: number[];
  model: string;
  thinkingLevel: string;
  advisor: boolean;
  keepRuns: string;
  maxRunMinutes: string;
  enabled: boolean;
  webhookIncludeBody: boolean;
  /** "server": omp-web's own URL; "dedicated": a listener on chosen interfaces. */
  listenMode: "server" | "dedicated";
  listenInterfaces: string[];
  listenPort: string;
}

function draftFor(task: ScheduledTaskView | null, defaults: { cwd: string; sessionId: string | null }, sessions: SessionInfo[]): Draft {
  const repeat = task?.repeat;
  const intervalMinutes = repeat?.kind === "interval" ? repeat.minutes : 60;
  const sessionId = task?.targetSessionId ?? defaults.sessionId ?? "";
  const session = sessions.find((entry) => entry.id === sessionId);
  return {
    target: task ? (task.targetSessionId ? "session" : "new") : "new",
    sessionWorkspace: session ? sessionWorkspace(session) : task?.targetSessionId ? task.cwd : defaults.cwd,
    sessionId,
    name: task?.name ?? "",
    cwd: task && !task.targetSessionId ? task.cwd : defaults.cwd,
    message: task?.message ?? "",
    kind: repeat?.kind ?? "daily",
    onceAt: toLocalInput(repeat?.kind === "once" ? repeat.at : Date.now() + 3_600_000),
    intervalValue: String(intervalMinutes % 60 === 0 ? intervalMinutes / 60 : intervalMinutes),
    intervalUnit: intervalMinutes % 60 === 0 ? "hours" : "minutes",
    time: repeat?.kind === "daily" || repeat?.kind === "weekly" ? repeat.time : "09:00",
    days: repeat?.kind === "weekly" ? repeat.days : [1, 2, 3, 4, 5],
    model: task?.provider && task.modelId ? `${task.provider}/${task.modelId}` : "",
    thinkingLevel: task?.thinkingLevel ?? "",
    advisor: task?.advisor ?? false,
    keepRuns: String(task?.keepRuns ?? 10),
    maxRunMinutes: String(task?.maxRunMinutes ?? 60),
    enabled: task?.enabled ?? true,
    webhookIncludeBody: task?.webhookIncludeBody ?? false,
    listenMode: task?.webhookListen ? "dedicated" : "server",
    listenInterfaces: task?.webhookListen?.interfaces ?? [],
    listenPort: String(task?.webhookListen?.port ?? DEFAULT_WEBHOOK_LISTEN_PORT),
  };
}

/** The request body for a draft, or a localized error. */
function draftToInput(draft: Draft, t: T): Record<string, unknown> | string {
  let repeat: ScheduleRepeat;
  if (draft.kind === "once") {
    const at = new Date(draft.onceAt).getTime();
    if (!Number.isFinite(at)) return t("scheduledTasks.errorTime");
    repeat = { kind: "once", at };
  } else if (draft.kind === "interval") {
    const minutes = Number(draft.intervalValue) * (draft.intervalUnit === "hours" ? 60 : 1);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES) return t("scheduledTasks.errorInterval", { min: MIN_INTERVAL_MINUTES });
    repeat = { kind: "interval", minutes };
  } else if (draft.kind === "daily") {
    repeat = { kind: "daily", time: draft.time };
  } else if (draft.kind === "weekly") {
    if (draft.days.length === 0) return t("scheduledTasks.errorDays");
    repeat = { kind: "weekly", days: draft.days, time: draft.time };
  } else {
    repeat = { kind: "webhook" };
  }
  let webhookListen: { interfaces: string[]; port: number } | null = null;
  if (draft.kind === "webhook" && draft.listenMode === "dedicated") {
    const port = Number(draft.listenPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return t("scheduledTasks.errorListenPort");
    if (draft.listenInterfaces.length === 0) return t("scheduledTasks.errorListenInterfaces");
    webhookListen = { interfaces: draft.listenInterfaces, port };
  }
  const common = { name: draft.name, message: draft.message, repeat, enabled: draft.enabled, advisor: draft.advisor, webhookIncludeBody: draft.webhookIncludeBody, webhookListen };
  if (draft.target === "session") {
    if (!draft.sessionId) return t("scheduledTasks.errorSession");
    return { ...common, targetSessionId: draft.sessionId };
  }
  // Provider ids carry no "/", model ids may.
  const slash = draft.model.indexOf("/");
  return {
    ...common,
    cwd: draft.cwd,
    ...(slash > 0 ? { provider: draft.model.slice(0, slash), modelId: draft.model.slice(slash + 1) } : {}),
    ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    keepRuns: Number(draft.keepRuns),
    maxRunMinutes: Number(draft.maxRunMinutes),
  };
}

/** The composer's model picker (same panel, same visible-model filter), plus
 * a "default model" row: a task may leave the model to omp's default. */
function TaskModelPicker({ models, value, onChange }: {
  models: CatalogModel[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  // Opens below the trigger, or above when the editor's scroll area has more room there.
  const [placement, setPlacement] = useState<{ up: boolean; height: number }>({ up: false, height: 360 });
  const [query, setQuery] = useState("");
  const [visibleKeys, setVisibleKeys] = useState<Set<string> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  useEffect(() => {
    const refresh = () => setVisibleKeys(readVisibleModelKeys());
    const fromStorage = (event: StorageEvent) => { if (event.key === null || event.key === COMPOSER_MODELS_STORAGE_KEY) refresh(); };
    refresh();
    window.addEventListener("omp-composer-models-change", refresh);
    window.addEventListener("storage", fromStorage);
    return () => {
      window.removeEventListener("omp-composer-models-change", refresh);
      window.removeEventListener("storage", fromStorage);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const collator = useMemo(() => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }), [locale]);
  const options: ModelOption[] = useMemo(() => models
    .map((entry) => ({ provider: entry.provider, modelId: entry.id, name: entry.name ?? entry.id }))
    .filter((option) => visibleKeys === null || visibleKeys.has(`${option.provider}:${option.modelId}`))
    .sort((a, b) => compareModelOptions(collator, a, b)), [models, visibleKeys, collator]);
  const filtered = useMemo(() => filterModelOptions(options, query, locale), [options, query, locale]);
  const slash = value.indexOf("/");
  const current = slash > 0 ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) } : null;
  const currentEntry = current ? models.find((entry) => entry.provider === current.provider && entry.id === current.modelId) : undefined;
  const label = current ? currentEntry?.name ?? current.modelId : t("scheduledTasks.defaultModel");
  const close = () => { setOpen(false); setQuery(""); };
  const toggle = () => {
    if (open) { close(); return; }
    const trigger = rootRef.current?.getBoundingClientRect();
    const area = rootRef.current?.closest(".sched-main")?.getBoundingClientRect();
    if (trigger && area) {
      const below = area.bottom - trigger.bottom - 8;
      const above = trigger.top - area.top - 8;
      const up = below < 360 && above > below;
      setPlacement({ up, height: Math.max(220, Math.min(360, up ? above : below)) });
    }
    setOpen(true);
  };
  return (
    <div ref={rootRef} className="sched-model-picker" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
      <button type="button" className="sched-input sched-model-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId}
        title={current ? `${current.provider} / ${current.modelId}` : undefined} onClick={toggle}>
        <Cpu size={13} aria-hidden="true" />
        <span className="sched-ellipsis">{label}</span>
        {current && <span className="sched-model-provider">{current.provider}</span>}
        <ChevronDown size={13} aria-hidden="true" style={{ marginLeft: "auto", transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label={t("chatInput.modelsLabel")} className="picker-panel sched-model-panel"
          style={placement.up ? { bottom: "calc(100% + 4px)", height: placement.height } : { top: "calc(100% + 4px)", height: placement.height }}>
          <button type="button" className="picker-row" data-active={!current} role="menuitemradio" aria-checked={!current} onClick={() => { onChange(""); close(); }}>
            <span className="picker-check">{!current && <CheckIcon size={11} strokeWidth={2.4} aria-hidden="true" />}</span>
            <span>{t("scheduledTasks.defaultModel")}</span>
          </button>
          <ModelPickerPanel
            modelOptions={options}
            filteredModelOptions={filtered}
            currentModel={current}
            modelSearchQuery={query}
            onSearchQueryChange={setQuery}
            searchInputRef={searchRef}
            showModelsLoading={models.length === 0}
            onSelectModel={(provider, modelId) => { onChange(`${provider}/${modelId}`); close(); }}
            onClose={close}
          />
        </div>
      )}
    </div>
  );
}

function TaskEditor({ task, defaults, sessions, timeZone, interfaces, onCancel, onSaved }: {
  task: ScheduledTaskView | null;
  defaults: { cwd: string; sessionId: string | null };
  sessions: SessionInfo[];
  timeZone: string | null;
  interfaces: NetworkInterfaceInfo[];
  onCancel: () => void;
  onSaved: (task: ScheduledTaskView) => void;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState(() => draftFor(task, defaults, sessions));
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [addWorkspaceBusy, setAddWorkspaceBusy] = useState(false);
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); setError(null); };

  const loadProjects = useCallback(() => request<{ projects?: (ManagedProject & { hidden?: boolean })[] }>("/api/projects")
    .then((body) => setProjects(sortManagedProjects((body.projects ?? []).filter((project) => !project.hidden))), () => {}), []);
  useEffect(() => { void loadProjects(); }, [loadProjects]);
  // Same catalog the composer sees for this workspace.
  const modelsCwd = draft.target === "new" ? draft.cwd : "";
  useEffect(() => {
    void request<{ modelList?: CatalogModel[] }>(modelsCwd ? `/api/models?cwd=${encodeURIComponent(modelsCwd)}` : "/api/models")
      .then((body) => setModels(body.modelList ?? []), () => {});
  }, [modelsCwd]);
  const addWorkspace = async (path: string, launchConfig?: ManagedProject["launchConfig"]) => {
    setAddWorkspaceBusy(true);
    setAddWorkspaceError(null);
    try {
      const body = await request<{ project?: ManagedProject }>("/api/projects", jsonInit("POST", { cwd: path, launchConfig }));
      await loadProjects();
      if (body.project) update({ cwd: body.project.path });
      setAddingWorkspace(false);
    } catch (addError) {
      setAddWorkspaceError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setAddWorkspaceBusy(false);
    }
  };

  const selectedModel = models.find((entry) => `${entry.provider}/${entry.id}` === draft.model);
  const thinkingLevels = selectableThinkingLevels(selectedModel?.thinkingLevels ?? null);
  const names = weekdayNames(locale);
  // Sessions arrive newest first, so workspaces are ordered by latest activity.
  const workspaces = useMemo(() => [...new Set(sessions.map(sessionWorkspace))], [sessions]);
  const workspaceSessions = useMemo(
    () => sessions.filter((session) => sessionWorkspace(session) === draft.sessionWorkspace).slice(0, MAX_SESSION_CHOICES),
    [sessions, draft.sessionWorkspace],
  );

  const save = async () => {
    const input = draftToInput(draft, t);
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setSaving(true);
    try {
      const body = await request<{ task: ScheduledTaskView }>(
        task ? `/api/scheduled-tasks/${encodeURIComponent(task.id)}` : "/api/scheduled-tasks",
        jsonInit(task ? "PATCH" : "POST", input),
      );
      onSaved(body.task);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sched-form">
      <h3 className="sched-detail-title">{task ? t("scheduledTasks.editTitle") : t("scheduledTasks.newTitle")}</h3>
      <Field label={t("scheduledTasks.name")} required>
        <TextInput value={draft.name} onChange={(name) => update({ name })} placeholder={t("scheduledTasks.namePlaceholder")} />
      </Field>
      <div role="radiogroup" aria-label={t("scheduledTasks.target")} className="sched-target">
        {(["new", "session"] as const).map((target) => (
          <label key={target} className="sched-target-option" data-selected={draft.target === target}>
            <input type="radio" name="sched-target" checked={draft.target === target} onChange={() => update({ target })} />
            {target === "new" ? <SquarePlus size={15} aria-hidden="true" /> : <MessageSquare size={15} aria-hidden="true" />}
            <strong>{t(target === "new" ? "scheduledTasks.targetNew" : "scheduledTasks.targetSession")}</strong>
            {target === "session" && <span className="hint-chip">{t("scheduledTasks.queuesWhenBusy")}</span>}
          </label>
        ))}
      </div>
      {draft.target === "session" ? (
        <div className="sched-row">
          <Field label={t("scheduledTasks.workspace")} style={{ flex: 1, minWidth: 160 }} required>
            <Select
              className="sched-input"
              value={draft.sessionWorkspace}
              onChange={(nextValue) => {
                const workspace = nextValue;
                // Keep the session only if it belongs to the new workspace.
                const keep = sessions.some((session) => session.id === draft.sessionId && sessionWorkspace(session) === workspace);
                update({ sessionWorkspace: workspace, sessionId: keep ? draft.sessionId : "" });
              }}
              options={[
                { value: "", label: t("scheduledTasks.pickWorkspace") },
                ...(draft.sessionWorkspace && !workspaces.includes(draft.sessionWorkspace) ? [{ value: draft.sessionWorkspace, label: folderName(draft.sessionWorkspace) }] : []),
                ...workspaces.map((workspace) => (
                ({ value: workspace, label: workspaces.some((other) => other !== workspace && folderName(other) === folderName(workspace)) ? `${folderName(workspace)} — ${workspace}` : folderName(workspace), title: workspace })
              )),
              ]}
            />
          </Field>
          <Field label={t("scheduledTasks.session")} style={{ flex: 2, minWidth: 200 }} required>
            <Select
              className="sched-input"
              value={draft.sessionId}
              disabled={!draft.sessionWorkspace}
              onChange={(nextValue) => update({ sessionId: nextValue })}
              options={[
                { value: "", label: t(workspaceSessions.length ? "scheduledTasks.pickSession" : "scheduledTasks.noSessionsInWorkspace") },
                ...(draft.sessionId && !workspaceSessions.some((session) => session.id === draft.sessionId) ? [{ value: draft.sessionId, label: draft.sessionId }] : []),
                ...workspaceSessions.map((session) => (
                ({ value: session.id, label: session.worktreeBranch ? `${sessionLabel(session)} — ${session.worktreeBranch}` : sessionLabel(session) })
              )),
              ]}
            />
          </Field>
        </div>
      ) : (
        <Field label={t("scheduledTasks.workspace")} required>
          <Select
            className="sched-input"
            // "" is the add-workspace entry, so an empty draft shows a separate prompt row.
            value={draft.cwd || NO_WORKSPACE}
            onChange={(cwd) => {
              if (cwd === NO_WORKSPACE) return;
              if (!cwd) { setAddingWorkspace(true); return; }
              update({ cwd });
            }}
            options={[
              ...(draft.cwd ? [] : [{ value: NO_WORKSPACE, label: t("scheduledTasks.pickWorkspace") }]),
              ...workspaceSelectOptions(projects, draft.cwd, draft.cwd, <>+ {t("projects.add")}</>),
            ]}
          />
          {draft.cwd && <span className="sched-mono sched-workspace-path" title={draft.cwd}>{draft.cwd}</span>}
        </Field>
      )}
      <Field label={t("scheduledTasks.prompt")} required>
        <textarea className="sched-input" value={draft.message} onChange={(event) => update({ message: event.target.value })} rows={5} placeholder={t("scheduledTasks.promptPlaceholder")} />
      </Field>
      <div className="sched-row">
        <Field label={t("scheduledTasks.repeat")} style={{ flex: 1 }}>
          <Select
            className="sched-input"
            value={draft.kind}
            onChange={(nextValue) => update({ kind: nextValue as Draft["kind"] })}
            options={[
              { value: "daily", label: t("scheduledTasks.kindDaily") },
              { value: "weekly", label: t("scheduledTasks.kindWeekly") },
              { value: "interval", label: t("scheduledTasks.kindInterval") },
              { value: "once", label: t("scheduledTasks.kindOnce") },
              { value: "webhook", label: t("scheduledTasks.kindWebhook") },
            ]}
          />
        </Field>
        {draft.kind === "once" && (
          <Field label={t("scheduledTasks.runAt")} style={{ flex: 1 }}>
            <input className="sched-input" type="datetime-local" value={draft.onceAt} onChange={(event) => update({ onceAt: event.target.value })} />
          </Field>
        )}
        {draft.kind === "interval" && (
          <>
            <Field label={t("scheduledTasks.every")} style={{ width: 90 }}>
              <NumInput value={draft.intervalValue} onChange={(intervalValue) => update({ intervalValue })} />
            </Field>
            <Field label={t("scheduledTasks.unit")} style={{ width: 110 }}>
              <Select
                className="sched-input"
                value={draft.intervalUnit}
                onChange={(nextValue) => update({ intervalUnit: nextValue as Draft["intervalUnit"] })}
                options={[
                  { value: "minutes", label: t("scheduledTasks.unitMinutes") },
                  { value: "hours", label: t("scheduledTasks.unitHours") },
                ]}
              />
            </Field>
          </>
        )}
        {(draft.kind === "daily" || draft.kind === "weekly") && (
          <Field label={t("scheduledTasks.time")} style={{ width: 130 }}>
            <input className="sched-input" type="time" value={draft.time} onChange={(event) => update({ time: event.target.value })} />
          </Field>
        )}
        {draft.kind !== "webhook" && <ScheduleZone timeZone={draft.kind === "interval" ? null : timeZone} />}
      </div>
      {draft.kind === "weekly" && (
        <div role="group" aria-label={t("scheduledTasks.days")} className="sched-days">
          {[1, 2, 3, 4, 5, 6, 0].map((day) => (
            <Check
              key={day}
              label={names[day]}
              checked={draft.days.includes(day)}
              onChange={(checked) => update({ days: checked ? [...draft.days, day].sort((a, b) => a - b) : draft.days.filter((value) => value !== day) })}
            />
          ))}
        </div>
      )}
      {draft.kind === "webhook" && (
        <>
          <Check label={t("scheduledTasks.webhookIncludeBody")} checked={draft.webhookIncludeBody} onChange={(webhookIncludeBody) => update({ webhookIncludeBody })} />
          <WebhookListenEditor draft={draft} interfaces={interfaces} update={update} />
        </>
      )}
      {task?.webhookToken && draft.kind !== "webhook" && <Alert variant="warning" description={t("scheduledTasks.webhookWillRevoke")} />}
      {draft.target === "new" && (
        <>
          <div className="sched-row">
            <Field label={t("scheduledTasks.model")} style={{ flex: 2 }}>
              <TaskModelPicker models={models} value={draft.model} onChange={(model) => update({ model, thinkingLevel: "" })} />
            </Field>
            <Field label={t("scheduledTasks.thinking")} style={{ flex: 1 }}>
              <Select
                className="sched-input"
                value={draft.thinkingLevel}
                onChange={(nextValue) => update({ thinkingLevel: nextValue })}
                options={[
                  { value: "", label: t("scheduledTasks.defaultThinking") },
                  ...thinkingLevels.map((level) => ({ value: level, label: level })),
                ]}
              />
            </Field>
          </div>
          <div className="sched-inline-group">
            <InlineNumber template={t("scheduledTasks.keepRunsInline")} value={draft.keepRuns} onChange={(keepRuns) => update({ keepRuns })} />
            <InlineNumber template={t("scheduledTasks.maxRunInline")} value={draft.maxRunMinutes} onChange={(maxRunMinutes) => update({ maxRunMinutes })} />
          </div>
        </>
      )}
      <div className="sched-days">
        <Check label={t("scheduledTasks.enabled")} checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
        <Check label={t("scheduledTasks.advisor")} checked={draft.advisor} onChange={(advisor) => update({ advisor })} />
      </div>
      {error && <Alert variant="error" description={error} />}
      <div className="sched-actions sched-actions-end">
        <button type="button" className="sched-button ui-focus-ring" onClick={onCancel}>{t("scheduledTasks.cancel")}</button>
        <button type="button" className="sched-button sched-primary ui-focus-ring" onClick={() => void save()} disabled={saving}>{t("scheduledTasks.save")}</button>
      </div>
      {addingWorkspace && (
        <DirectoryPicker
          busy={addWorkspaceBusy}
          error={addWorkspaceError}
          onCancel={() => { setAddingWorkspace(false); setAddWorkspaceError(null); }}
          onSelect={(path, launchConfig) => void addWorkspace(path, launchConfig)}
        />
      )}
    </div>
  );
}

/** "Keep the last {n} runs" with the number input in place of `{n}`. */
function InlineNumber({ template, value, onChange }: { template: string; value: string; onChange: (value: string) => void }) {
  const [before, after = ""] = template.split("{n}");
  return (
    <label className="sched-inline">
      {before && <span>{before}</span>}
      <span className="sched-inline-input"><NumInput value={value} onChange={onChange} /></span>
      {after && <span>{after}</span>}
    </label>
  );
}

/** Server time-zone marker for wall-clock schedules, with the run rules behind "?". */
function ScheduleZone({ timeZone }: { timeZone: string | null }) {
  const { t } = useI18n();
  return (
    <span className="sched-zone">
      {timeZone && <span className="hint-chip">{t("scheduledTasks.serverTimeZone", { zone: timeZone })}</span>}
      <InfoHint label={t("scheduledTasks.rulesLabel")}>{t("scheduledTasks.rules")}</InfoHint>
    </span>
  );
}

/** Where the webhook URL works: omp-web's own address, or a dedicated port on chosen interfaces. */
function WebhookListenEditor({ draft, interfaces, update }: {
  draft: Draft;
  interfaces: NetworkInterfaceInfo[];
  update: (patch: Partial<Draft>) => void;
}) {
  const { t } = useI18n();
  // Chosen interfaces that are down right now still show, so they can be kept or dropped.
  const known = new Set(interfaces.map((entry) => entry.name));
  const rows = [
    ...interfaces,
    ...draft.listenInterfaces.filter((name) => !known.has(name)).map((name) => ({ name, addresses: [], internal: false })),
  ];
  return (
    <div className="sched-listen">
      <div className="sched-row">
        <Field label={t("scheduledTasks.listen")} style={{ flex: 2 }}>
          <Select
            className="sched-input"
            value={draft.listenMode}
            onChange={(nextValue) => update({ listenMode: nextValue as Draft["listenMode"] })}
            options={[
              { value: "server", label: t("scheduledTasks.listenServer") },
              { value: "dedicated", label: t("scheduledTasks.listenDedicated") },
            ]}
          />
        </Field>
        {draft.listenMode === "dedicated" && (
          <Field label={t("scheduledTasks.listenPort")} style={{ width: 110 }}>
            <NumInput value={draft.listenPort} onChange={(listenPort) => update({ listenPort })} />
          </Field>
        )}
      </div>
      {draft.listenMode === "dedicated" && (
        <div role="group" aria-label={t("scheduledTasks.listenInterfaces")} className="sched-listen-ifaces">
          {rows.map((entry) => (
            <Check
              key={entry.name}
              label={`${entry.name} · ${entry.addresses.length ? entry.addresses.join(", ") : t("scheduledTasks.interfaceDown")}`}
              checked={draft.listenInterfaces.includes(entry.name)}
              onChange={(checked) => update({
                listenInterfaces: checked ? [...draft.listenInterfaces, entry.name] : draft.listenInterfaces.filter((name) => name !== entry.name),
              })}
            />
          ))}
          <p className="sched-dim sched-listen-hint">{t("scheduledTasks.listenHint")}</p>
        </div>
      )}
    </div>
  );
}

function WebhookInfo({ urls, endpoints, includeBody, onRegenerate }: {
  urls: string[];
  /** Dedicated-listener status rows (down interfaces, bind errors); absent for omp-web's own URL. */
  endpoints?: WebhookEndpointView[];
  includeBody: boolean;
  onRegenerate: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const example = urls[0] ?? "";
  const curl = includeBody
    ? `curl -X POST -H 'Content-Type: application/json' -d '{"example":true}' '${example}'`
    : `curl -X POST '${example}'`;
  const copy = (text: string) => {
    void copyText(text).then(() => toast.success(t("scheduledTasks.copied")), () => toast.error(t("scheduledTasks.copyFailed")));
  };
  return (
    <section className="sched-webhook" aria-label={t("scheduledTasks.webhookUrl")}>
      <div className="sched-runs-title">{t("scheduledTasks.webhookUrl")}</div>
      {endpoints ? endpoints.map((endpoint) => (
        <div key={`${endpoint.iface}|${endpoint.address ?? ""}`} className="sched-webhook-row">
          <span className="hint-chip">{endpoint.iface}</span>
          {endpoint.url ? <code className="sched-webhook-url">{endpoint.url}</code> : <span className="sched-dim sched-webhook-url">{t("scheduledTasks.interfaceDown")}</span>}
          {endpoint.error && endpoint.url && <span className="sched-webhook-error" role="status">{t("scheduledTasks.listenError", { error: endpoint.error })}</span>}
          {endpoint.url && <button type="button" className="sched-button ui-focus-ring" onClick={() => copy(endpoint.url!)}><Copy size={13} aria-hidden="true" />{t("scheduledTasks.copy")}</button>}
        </div>
      )) : urls.map((url) => (
        <div key={url} className="sched-webhook-row">
          <code className="sched-webhook-url">{url}</code>
          <button type="button" className="sched-button ui-focus-ring" onClick={() => copy(url)}><Copy size={13} aria-hidden="true" />{t("scheduledTasks.copy")}</button>
        </div>
      ))}
      {example && (
        <div className="sched-webhook-row">
          <code className="sched-webhook-url sched-dim">{curl}</code>
          <button type="button" className="sched-button ui-focus-ring" onClick={() => copy(curl)}><Copy size={13} aria-hidden="true" />curl</button>
        </div>
      )}
      <p className="sched-webhook-meta">
        <span className="sched-credential"><KeyRound size={13} aria-hidden="true" />{t("scheduledTasks.webhookCredential")}</span>
        <span className="hint-chip">{t(includeBody ? "scheduledTasks.webhookBodyIncluded" : "scheduledTasks.webhookBodyIgnored")}</span>
      </p>
      <div className="sched-actions">
        <button type="button" className="sched-button ui-focus-ring" onClick={() => setConfirming(true)}><RefreshCw size={13} aria-hidden="true" />{t("scheduledTasks.webhookRegenerate")}</button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("scheduledTasks.webhookRegenerate")}
        description={t("scheduledTasks.webhookRegenerateConfirm")}
        confirmLabel={t("scheduledTasks.webhookRegenerate")}
        cancelLabel={t("scheduledTasks.cancel")}
        danger
        onConfirm={() => { setConfirming(false); onRegenerate(); }}
      />
    </section>
  );
}

function TaskDetail({ task, session, timeZone, onEdit, onDelete, onChanged, onOpenSession }: {
  task: ScheduledTaskView;
  session: SessionInfo | undefined;
  timeZone: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => Promise<void>;
  onOpenSession: (sessionId: string, cwd: string) => void;
}) {
  const { t, locale } = useI18n();

  const act = async (body: unknown, success?: string) => {
    try {
      await request(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, jsonInit("PATCH", body));
      if (success) toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    await onChanged();
    // A manual run starts in the background; pick up its record shortly.
    setTimeout(() => { void onChanged(); }, 3_000);
  };

  const recent = task.runs.slice(-RECENT_RUNS).reverse();
  return (
    <div className="sched-detail">
      <h3 className="sched-detail-title">{task.name}</h3>
      <dl className="sched-facts">
        <dt>{t("scheduledTasks.target")}</dt>
        <dd>
          {task.targetSessionId ? (
            <button type="button" className="sched-link ui-focus-ring" onClick={() => onOpenSession(task.targetSessionId!, task.cwd)}>
              <MessageSquare size={13} aria-hidden="true" />
              {session ? sessionLabel(session) : t("scheduledTasks.sessionMissing")}
            </button>
          ) : (
            <span className="sched-mono" title={task.cwd}><SquarePlus size={13} aria-hidden="true" /> {t("scheduledTasks.targetNewIn", { cwd: task.cwd })}</span>
          )}
        </dd>
        <dt>{t("scheduledTasks.repeat")}</dt>
        <dd className="sched-repeat">
          {describeRepeat(task.repeat, t, locale)} · {nextRunText(task, t, locale)}
          {task.repeat.kind !== "webhook" && <ScheduleZone timeZone={task.repeat.kind === "interval" ? null : timeZone} />}
        </dd>
        {task.createdByAgent && (
          <>
            <dt>{t("scheduledTasks.origin")}</dt>
            <dd>
              {t(task.oneShot ? "scheduledTasks.agentCreatedOneShot" : "scheduledTasks.agentCreated")}
              {task.expiresAt !== undefined && ` · ${t("scheduledTasks.expiresAt", { time: formatAt(task.expiresAt, locale) })}`}
            </dd>
          </>
        )}
        {!task.targetSessionId && (task.provider || task.thinkingLevel) && (
          <>
            <dt>{t("scheduledTasks.model")}</dt>
            <dd>{[task.provider && task.modelId ? `${task.provider}/${task.modelId}` : null, task.thinkingLevel].filter(Boolean).join(" · ")}</dd>
          </>
        )}
      </dl>
      <pre className="sched-prompt">{task.message}</pre>
      {task.repeat.kind === "webhook" && task.webhookToken && (
        <WebhookInfo
          urls={task.webhookEndpoints
            ? task.webhookEndpoints.flatMap((endpoint) => (endpoint.url ? [endpoint.url] : []))
            : [`${window.location.origin}/api/hooks/${task.webhookToken}`]}
          endpoints={task.webhookEndpoints}
          includeBody={task.webhookIncludeBody}
          onRegenerate={() => void act({ action: "regenerate-webhook" }, t("scheduledTasks.webhookRegenerated"))}
        />
      )}
      <div className="sched-actions">
        <button type="button" className="sched-button ui-focus-ring" onClick={() => void act({ action: "run" }, t("scheduledTasks.runStartedToast"))}>
          <Play size={13} aria-hidden="true" />{t("scheduledTasks.runNow")}
        </button>
        <button type="button" className="sched-button ui-focus-ring" onClick={onEdit}>
          <Pencil size={13} aria-hidden="true" />{t("scheduledTasks.edit")}
        </button>
        <button type="button" className="sched-button sched-danger ui-focus-ring" onClick={onDelete}>
          <Trash2 size={13} aria-hidden="true" />{t("scheduledTasks.delete")}
        </button>
        <span className="sched-spacer" />
        <Check label={t("scheduledTasks.enabled")} checked={task.enabled} onChange={(enabled) => void act({ enabled })} />
      </div>
      <section aria-label={t("scheduledTasks.recentRuns")} className="sched-runs">
        <div className="sched-runs-title">{t("scheduledTasks.recentRuns")}</div>
        {recent.length === 0 ? <p className="sched-empty">{t("scheduledTasks.noRuns")}</p> : (
          <ul>
            {recent.map((run) => {
              const openable = Boolean(run.sessionId && !run.archived && run.status === "started");
              const content = (
                <>
                  <time>{formatAt(run.startedAt, locale)}</time>
                  <span data-status={run.running ? "running" : run.status}>{runLabel(run, t)}</span>
                  {run.trigger && <span className="sched-dim">{t(run.trigger === "webhook" ? "scheduledTasks.triggerWebhook" : "scheduledTasks.triggerManual")}</span>}
                  {run.archived && <span className="sched-dim">{t("scheduledTasks.archived")}</span>}
                  {run.error && <span className="sched-dim sched-ellipsis" title={run.error}>{run.error}</span>}
                </>
              );
              return (
                <li key={`${run.startedAt}-${run.status}`}>
                  {openable ? (
                    <button type="button" className="sched-run ui-focus-ring" title={t("scheduledTasks.openRun")} onClick={() => onOpenSession(run.sessionId!, task.cwd)}>{content}</button>
                  ) : <div className="sched-run">{content}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Scheduled tasks window (sidebar header button): list on the left, the
 * selected task or the editor on the right, like the memo window. */
export function ScheduledTasksPanel({ currentSessionId, currentCwd, onOpenSession }: {
  /** The open chat, offered as the default target of a new session task. */
  currentSessionId: string | null;
  currentCwd: string | null;
  onOpenSession: (sessionId: string, cwd: string) => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<ScheduledTaskView[] | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [deleting, setDeleting] = useState<ScheduledTaskView | null>(null);
  const [mobileList, setMobileList] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const body = await request<{ tasks: ScheduledTaskView[]; timeZone?: string; interfaces?: NetworkInterfaceInfo[] }>("/api/scheduled-tasks");
      setTasks(body.tasks);
      setTimeZone(body.timeZone ?? null);
      setInterfaces(body.interfaces ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SCHEDULED_TASKS_OPEN_EVENT, show);
    return () => window.removeEventListener(SCHEDULED_TASKS_OPEN_EVENT, show);
  }, []);

  // Runs start on the server; poll while open so runs and states show up.
  useEffect(() => {
    if (!open) return;
    void refresh();
    void request<{ sessions: SessionInfo[] }>("/api/sessions").then((body) => {
      setSessions([...body.sessions].sort((a, b) => b.modified.localeCompare(a.modified)));
    }, () => {});
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const sorted = useMemo(() => [...(tasks ?? [])].sort((a, b) => (
    Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name)
  )), [tasks]);
  const selected = sorted.find((task) => task.id === selectedId) ?? (editing === "new" ? undefined : sorted[0]);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  const close = () => {
    setOpen(false);
    setEditing(null);
  };

  const remove = async (task: ScheduledTaskView) => {
    try {
      await request(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      if (selectedId === task.id) setSelectedId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    setDeleting(null);
    await refresh();
  };

  const openSession = (sessionId: string, cwd: string) => {
    close();
    onOpenSession(sessionId, cwd);
  };

  const iconButton = (label: string, icon: React.ReactElement, action: () => void) => (
    <Tooltip content={label}><button type="button" className="sched-icon ui-focus-ring" aria-label={label} onClick={action}>{icon}</button></Tooltip>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="sched-dialog" ariaLabel={t("scheduledTasks.title")} style={{ width: "min(980px, calc(100vw - 24px))", maxWidth: "calc(100vw - 24px)", height: "min(720px, 86dvh)", maxHeight: "86dvh", padding: 0, overflow: "hidden", borderRadius: 8 }}>
        <header className="sched-header">
          <CalendarClock size={18} aria-hidden="true" />
          <DialogTitle style={{ fontFamily: "inherit", fontSize: 16, margin: 0, flex: 1 }}>{t("scheduledTasks.title")}</DialogTitle>
          {iconButton(t("scheduledTasks.close"), <X size={18} />, close)}
        </header>
        {loadError && <div className="sched-alert" role="alert">{loadError}</div>}
        <div className="sched-layout" data-mobile-list={mobileList}>
          <aside className="sched-sidebar" aria-label={t("scheduledTasks.list")}>
            <div className="sched-list-toolbar">
              <button type="button" className="sched-button sched-primary ui-focus-ring" onClick={() => { setEditing("new"); setMobileList(false); }}>
                <Plus size={14} aria-hidden="true" />{t("scheduledTasks.add")}
              </button>
            </div>
            <div className="sched-list">
              {tasks === null ? <p className="sched-empty">{t("scheduledTasks.loading")}</p> : sorted.length === 0 ? (
                <p className="sched-empty">{t("scheduledTasks.empty")}</p>
              ) : sorted.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className="sched-list-item ui-focus-ring"
                  aria-current={editing !== "new" && selected?.id === task.id}
                  data-paused={!task.enabled}
                  onClick={() => { setSelectedId(task.id); setEditing(null); setMobileList(false); }}
                >
                  <span className="sched-list-title">
                    {task.targetSessionId ? <MessageSquare size={12} aria-hidden="true" /> : <SquarePlus size={12} aria-hidden="true" />}
                    <strong>{task.name}</strong>
                    {task.runs.some((run) => run.running) && <span className="sched-running-dot" aria-label={t("scheduledTasks.runRunning")} />}
                    {task.createdByAgent && <span className="sched-badge">{t("scheduledTasks.agentBadge")}</span>}
                  </span>
                  <span className="sched-snippet">{describeRepeat(task.repeat, t, locale)}</span>
                  <span className="sched-snippet">{nextRunText(task, t, locale)}</span>
                </button>
              ))}
            </div>
          </aside>
          <section className="sched-main" aria-label={t("scheduledTasks.details")}>
            <div className="sched-back">{iconButton(t("scheduledTasks.back"), <ArrowLeft size={17} />, () => { setMobileList(true); setEditing(null); })}</div>
            {editing ? (
              <TaskEditor
                key={editing === "new" ? "new" : selected?.id}
                task={editing === "edit" ? selected ?? null : null}
                defaults={{ cwd: currentCwd ?? "", sessionId: currentSessionId }}
                sessions={sessions}
                timeZone={timeZone}
                interfaces={interfaces}
                onCancel={() => setEditing(null)}
                onSaved={(task) => { setEditing(null); setSelectedId(task.id); void refresh(); }}
              />
            ) : selected ? (
              <TaskDetail
                task={selected}
                session={selected.targetSessionId ? sessionsById.get(selected.targetSessionId) : undefined}
                timeZone={timeZone}
                onEdit={() => setEditing("edit")}
                onDelete={() => setDeleting(selected)}
                onChanged={refresh}
                onOpenSession={openSession}
              />
            ) : (
              <div className="sched-placeholder">
                <CalendarClock size={28} aria-hidden="true" />
                <button type="button" className="sched-button ui-focus-ring" onClick={() => { setEditing("new"); setMobileList(false); }}>
                  <Plus size={14} aria-hidden="true" />{t("scheduledTasks.add")}
                </button>
              </div>
            )}
          </section>
        </div>
        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(next) => { if (!next) setDeleting(null); }}
          title={t("scheduledTasks.deleteTitle")}
          description={t(deleting?.targetSessionId ? "scheduledTasks.deleteSessionDescription" : "scheduledTasks.deleteDescription", { name: deleting?.name ?? "" })}
          confirmLabel={t("scheduledTasks.delete")}
          cancelLabel={t("scheduledTasks.cancel")}
          danger
          onConfirm={() => { if (deleting) void remove(deleting); }}
        />
      </DialogContent>
    </Dialog>
  );
}
