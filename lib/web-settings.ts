import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { PROVIDER_ACCOUNT_ALIAS_MAX_LENGTH, PROVIDER_ACCOUNT_KEY_RE } from "./provider-usage-types";
import { isRecord } from "./type-guards";
import { DEFAULT_MEMORY_GUARD, parseMemoryGuardSettings, type MemoryGuardSettings } from "./memory-guard-settings";
import { WEB_PLUGIN_ID_RE } from "./web-plugin-types";

/** omp-web's own server-side settings (omp's config.yml stays omp's). */
export interface WebServerSettings {
  /** Resume sessions that were mid-run when omp-web stopped. */
  autoResumeSessions: boolean;
  /** Allow delegation in newly started OMP processes. */
  subagentsEnabled: boolean;
  /** User-assigned provider account names, keyed by `ProviderUsageReport.accountKey`. */
  accountAliases: Record<string, string>;
  /** Directory picker shortcuts (jump targets), in the user's order. */
  favoriteDirectories: string[];
  /** Kills runaway agent/terminal commands before the system runs out of memory. */
  memoryGuard: MemoryGuardSettings;
  /** Web plugins (`<agent dir>/web-plugins/<id>`) the user switched on. */
  enabledPlugins: string[];
}

const DEFAULTS: WebServerSettings = { autoResumeSessions: false, subagentsEnabled: false, accountAliases: {}, favoriteDirectories: [], memoryGuard: DEFAULT_MEMORY_GUARD, enabledPlugins: [] };

export const MAX_FAVORITE_DIRECTORIES = 50;
const MAX_FAVORITE_PATH_LENGTH = 4096;

/** Validated, de-duplicated favorite directory list, or null when malformed.
 * Paths are only stored here; browsing them still goes through the
 * directory picker's own access rules. */
export function parseFavoriteDirectories(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_FAVORITE_DIRECTORIES) return null;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    const path = entry.trim();
    if (!path || path.length > MAX_FAVORITE_PATH_LENGTH || path.includes("\0")) return null;
    seen.add(path);
  }
  return [...seen];
}

function readAccountAliases(raw: unknown): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!isRecord(raw)) return aliases;
  for (const [key, value] of Object.entries(raw)) {
    if (!PROVIDER_ACCOUNT_KEY_RE.test(key) || typeof value !== "string") continue;
    const alias = value.trim().slice(0, PROVIDER_ACCOUNT_ALIAS_MAX_LENGTH);
    if (alias) aliases[key] = alias;
  }
  return aliases;
}

function settingsPath(): string {
  return resolve(getAgentDir(), "omp-web-settings.json");
}

declare global {
  // Shared across module instances (instrumentation and route bundles).
  var __ompWebSettingsCache: { path: string; settings: WebServerSettings } | undefined;
}

export function loadWebServerSettings(): WebServerSettings {
  const path = settingsPath();
  const cached = globalThis.__ompWebSettingsCache;
  if (cached?.path === path) return cached.settings;
  let settings = DEFAULTS;
  try {
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(raw)) {
        settings = {
          autoResumeSessions: raw.autoResumeSessions === true,
          subagentsEnabled: raw.subagentsEnabled === true,
          accountAliases: readAccountAliases(raw.accountAliases),
          favoriteDirectories: parseFavoriteDirectories(raw.favoriteDirectories) ?? [],
          enabledPlugins: Array.isArray(raw.enabledPlugins)
            ? [...new Set(raw.enabledPlugins.filter((id): id is string => typeof id === "string" && WEB_PLUGIN_ID_RE.test(id)))]
            : [],
          memoryGuard: parseMemoryGuardSettings(raw.memoryGuard),
        };
      }
    }
  } catch {
    // Unreadable settings fall back to the defaults.
  }
  globalThis.__ompWebSettingsCache = { path, settings };
  return settings;
}

/** Atomic write (temp file + rename), like the project registry. */
export function saveWebServerSettings(patch: Partial<WebServerSettings>): WebServerSettings {
  const path = settingsPath();
  const settings = { ...loadWebServerSettings(), ...patch };
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
  globalThis.__ompWebSettingsCache = { path, settings };
  return settings;
}
