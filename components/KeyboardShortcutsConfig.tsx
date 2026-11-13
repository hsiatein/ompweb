"use client";

import { useState, type KeyboardEvent } from "react";
import { Keyboard, Plus, RotateCcw, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useShortcuts } from "@/hooks/useShortcuts";
import { DEFAULT_SHORTCUTS, SHORTCUTS, setShortcutBinding, shortcutFromEvent, shortcutLabel, type ShortcutId } from "@/lib/keyboard-shortcuts";
import { InfoHint } from "./ui/primitives";
import { toast } from "./ui/toast";
import "./keyboard-shortcuts.css";

type Group = typeof SHORTCUTS[number]["group"];
const GROUPS: readonly Group[] = ["global", "chat", "composer", "voice", "files"];

/** Condition badges for shortcuts that only fire in a particular state. */
const CONDITIONS: Partial<Record<ShortcutId, string>> = {
  inputHistory: "shortcuts.when.idleEmpty",
  minimizeComposer: "shortcuts.when.idleEmpty",
  cancelDictation: "shortcuts.when.dictationPanel",
  confirmDictation: "shortcuts.when.dictationPanel",
  stopSpeech: "shortcuts.when.keepsTask",
};

/** Shortcuts whose description says something the label does not; shown behind "?". */
const DETAILED: Partial<Record<ShortcutId, true>> = { toggleMemos: true, selectAll: true, sendMessage: true, acceptCompletion: true, toggleDictation: true, copyTerminal: true };

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index]);

export function KeyboardShortcutsConfig() {
  const { t } = useI18n();
  const bindings = useShortcuts();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [heldAlt, setHeldAlt] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const save = (id: ShortcutId, keys: readonly string[] | null) => {
    if (!setShortcutBinding(id, keys)) toast.error(t("shortcuts.storageError"));
  };
  const capture = (event: KeyboardEvent<HTMLInputElement>, released = false) => {
    event.preventDefault();
    event.stopPropagation();
    if (!recording || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const chord = shortcutFromEvent(event.nativeEvent);
    if (event.key === "Alt" && !released) { setHeldAlt(chord === "Alt"); return; }
    if (released && !(heldAlt && chord === "Alt")) return;
    setHeldAlt(false);
    if (!chord || (chord === "Alt" && recording !== "toggleDictation")) {
      if (!["Control", "Meta", "Shift"].includes(event.key)) setInvalid(true);
      return;
    }
    save(recording, [...bindings[recording], chord]);
    setRecording(null);
    setInvalid(false);
  };
  const search = query.trim().toLocaleLowerCase();
  const visible = SHORTCUTS.filter(({ id }) => [t(`shortcuts.${id}.label`), t(`shortcuts.${id}.description`), shortcutLabel(id, bindings)].join(" ").toLocaleLowerCase().includes(search));

  return (
    <section aria-labelledby="general-shortcuts-heading" className="shortcut-settings">
      <h3 id="general-shortcuts-heading" className="display-serif">
        <Keyboard size={20} aria-hidden="true" />{t("settingsConfig.general.shortcuts")}
        <span className="hint-chip">{t("settingsConfig.deviceOnly")}</span>
      </h3>
      <input className="shortcut-search ui-focus-ring" type="search" aria-label={t("shortcuts.search")} placeholder={t("shortcuts.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {visible.length === 0 && <p className="shortcut-empty">{t("shortcuts.empty")}</p>}
      {GROUPS.map((group) => {
        const rows = visible.filter((shortcut) => shortcut.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} className="shortcut-group" aria-labelledby={`shortcut-group-${group}`}>
            <h4 id={`shortcut-group-${group}`} className="shortcut-group-title">{t(`shortcuts.group.${group}`)}</h4>
            <div className="shortcut-list">
              {rows.map(({ id }) => {
                const label = t(`shortcuts.${id}.label`);
                const conflicts = SHORTCUTS.filter((other) => other.id !== id && bindings[id].some((key) => bindings[other.id].includes(key)));
                const modified = !sameKeys(bindings[id], DEFAULT_SHORTCUTS[id]);
                const condition = CONDITIONS[id];
                const resetLabel = `${t("shortcuts.reset")} · ${t("shortcuts.default", { keys: shortcutLabel(id, DEFAULT_SHORTCUTS) || t("shortcuts.unbound") })}`;
                return (
                  <div key={id} id={`setting-shortcut-${id}`} className="shortcut-row" role="group" aria-label={label}>
                    <div className="shortcut-info">
                      <span className="shortcut-label">{label}</span>
                      {condition && <span className="hint-chip">{t(condition)}</span>}
                      {DETAILED[id] && <InfoHint label={`${t("shortcuts.moreInfo")} · ${label}`}>{t(`shortcuts.${id}.description`)}</InfoHint>}
                    </div>
                    {recording === id ? (
                      <div data-shortcut-recorder className="shortcut-recording">
                        <input autoFocus readOnly className="shortcut-search ui-focus-ring" aria-label={t("shortcuts.recording")} placeholder={t("shortcuts.recording")} onKeyDown={capture} onKeyUp={(event) => capture(event, true)} onBlur={() => setHeldAlt(false)} />
                        <button type="button" className="shortcut-button ui-focus-ring" onClick={() => setRecording(null)}>{t("shortcuts.cancel")}</button>
                        <p className={invalid ? "shortcut-recording-note shortcut-recording-error" : "shortcut-recording-note"} role={invalid ? "alert" : undefined}>
                          {invalid ? t("shortcuts.invalid") : t("shortcuts.reservedKeys")}
                        </p>
                      </div>
                    ) : (
                      <div className="shortcut-controls">
                        {bindings[id].length === 0 && <span className="shortcut-unbound">{t("shortcuts.unbound")}</span>}
                        {bindings[id].map((key) => (
                          <button type="button" className="shortcut-key ui-focus-ring" key={key} aria-label={t("shortcuts.removeKey", { action: label, key })} onClick={() => save(id, bindings[id].filter((binding) => binding !== key))}>
                            <kbd>{key.replace("Meta+", "⌘+").replace("Backquote", "`")}</kbd><X size={12} aria-hidden="true" />
                          </button>
                        ))}
                        <button type="button" className="shortcut-icon-button ui-focus-ring" aria-label={`${t("shortcuts.add")} · ${label}`} title={t("shortcuts.add")} onClick={() => { setRecording(id); setHeldAlt(false); setInvalid(false); }}>
                          <Plus size={14} aria-hidden="true" />
                        </button>
                        {modified && (
                          <button type="button" className="shortcut-icon-button ui-focus-ring" aria-label={`${resetLabel} · ${label}`} title={resetLabel} onClick={() => save(id, null)}>
                            <RotateCcw size={13} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )}
                    {conflicts.length > 0 && <p className="shortcut-conflicts">{t("shortcuts.conflicts", { actions: conflicts.map(({ id: other }) => t(`shortcuts.${other}.label`)).join(" / ") })}</p>}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </section>
  );
}
