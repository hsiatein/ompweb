"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Ban, ChevronRight, FileText, Save } from "lucide-react";
import { Alert, ConfirmDialog, Field, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import {
  MAX_AGENT_INSTRUCTION_LENGTH, parseAgentInstructionTarget, resolveAgentInstructions, sameInstructionTarget,
  type AgentInstructionCombine, type AgentInstructionRule, type AgentInstructionTarget,
} from "@/lib/agent-instructions";

type Draft = { scope: AgentInstructionTarget["scope"]; provider: string; modelId: string; text: string; combine: AgentInstructionCombine };
type ModelChoice = { provider: string; id: string; name: string };
/**
 * What this level does: inherit (no rule; the broader level applies), custom (its own text) or block (an empty rule,
 * which stops broader instructions from applying here). The global level has nothing to inherit or block.
 */
type Mode = "inherit" | "custom" | "block";
const emptyDraft: Draft = { scope: "global", provider: "", modelId: "", text: "", combine: "replace" };
const controlStyle: CSSProperties = { width: "100%", minWidth: 0, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 13 };
const buttonStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 12 };
function targetKey(target: AgentInstructionTarget): string {
  return JSON.stringify([target.scope, target.scope !== "global" ? target.provider : "", target.scope === "model" ? target.modelId : ""]);
}
function toDraft(rule: AgentInstructionRule): Draft {
  return { scope: rule.scope, provider: rule.scope !== "global" ? rule.provider : "", modelId: rule.scope === "model" ? rule.modelId : "", text: rule.text, combine: rule.combine ?? "replace" };
}
function modeOf(rule: AgentInstructionRule | undefined): Mode {
  return !rule ? "inherit" : rule.text ? "custom" : "block";
}

