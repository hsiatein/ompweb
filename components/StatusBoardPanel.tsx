"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleAlert, CircleCheck, CirclePause, Info, LayoutDashboard, Loader, MessageSquare, X } from "lucide-react";
import { subscribeAppEvents } from "@/lib/app-events";
import { useI18n } from "@/lib/i18n";
import {
  boardSummary,
  formatDuration,
  formatNumber,
  isFinished,
  isStale,
  orderItems,
  orderSessions,
  progressInfo,
} from "@/lib/status-board-layout";
import type { StatusItem, StatusItemState, StatusSession } from "@/lib/status-board-types";
import { StatusBlocks } from "./StatusBlocks";
import { toast } from "./ui/toast";
import "./status-board.css";

/**
 * Right-panel Status tab: status items agents publish for their sessions
 * (lib/status-board.ts, `status_board` tool, `POST /api/status/<token>`).
 * Agents describe items; layout and ordering live here and in
 * lib/status-board-layout.ts. Always mounted so the tab badge stays current;
 * renders nothing heavy while hidden.
 */

const STATE_ICON: Record<StatusItemState, typeof Info> = {
  running: Loader,
  paused: CirclePause,
  done: CircleCheck,
  failed: CircleAlert,
  info: Info,
};

async function dismiss(query: Record<string, string>, failedMessage: string): Promise<void> {
  try {
    const response = await fetch(`/api/status-board?${new URLSearchParams(query)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    toast.error(failedMessage, error instanceof Error ? error.message : String(error));
  }
}

function Sparkline({ history }: { history: StatusItem["history"] }) {
  if (history.length < 2) return null;
  const values = history.map(([, value]) => value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${20 - ((value - min) / span) * 18 - 1}`).join(" ");
  return (
    <svg className="status-sparkline" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const StatusItemRow = memo(function StatusItemRow({ item, now, onDismiss }: { item: StatusItem; now: number; onDismiss: () => void }) {
  const { t } = useI18n();
  const Icon = STATE_ICON[item.state];
  const progress = progressInfo(item, now);
  const stale = isStale(item, now);
  const unit = item.unit ? ` ${item.unit}` : "";
  let figure: string | null = null;
  if (progress && item.value !== undefined && item.max !== undefined) {
    figure = `${Math.floor(progress.percent)}% · ${formatNumber(item.value)}/${formatNumber(item.max)}${unit}`;
  } else if (item.value !== undefined) {
    figure = `${formatNumber(item.value)}${unit}`;
  }
  return (
    <li className="status-item" data-state={item.state} data-stale={stale || undefined}>
      <div className="status-item-head">
        <Icon size={13} strokeWidth={2} aria-label={t(`statusBoard.state.${item.state}`)} className="status-item-icon" />
        <span className="status-item-title" title={item.title}>{item.title}</span>
        {figure && <span className={item.kind === "value" ? "status-item-value" : "status-item-figure"}>{figure}</span>}
        <button type="button" className="status-item-dismiss ui-focus-ring" onClick={onDismiss} aria-label={t("statusBoard.dismiss")} title={t("statusBoard.dismiss")}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      {progress && (
        <div className="status-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)} aria-label={item.title}>
          <span style={{ width: `${progress.percent}%` }} />
        </div>
      )}
      {item.kind === "value" && <Sparkline history={item.history} />}
      {(item.detail || progress?.etaMs !== undefined || stale) && (
        <div className="status-item-meta">
          {item.detail && <span className="status-item-detail" title={item.detail}>{item.detail}</span>}
          {progress?.etaMs !== undefined && !stale && <span className="status-item-eta">{t("statusBoard.eta", { time: formatDuration(progress.etaMs) })}</span>}
          {stale && <span className="status-item-stale">{t("statusBoard.stale", { time: formatDuration(now - item.updatedAt) })}</span>}
        </div>
      )}
      {item.blocks && item.blocks.length > 0 && <StatusBlocks blocks={item.blocks} />}
    </li>
  );
});

function SessionSection({ session, current, now, onOpenSession }: {
  session: StatusSession;
  current: boolean;
  now: number;
  onOpenSession: (sessionId: string, cwd: string) => void;
}) {
  const { t } = useI18n();
  const items = useMemo(() => orderItems(session.items), [session.items]);
  const allFinished = items.every(isFinished);
  // Sessions whose items all finished start folded; the open chat never does.
  const [open, setOpen] = useState(current || !allFinished);
  const finished = items.filter(isFinished).length;
  const failedMessage = t("statusBoard.dismissFailed");
  const name = session.sessionName || session.sessionId.slice(0, 13);
  const folder = session.cwd?.split("/").filter(Boolean).at(-1);
  return (
    <section className="status-session" data-current={current || undefined}>
      <div className="status-session-head">
        <button type="button" className="status-session-toggle ui-focus-ring" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronRight size={12} strokeWidth={2} aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : "none" }} />
          <span className="status-session-name" title={session.sessionName ?? session.sessionId}>{current ? t("statusBoard.thisChat") : name}</span>
          {folder && <span className="status-session-folder">{folder}</span>}
          <span className="status-session-count">{items.length}</span>
        </button>
        {!current && session.cwd && (
          <button type="button" className="status-session-action ui-focus-ring" onClick={() => onOpenSession(session.sessionId, session.cwd!)} title={t("statusBoard.openSession")} aria-label={t("statusBoard.openSession")}>
            <MessageSquare size={12} aria-hidden="true" />
          </button>
        )}
        {finished > 0 && (
          <button type="button" className="status-session-action ui-focus-ring" onClick={() => void dismiss({ sessionId: session.sessionId, finished: "1" }, failedMessage)}>
            {t("statusBoard.clearFinished", { count: finished })}
          </button>
        )}
      </div>
      {open && (
        <ul className="status-items">
          {items.map((item) => (
            <StatusItemRow key={item.id} item={item} now={now} onDismiss={() => void dismiss({ sessionId: session.sessionId, id: item.id }, failedMessage)} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function StatusBoardPanel({ active, currentSessionId, onOpenSession, onSummaryChange }: {
  active: boolean;
  currentSessionId: string | null;
  onOpenSession: (sessionId: string, cwd: string) => void;
  onSummaryChange: (summary: { live: number; failed: boolean }) => void;
}) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<StatusSession[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const summaryRef = useRef("");
  const onSummaryChangeRef = useRef(onSummaryChange);
  useEffect(() => { onSummaryChangeRef.current = onSummaryChange; }, [onSummaryChange]);

  useEffect(() => subscribeAppEvents({
    onFrame: (frame) => {
      if (frame.type !== "status_board" || !Array.isArray(frame.sessions)) return;
      const next = frame.sessions as StatusSession[];
      setSessions(next);
      setNow(Date.now());
      const summary = boardSummary(next);
      const key = `${summary.live}:${summary.failed}`;
      if (key !== summaryRef.current) {
        summaryRef.current = key;
        onSummaryChangeRef.current(summary);
      }
    },
  }), []);

  // ETAs and "no update for" age while the tab is visible.
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [active]);

  const ordered = useMemo(() => orderSessions(sessions, currentSessionId), [sessions, currentSessionId]);
  if (!active) return null;
  return (
    <div className="status-board">
      {ordered.length === 0 ? (
        <div className="status-board-empty">
          <LayoutDashboard size={24} strokeWidth={1.6} aria-hidden="true" />
          <p>{t("statusBoard.empty")}</p>
          <p className="status-board-hint">{t("statusBoard.emptyHint")}</p>
        </div>
      ) : ordered.map((session) => (
        <SessionSection key={session.sessionId} session={session} current={session.sessionId === currentSessionId} now={now} onOpenSession={onOpenSession} />
      ))}
    </div>
  );
}
