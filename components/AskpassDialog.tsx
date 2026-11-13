"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronUp, KeyRound, Lock, Timer } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import type { AskpassRequestInfo } from "@/lib/askpass";

async function answer(id: string, body: { password: string } | { cancel: true }): Promise<string | null> {
  try {
    const response = await fetch("/api/askpass/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (response.ok) return null;
    return formatApiError(await response.json().catch(() => null));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Window event that brings a sudo request forward (the attention bell sends it). */
export const ASKPASS_FOCUS_EVENT = "omp:askpass-focus";

export function focusAskpassRequest(id: string): void {
  window.dispatchEvent(new CustomEvent(ASKPASS_FOCUS_EVENT, { detail: { id } }));
}

/**
 * sudo password prompt for agent commands (lib/askpass.ts), as a floating card in the
 * top-right corner. It never blocks the page: no overlay, no focus grab (typing meant
 * for the chat must not land in a password field), and Escape or the chevron only folds it
 * to a small bar. Refusing is an explicit button. Every open tab shows it; the first answer
 * wins. The password goes once to the server for sudo and is dropped from page state.
 * `requests` comes from useAskpassRequests; AppShell also lists them in the attention bell,
 * whose entries call focusAskpassRequest.
 */
export function AskpassDialog({ requests }: { requests: AskpassRequestInfo[] }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [folded, setFolded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = requests.find((request) => request.id === selectedId) ?? requests[0] ?? null;

  // A new request starts clean and unfolded.
  const currentId = current?.id ?? null;
  useEffect(() => {
    setPassword("");
    setError(null);
    if (currentId) setFolded(false);
  }, [currentId]);

  // The bell picks a request: show that one and put the cursor in its field.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id) setSelectedId(id);
      setFolded(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(ASKPASS_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(ASKPASS_FOCUS_EVENT, onFocus);
  }, []);

  // Nudge through the OS when the tab is in the background (same tag: shown once).
  const currentCommand = current?.command.join(" ") ?? null;
  useEffect(() => {
    if (!currentId || currentCommand === null || !document.hidden) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(t("askpass.notificationTitle"), { body: currentCommand, tag: `askpass-${currentId}` });
  }, [currentId, currentCommand, t]);

  useEffect(() => {
    if (!currentId) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [currentId]);

  if (!current) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    const failure = await answer(current.id, { password });
    setPassword("");
    setBusy(false);
    if (failure) setError(failure);
  };
  const refuse = async () => {
    if (busy) return;
    setBusy(true);
    setPassword("");
    const failure = await answer(current.id, { cancel: true });
    setBusy(false);
    if (failure) setError(failure);
  };
  const secondsLeft = Math.max(0, Math.round((current.expiresAt - now) / 1000));
  const others = requests.length - 1;

  return (
    <section
      className="askpass-panel"
      data-folded={folded || undefined}
      role="region"
      aria-label={t("askpass.title")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        setFolded(true);
      }}
    >
      <button type="button" className="askpass-panel-head" aria-expanded={!folded} onClick={() => setFolded((value) => !value)}>
        <KeyRound size={15} aria-hidden="true" className="askpass-panel-icon" />
        <span className="askpass-panel-title">{t("askpass.title")}</span>
        {folded && <span className="askpass-panel-summary">{current.command.join(" ")}</span>}
        <span className="hint-chip" title={t("askpass.expiresIn", { seconds: secondsLeft })}>
          <Timer size={11} aria-hidden="true" />{secondsLeft}s
        </span>
        {others > 0 && <span className="hint-chip">+{others}</span>}
        {folded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
      </button>
      {!folded && (
        <div className="askpass-panel-body">
          <p className="askpass-session">
            {current.sessionName || t("askpass.untitledSession")}
            <span>{current.cwd}</span>
          </p>
          <div className="askpass-label">{t("askpass.command")}</div>
          <pre className="askpass-command">{current.command.join(" ")}</pre>
          <form onSubmit={(event) => void submit(event)}>
            <label className="askpass-label" htmlFor={`askpass-password-${current.id}`}>{current.prompt.trim() || t("askpass.password")}</label>
            <input
              ref={inputRef}
              id={`askpass-password-${current.id}`}
              className="askpass-input"
              type="password"
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(null); }}
              autoComplete="off"
              disabled={busy}
            />
            {error && <p role="alert" className="askpass-error">{error}</p>}
            <p className="askpass-note">
              <Lock size={12} aria-hidden="true" />
              <span>{t("askpass.note")}</span>
            </p>
            {others > 0 && <p className="askpass-note">{t("askpass.morePending", { count: others })}</p>}
            <div className="askpass-actions">
              <button type="button" onClick={() => void refuse()} disabled={busy}>{t("askpass.refuse")}</button>
              <button type="submit" className="askpass-submit" disabled={busy || !password}>{t("askpass.submit")}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
