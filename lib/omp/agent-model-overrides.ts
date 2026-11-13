import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isMap, parseDocument, stringify } from "yaml";
import { getSettingsPath } from "./paths";
import { isRecord } from "../type-guards";

/**
 * omp's `task.agentModelOverrides` in config.yml: per-agent model selectors
 * (`provider/model[:thinking]` or `@role`) that win over the agent definition's
 * own `model` and its role; only a model passed explicitly with the task call
 * ranks higher. Edited one agent at a time so a stale page never rewrites the
 * other agents' overrides, and kept out of the /api/omp-settings snapshot for
 * the same reason.
 */
export type AgentModelOverrides = Record<string, string>;

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SELECTOR_LENGTH = 512;

function readDocument() {
  const path = getSettingsPath();
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  return { path, doc };
}

function overridesOf(data: unknown): AgentModelOverrides {
  const task = isRecord(data) && isRecord(data.task) ? data.task : {};
  const raw = isRecord(task.agentModelOverrides) ? task.agentModelOverrides : {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
}

export function readAgentModelOverrides(): AgentModelOverrides {
  return overridesOf(readDocument().doc.toJS());
}

/** Sets (or, with null/empty, removes) one agent's override; returns all overrides. */
export function setAgentModelOverride(agent: string, selector: string | null): AgentModelOverrides {
  if (!AGENT_NAME_RE.test(agent)) throw new Error("Invalid agent name");
  const value = selector?.trim() ?? "";
  if (value.length > MAX_SELECTOR_LENGTH || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid model selector");
  const { path, doc } = readDocument();
  const next = overridesOf(doc.toJS());
  if (value) next[agent] = value;
  else delete next[agent];
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (doc.contents === null) {
    writeFileSync(temp, stringify(Object.keys(next).length ? { task: { agentModelOverrides: next } } : {}), "utf8");
  } else {
    if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
    if (Object.keys(next).length) doc.setIn(["task", "agentModelOverrides"], next);
    else if (doc.hasIn(["task", "agentModelOverrides"])) {
      doc.deleteIn(["task", "agentModelOverrides"]);
      const task = doc.get("task");
      if (isMap(task) && task.items.length === 0) doc.delete("task");
    }
    writeFileSync(temp, doc.toString(), "utf8");
  }
  renameSync(temp, path);
  return next;
}