export function AgentInstructionsConfig() {
  const { t } = useI18n();
  const [rules, setRules] = useState<AgentInstructionRule[]>([]);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState("new");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState<Draft>(emptyDraft);
  const [mode, setMode] = useState<Mode>("custom");
  /** Navigation waiting for "discard unsaved changes" confirmation. */
  const [switchTo, setSwitchTo] = useState<(() => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/agent-instructions", { signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      if (controller.signal.aborted) return;
      const loaded: AgentInstructionRule[] = data.rules;
      setRules(loaded);
      const initial = loaded.find((rule) => rule.scope === "global") ?? loaded[0];
      const initialDraft = initial ? toDraft(initial) : emptyDraft;
      setSelection(initial ? targetKey(initial) : "new");
      setDraft(initialDraft);
      setBaseline(initialDraft);
      setMode(initial ? modeOf(initial) : "custom");
    }).catch((error) => {
      if (!controller.signal.aborted) setLoadError(String(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/models", { signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok || data.modelError) throw new Error(data.error || data.modelError);
      if (controller.signal.aborted) return;
      setModels(data.modelList ?? []);
      setConnectedProviders((data.connectedProviders ?? []).map((provider: { id: string }) => provider.id));
    }).catch(() => { if (!controller.signal.aborted) setCatalogFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, []);

  const selected = rules.find((rule) => targetKey(rule) === selection);
  const baselineMode: Mode = selected ? modeOf(selected) : "inherit";
  const dirty = draft.scope !== baseline.scope || draft.provider !== baseline.provider || draft.modelId !== baseline.modelId || draft.text !== baseline.text || draft.combine !== baseline.combine
    || (selected !== undefined && mode !== baselineMode);
  let target: AgentInstructionTarget | null = null;
  try { target = parseAgentInstructionTarget(draft); } catch { /* Incomplete provider/model fields. */ }
  const duplicate = selection === "new" && target !== null && rules.some((rule) => sameInstructionTarget(rule, target!));
  const applied = target ? resolveAgentInstructions(rules, target.scope !== "global" ? target.provider : undefined, target.scope === "model" ? target.modelId : undefined) : [];
  const appliedTexts = applied.filter((rule) => rule.text);
  // Inheritance chain for the target being edited, broadest first; the applied rules are what the model gets.
  const chain: AgentInstructionTarget[] = !target ? [] : target.scope === "global" ? [target]
    : target.scope === "provider" ? [{ scope: "global" }, target]
    : [{ scope: "global" }, { scope: "provider", provider: target.provider }, target];
  const canSave = !!target && !duplicate && (mode === "custom" ? draft.text.length > 0 : mode === "block") && (!selected || dirty);
  const providers = [...new Set([...connectedProviders, ...models.map((model) => model.provider)])].sort();
  const modelIds = [...new Set(models.filter((model) => model.provider === draft.provider).map((model) => model.id))].sort();
  const disabled = loading || busy || !!loadError;
  const label = (rule: AgentInstructionTarget) => rule.scope === "global" ? t("agentInstructions.global")
    : rule.scope === "provider" ? `${t("agentInstructions.provider")} · ${rule.provider}`
    : `${t("agentInstructions.model")} · ${rule.provider} / ${rule.modelId}`;

  function choose(key: string) {
    const rule = rules.find((item) => targetKey(item) === key);
    const next = rule ? toDraft(rule) : { ...emptyDraft, scope: rules.some((item) => item.scope === "global") ? "provider" as const : "global" as const };
    setSelection(rule ? targetKey(rule) : "new");
    setDraft(next);
    setBaseline(next);
    setMode(rule ? modeOf(rule) : "custom");
    setSwitchTo(null);
  }
  /** Jump to a level of the chain: its saved rule, or a new rule pre-filled for that level. */
  function chooseTarget(level: AgentInstructionTarget) {
    const rule = rules.find((item) => sameInstructionTarget(item, level));
    if (rule) { choose(targetKey(rule)); return; }
    const next: Draft = { ...emptyDraft, scope: level.scope, provider: level.scope !== "global" ? level.provider : "", modelId: level.scope === "model" ? level.modelId : "" };
    setSelection("new"); setDraft(next); setBaseline(next); setMode("custom"); setSwitchTo(null);
  }
  function changeMode(next: Mode) {
    // Back to "inherit" on a saved rule means deleting it; confirm first like any deletion.
    if (next === "inherit" && selected) { setConfirmDelete(true); return; }
    setMode(next);
  }
  async function persist(remove = false) {
    if (!target || (remove && !selected)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/agent-instructions", {
        method: remove ? "DELETE" : "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(remove ? selected : { ...target, text: mode === "block" ? "" : draft.text, combine: mode === "custom" ? draft.combine : "replace" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("agentInstructions.saveFailed"));
      const nextRules: AgentInstructionRule[] = data.rules;
      setRules(nextRules);
      const next = remove ? nextRules.find((rule) => rule.scope === "global") ?? nextRules[0]
        : nextRules.find((rule) => sameInstructionTarget(rule, target!));
      const nextDraft = next ? toDraft(next) : emptyDraft;
      setSelection(next ? targetKey(next) : "new");
      setDraft(nextDraft);
      setBaseline(nextDraft);
      setMode(next ? modeOf(next) : "custom");
      setConfirmDelete(false);
      toast.success(t(remove ? "agentInstructions.deleted" : "agentInstructions.saved"));
    } catch (error) { toast.error(String(error)); }
    finally { setBusy(false); }
  }

  return (
    <section className="wallpaper-inset" aria-label={t("agentInstructions.title")} data-setting-id="agent-instructions" style={{ display: "flex", flexDirection: "column", gap: 14, padding: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", minWidth: 0 }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 15, color: "var(--text)" }}><FileText size={17} aria-hidden="true" />{t("agentInstructions.title")}</h3>
      {loading && <span role="status">{t("agentInstructions.loading")}</span>}
      {loadError && <><Alert variant="error" title={t("agentInstructions.loadFailed")} description={loadError} /><button className="agent-config-action wallpaper-inset" type="button" style={buttonStyle} onClick={() => { setLoadError(""); setLoading(true); setReload((value) => value + 1); }}>{t("agentInstructions.retry")}</button></>}
      <Field label={t("agentInstructions.rules")}>
        <Select
          className="agent-config-action wallpaper-inset"
          value={selection}
          disabled={disabled}
          style={controlStyle}
          onChange={(nextValue) => dirty ? setSwitchTo(() => () => choose(nextValue)) : choose(nextValue)}
          options={[
            ...rules.map((rule) => ({ value: targetKey(rule), label: label(rule) })),
            { value: "new", label: t("agentInstructions.newRule") },
          ]}
        />
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <Field label={t("agentInstructions.scope")} style={{ flex: "1 1 140px" }}>
          <Select
            className="agent-config-action wallpaper-inset"
            style={controlStyle}
            value={draft.scope}
            disabled={disabled || !!selected}
            onChange={(nextValue) => setDraft({ ...draft, scope: nextValue as Draft["scope"] })}
            options={[
              ...(["global", "provider", "model"] as const).map((scope) => ({ value: scope, label: t(`agentInstructions.${scope}`) })),
            ]}
          />
        </Field>
        {draft.scope !== "global" && <Field label={t("agentInstructions.providerId")} style={{ flex: "2 1 180px" }}>
          <Select
            className="agent-config-action wallpaper-inset"
            style={controlStyle}
            value={draft.provider}
            disabled={disabled || !!selected || catalogLoading || providers.length === 0}
            onChange={(nextValue) => setDraft({ ...draft, provider: nextValue, modelId: "" })}
            options={[
              { value: "", label: t(catalogLoading ? "agentInstructions.loadingCatalog" : providers.length ? "agentInstructions.selectProvider" : "agentInstructions.noProviders"), disabled: true },
              ...(selected && draft.provider && !providers.includes(draft.provider) ? [{ value: draft.provider, label: draft.provider, disabled: true }] : []),
              ...providers.map((provider) => ({ value: provider, label: provider })),
            ]}
          />
        </Field>}
        {draft.scope === "model" && <Field label={t("agentInstructions.modelId")} style={{ flex: "2 1 180px" }}>
          <Select
            className="agent-config-action wallpaper-inset"
            style={controlStyle}
            value={draft.modelId}
            disabled={disabled || !!selected || catalogLoading || !draft.provider || modelIds.length === 0}
            onChange={(nextValue) => setDraft({ ...draft, modelId: nextValue })}
            options={[
              { value: "", label: t(catalogLoading ? "agentInstructions.loadingCatalog" : !draft.provider ? "agentInstructions.selectProvider" : modelIds.length ? "agentInstructions.selectModel" : "agentInstructions.noModels"), disabled: true },
              ...(selected && draft.modelId && !modelIds.includes(draft.modelId) ? [{ value: draft.modelId, label: draft.modelId, disabled: true }] : []),
              ...modelIds.map((modelId) => {
              const name = models.find((model) => model.provider === draft.provider && model.id === modelId)?.name;
              return ({ value: modelId, label: name && name !== modelId ? `${name} (${modelId})` : modelId });
            }),
            ]}
          />
        </Field>}
      </div>
      {draft.scope !== "global" && catalogFailed && <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)" }}>{t("agentInstructions.catalogFailed")}</p>}
      {duplicate && <Alert variant="warning" description={t("agentInstructions.duplicate")} />}
      {chain.length > 0 && (
        <ol className="instruction-chain" aria-label={t("agentInstructions.chain")}>
          {chain.map((level, index) => {
            const rule = rules.find((item) => sameInstructionTarget(item, level));
            const current = index === chain.length - 1;
            const wins = appliedTexts.some((rule) => sameInstructionTarget(rule, level));
            return (
              <li key={targetKey(level)}>
                {index > 0 && <ChevronRight size={13} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />}
                <button type="button" className="instruction-chain-node" data-current={current || undefined} data-effective={wins || undefined}
                  disabled={disabled || current} onClick={() => dirty ? setSwitchTo(() => () => chooseTarget(level)) : chooseTarget(level)}
                  aria-label={`${label(level)}${wins ? ` · ${t("agentInstructions.effectiveHere")}` : ""}`}>
                  {rule ? rule.text ? <span className="instruction-chain-dot" data-filled="true" aria-hidden="true" /> : <Ban size={11} aria-hidden="true" /> : <span className="instruction-chain-dot" aria-hidden="true" />}
                  {label(level)}
                  {rule?.combine === "append" && <span className="instruction-chain-append">+</span>}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {target && (
        <div className="instruction-mode" role="radiogroup" aria-label={t("agentInstructions.prompt")}>
          {(target.scope === "global" ? ["inherit", "custom"] as const : ["inherit", "custom", "block"] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={disabled} onClick={() => changeMode(value)}>
              {value === "block" && <Ban size={13} aria-hidden="true" />}
              {t(target!.scope === "global" && value === "inherit" ? "agentInstructions.modeOff" : `agentInstructions.mode.${value}`)}
            </button>
          ))}
        </div>
      )}
      {mode === "custom" && target && target.scope !== "global" && (
        <div className="instruction-mode" role="radiogroup" aria-label={t("agentInstructions.combine")}>
          {(["replace", "append"] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={draft.combine === value} disabled={disabled} onClick={() => setDraft({ ...draft, combine: value })}
              title={t(`agentInstructions.combine.${value}Hint`)}>
              {t(`agentInstructions.combine.${value}`)}
            </button>
          ))}
        </div>
      )}
      {mode === "custom" && (
        <textarea aria-label={t("agentInstructions.prompt")} className="wallpaper-inset" style={{ ...controlStyle, minHeight: 180, resize: "vertical", fontFamily: "var(--font-mono)", lineHeight: 1.6 }} value={draft.text} disabled={disabled} maxLength={MAX_AGENT_INSTRUCTION_LENGTH} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button className="agent-config-action wallpaper-inset" type="button" style={{ ...buttonStyle, color: "var(--accent-strong)", borderColor: "var(--accent-strong)", opacity: disabled || !canSave ? 0.5 : 1 }} disabled={disabled || !canSave} onClick={() => void persist()}><Save size={14} aria-hidden="true" />{t(busy ? "agentInstructions.saving" : "agentInstructions.save")}</button>
        <button className="agent-config-action wallpaper-inset" type="button" style={{ ...buttonStyle, opacity: disabled || !dirty ? 0.5 : 1 }} disabled={disabled || !dirty} onClick={() => { setDraft(baseline); setMode(selected ? modeOf(selected) : "custom"); }}>{t("agentInstructions.cancel")}</button>
        {mode === "custom" && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>{draft.text.length} / {MAX_AGENT_INSTRUCTION_LENGTH}</span>}
      </div>
      <details style={{ fontSize: 12, color: "var(--text-muted)" }}>
        <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}>{t("agentInstructions.effective")} {appliedTexts.length ? appliedTexts.map(label).join(" + ") : t("agentInstructions.none")}</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflow: "auto", fontFamily: "var(--font-mono)", color: "var(--text)" }}>{appliedTexts.length === 0 ? t("agentInstructions.noAppend")
          : appliedTexts.length === 1 ? appliedTexts[0].text : appliedTexts.map((rule) => `# ${label(rule)}\n${rule.text}`).join("\n\n")}</pre>
      </details>
      <ConfirmDialog open={switchTo !== null} onOpenChange={(open) => { if (!open) setSwitchTo(null); }} title={t("agentInstructions.discardTitle")} description={t("agentInstructions.discardDescription")} confirmLabel={t("agentInstructions.discard")} cancelLabel={t("agentInstructions.cancel")} onConfirm={() => switchTo?.()} />
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={t("agentInstructions.delete")} description={t("agentInstructions.deleteDescription")} confirmLabel={t("agentInstructions.delete")} cancelLabel={t("agentInstructions.cancel")} danger busy={busy} onConfirm={() => void persist(true)} />
    </section>
  );
}
