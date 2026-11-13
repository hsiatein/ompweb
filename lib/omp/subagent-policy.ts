import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { loadWebServerSettings } from "../web-settings";
import { getAgentDir } from "./paths";
import { readNativeSettings } from "./settings-config";

/** Final launch overlay: the web controls bound task, Eval agent() and workpool spawns. */
export function applySubagentPolicy(args: string[]): string[] {
  const enabled = loadWebServerSettings().subagentsEnabled;
  const limits = readNativeSettings().settings.task;
  const policy = {
    task: {
      maxRecursionDepth: enabled ? (limits?.maxRecursionDepth ?? 2) : 0,
      maxConcurrency: limits?.maxConcurrency ?? 32,
      ...(!enabled ? { speculativeLaunch: false } : {}),
    },
    ...(!enabled ? { tools: { approval: { task: "deny" } } } : {}),
  };
  const root = getAgentDir();
  const file = join(root, "omp-web-subagent-policy.json");
  const content = `${JSON.stringify(policy)}\n`;
  mkdirSync(root, { recursive: true });
  if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) rmSync(temporary);
    }
  }
  return [...args, "--config", file];
}
