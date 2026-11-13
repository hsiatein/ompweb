import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from "fs";
import http from "http";
import net from "net";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";
import { startWebPluginHost, stopWebPluginHost } from "./web-plugin-host";
import { getAgentDir } from "./omp/paths";
import { hasServerHostTool, refreshServerHostTools, registerServerHostTool, unregisterServerHostTool } from "./rpc-manager";
import { preferForOomKill } from "./system-stats";
import { userEnv } from "./terminal-manager";
import { isRecord } from "./type-guards";
import { WEB_PLUGIN_ID_RE, webPluginFileUrl, type WebPluginInfo, type WebPluginStatus } from "./web-plugin-types";
import { loadWebServerSettings, saveWebServerSettings } from "./web-settings";

// Web plugins: `<agent dir>/web-plugins/<id>/` with a manifest, static pages
// shown in the sidebar, and an optional Node server on a unix socket that the
// page (through /api/web-plugins/<id>/api/*) and agent tools talk to.
// Contract: docs/PLUGINS.md.

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 3_000;
const MAX_RESTART_DELAY_MS = 30_000;
/** A server that stayed up this long starts its backoff over after a crash. */
const STABLE_UPTIME_MS = 60_000;
const LOG_MAX_BYTES = 1_000_000;
const TOOL_TIMEOUT_MS = 120_000;

export interface WebPluginTool { name: string; description: string; parameters: Record<string, unknown> }

interface Manifest {
  id: string;
  name: string;
  description: string;
  version: string | null;
  icon: string | null;
  entry: string;
  server: string | null;
  maxRequestBytes: number;
  tools: WebPluginTool[];
}

interface Runtime {
  status: WebPluginStatus;
  error: string | null;
  child: ChildProcess | null;
  /** Bumped on every start/stop so stale exits and timers are ignored. */
  generation: number;
  restarts: number;
  restartTimer: NodeJS.Timeout | null;
  startedAt: number;
  tools: string[];
  recentOutput: string[];
}

declare global {
  var __ompWebPluginRuntimes: Map<string, Runtime> | undefined;
  var __ompWebPluginExitHook: boolean | undefined;
}

function runtimes(): Map<string, Runtime> {
  globalThis.__ompWebPluginRuntimes ??= new Map();
  return globalThis.__ompWebPluginRuntimes;
}

function runtime(id: string): Runtime {
  let entry = runtimes().get(id);
  if (!entry) {
    entry = { status: "stopped", error: null, child: null, generation: 0, restarts: 0, restartTimer: null, startedAt: 0, tools: [], recentOutput: [] };
    runtimes().set(id, entry);
  }
  return entry;
}

export function webPluginsRoot(): string {
  return path.join(getAgentDir(), "web-plugins");
}

function dataDir(id: string): string {
  return path.join(getAgentDir(), "web-plugin-data", id);
}

function socketPath(id: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(tmpdir(), `omp-web-plugins-${uid}`, `${id}.sock`);
}

class ManifestError extends Error {}

/** A relative path that stays inside the plugin directory. */
function relativeFile(value: unknown, field: string, fallback: string | null): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new ManifestError(`${field} must be a relative path`);
  const normalized = path.posix.normalize(value.trim().replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) throw new ManifestError(`${field} must stay inside the plugin directory`);
  return normalized;
}

function readManifest(id: string): Manifest {
  const dir = path.join(webPluginsRoot(), id);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    throw new ManifestError(`manifest.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new ManifestError("manifest.json must be an object");
  if (raw.id !== undefined && raw.id !== id) throw new ManifestError(`manifest id "${String(raw.id)}" does not match the directory name "${id}"`);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : id;
  const description = typeof raw.description === "string" ? raw.description.trim().slice(0, 300) : "";
  const version = typeof raw.version === "string" ? raw.version.slice(0, 40) : null;
  const server = relativeFile(raw.server, "server", null);
  const maxRequestBytes = raw.maxRequestBytes ?? 1024 * 1024;
  if (typeof maxRequestBytes !== "number" || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 64 * 1024 * 1024) {
    throw new ManifestError("maxRequestBytes must be an integer between 1 and 67108864");
  }
  const tools: WebPluginTool[] = [];
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) throw new ManifestError("tools must be an array");
    if (!server) throw new ManifestError("tools need a server");
    for (const tool of raw.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || !TOOL_NAME_RE.test(tool.name)) throw new ManifestError("each tool needs a name like my_tool");
      if (typeof tool.description !== "string" || !tool.description.trim()) throw new ManifestError(`tool ${tool.name} needs a description`);
      const parameters = isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} };
      tools.push({ name: tool.name, description: tool.description, parameters });
    }
  }
  return {
    id,
    name,
    description,
    version,
    icon: relativeFile(raw.icon, "icon", null),
    entry: relativeFile(raw.entry, "entry", "index.html") ?? "index.html",
    server,
    maxRequestBytes,
    tools,
  };
}

function pluginIds(): string[] {
  const root = webPluginsRoot();
  try {
    return readdirSync(root)
      .filter((name) => WEB_PLUGIN_ID_RE.test(name))
      .filter((name) => {
        try {
          return statSync(path.join(root, name)).isDirectory(); // follows symlinked plugin dirs
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function enabledIds(): Set<string> {
  return new Set(loadWebServerSettings().enabledPlugins);
}

export function listWebPlugins(): WebPluginInfo[] {
  const enabled = enabledIds();
  return pluginIds().map((id) => {
    const state = runtime(id);
    try {
      const manifest = readManifest(id);
      const isEnabled = enabled.has(id);
      return {
        id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        enabled: isEnabled,
        iconUrl: manifest.icon ? webPluginFileUrl(id, manifest.icon) : null,
        entryUrl: webPluginFileUrl(id, manifest.entry),
        hasServer: manifest.server !== null,
        tools: manifest.tools.map((tool) => tool.name),
        status: isEnabled ? (manifest.server ? state.status : "running") : "stopped",
        error: state.error,
      };
    } catch (error) {
      return {
        id, name: id, description: "", version: null, enabled: false, iconUrl: null,
        entryUrl: webPluginFileUrl(id, "index.html"), hasServer: false, tools: [],
        status: "invalid" as const, error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export class WebPluginError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Absolute path of a file an ENABLED plugin may serve, confined to its directory. */
export function resolveWebPluginFile(id: string, relative: string): string {
  if (!WEB_PLUGIN_ID_RE.test(id) || !enabledIds().has(id)) throw new WebPluginError("Plugin not found or disabled", 404);
  let root: string;
  let file: string;
  try {
    root = realpathSync(path.join(webPluginsRoot(), id));
    file = realpathSync(path.resolve(root, relative));
  } catch {
    throw new WebPluginError("File not found", 404);
  }
  if (!file.startsWith(root + path.sep) || !statSync(file).isFile()) throw new WebPluginError("File not found", 404);
  return file;
}

function appendLog(id: string, text: string): void {
  const state = runtime(id);
  for (const line of text.split("\n")) {
    if (line.trim()) state.recentOutput.push(line.slice(0, 500));
  }
  state.recentOutput.splice(0, Math.max(0, state.recentOutput.length - 20));
  const logPath = path.join(dataDir(id), "server.log");
  try {
    try {
      if (statSync(logPath).size > LOG_MAX_BYTES) renameSync(logPath, `${logPath}.old`);
    } catch { /* first write */ }
    appendFileSync(logPath, text);
  } catch { /* logging must never break the plugin */ }
}

function waitForSocket(socket: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error("server exited before it was ready"));
        return;
      }
      const connection = net.connect(socket);
      connection.once("connect", () => { connection.destroy(); resolve(); });
      connection.once("error", () => {
        connection.destroy();
        if (Date.now() > deadline) reject(new Error(`server did not listen on its socket within ${READY_TIMEOUT_MS / 1000}s`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function registerTools(id: string, manifest: Manifest): string[] {
  const registered: string[] = [];
  for (const tool of manifest.tools) {
    if (hasServerHostTool(tool.name)) {
      appendLog(id, `[omp-web] tool ${tool.name} skipped: the name is already taken\n`);
      continue;
    }
    registerServerHostTool({
      definition: { name: tool.name, description: tool.description, parameters: tool.parameters },
      run: async (caller, args) => {
        const response = await requestWebPlugin(id, {
          method: "POST",
          path: `/__tools/${tool.name}`,
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({ arguments: args, caller })),
        }, TOOL_TIMEOUT_MS);
        const text = response.body.toString("utf8");
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        if (response.status >= 400) throw new Error(isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : `plugin answered ${response.status}`);
        if (isRecord(parsed) && typeof parsed.text === "string") return parsed.text;
        return text;
      },
    });
    registered.push(tool.name);
  }
  return registered;
}

function dropTools(state: Runtime): boolean {
  if (state.tools.length === 0) return false;
  for (const name of state.tools) unregisterServerHostTool(name);
  state.tools = [];
  return true;
}

function ensureExitHook(): void {
  if (globalThis.__ompWebPluginExitHook) return;
  globalThis.__ompWebPluginExitHook = true;
  process.once("exit", () => {
    for (const state of runtimes().values()) state.child?.kill("SIGTERM");
  });
}

async function startServer(id: string, manifest: Manifest): Promise<void> {
  const state = runtime(id);
  const generation = ++state.generation;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  state.restartTimer = null;
  state.recentOutput = [];
  const root = realpathSync(path.join(webPluginsRoot(), id));
  const script = path.resolve(root, manifest.server!);
  if (!script.startsWith(root + path.sep) || !existsSync(script)) {
    state.status = "crashed";
    state.error = `server file not found: ${manifest.server}`;
    return;
  }
  const socket = socketPath(id);
  mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  try { unlinkSync(socket); } catch { /* no stale socket */ }
  const data = dataDir(id);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  ensureExitHook();
  state.status = "starting";
  state.error = null;
  state.startedAt = Date.now();
  appendLog(id, `[omp-web] ${new Date().toISOString()} starting ${manifest.server}\n`);
  // The user's environment, minus omp-web's own variables (password, port, Next internals).
  const hostSocket = await startWebPluginHost(id, (text) => appendLog(id, text));
  if (state.generation !== generation) return;
  const env: Record<string, string> = { ...userEnv(), OMP_WEB_PLUGIN_ID: id, OMP_WEB_PLUGIN_SOCKET: socket, OMP_WEB_PLUGIN_DATA: data, OMP_WEB_HOST_SOCKET: hostSocket };
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  if (child.pid) preferForOomKill(child.pid);
  child.stdout?.on("data", (chunk: Buffer) => appendLog(id, chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => appendLog(id, chunk.toString("utf8")));
  child.once("error", (error) => appendLog(id, `[omp-web] spawn failed: ${error.message}\n`));
  child.once("exit", (code, signal) => {
    if (state.generation !== generation) return;
    state.child = null;
    if (dropTools(state)) void refreshServerHostTools();
    appendLog(id, `[omp-web] server exited (${signal ?? `code ${code}`})\n`);
    if (!enabledIds().has(id)) {
      state.status = "stopped";
      return;
    }
    const last = state.recentOutput.filter((line) => !line.startsWith("[omp-web]")).at(-1);
    state.status = "crashed";
    state.error ??= `server exited (${signal ?? `code ${code}`})${last ? `: ${last}` : ""}`;
    if (Date.now() - state.startedAt > STABLE_UPTIME_MS) state.restarts = 0;
    const delay = Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** state.restarts);
    state.restarts += 1;
    state.restartTimer = setTimeout(async () => {
      if (state.generation !== generation || !enabledIds().has(id)) return;
      try {
        await startServer(id, readManifest(id));
      } catch (error) {
        state.status = "invalid";
        state.error = error instanceof Error ? error.message : String(error);
      }
    }, delay);
    state.restartTimer.unref?.();
  });
  waitForSocket(socket, child).then(() => {
    if (state.generation !== generation) return;
    state.status = "running";
    state.tools = registerTools(id, manifest);
    if (state.tools.length > 0) void refreshServerHostTools();
  }, (error: Error) => {
    if (state.generation !== generation) return;
    state.error = error.message;
    child.kill("SIGKILL");
  });
}

async function stopServer(id: string): Promise<void> {
  const state = runtime(id);
  state.generation += 1;
  stopWebPluginHost(id);
  if (state.restartTimer) clearTimeout(state.restartTimer);
  state.restartTimer = null;
  state.restarts = 0;
  state.error = null;
  if (dropTools(state)) await refreshServerHostTools();
  const child = state.child;
  state.child = null;
  state.status = "stopped";
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function startPlugin(id: string): Promise<void> {
  const manifest = readManifest(id);
  if (manifest.server) await startServer(id, manifest);
}

/** Switch a plugin on or off (persisted); starts or stops its server. */
export async function setWebPluginEnabled(id: string, enabled: boolean): Promise<void> {
  if (!WEB_PLUGIN_ID_RE.test(id) || !pluginIds().includes(id)) throw new WebPluginError("Plugin not found", 404);
  if (enabled) {
    try {
      readManifest(id);
    } catch (error) {
      throw new WebPluginError(error instanceof Error ? error.message : String(error), 400);
    }
  }
  const current = loadWebServerSettings().enabledPlugins.filter((entry) => entry !== id);
  saveWebServerSettings({ enabledPlugins: enabled ? [...current, id] : current });
  await stopServer(id);
  if (enabled) await startPlugin(id);
}

/** Restart an enabled plugin's server (after editing its files). */
export async function restartWebPlugin(id: string): Promise<void> {
  if (!enabledIds().has(id)) throw new WebPluginError("Plugin not found or disabled", 404);
  await stopServer(id);
  try {
    await startPlugin(id);
  } catch (error) {
    throw new WebPluginError(error instanceof Error ? error.message : String(error), 400);
  }
}

/** Startup: run every enabled plugin's server. */
export function startEnabledWebPlugins(): void {
  const installed = new Set(pluginIds());
  for (const id of enabledIds()) {
    if (!installed.has(id) || runtime(id).child) continue;
    void startPlugin(id).catch((error) => {
      const state = runtime(id);
      state.status = "invalid";
      state.error = error instanceof Error ? error.message : String(error);
    });
  }
}

export interface WebPluginResponse { status: number; contentType: string | null; body: Buffer }

interface PluginRequest { method: string; path: string; contentType?: string | null; body?: Buffer; signal?: AbortSignal }

export function webPluginRequestLimit(id: string): number {
  if (!WEB_PLUGIN_ID_RE.test(id) || !enabledIds().has(id)) throw new WebPluginError("Plugin not found or disabled", 404);
  return readManifest(id).maxRequestBytes;
}

/** Resolve at headers; keep cancellation attached until the socket response closes. */
function openWebPluginRequest(id: string, request: PluginRequest, timeoutMs: number): Promise<http.IncomingMessage> {
  const state = runtimes().get(id);
  if (!enabledIds().has(id) || !state || state.status !== "running") {
    return Promise.reject(new WebPluginError(state?.status === "starting" ? "Plugin server is starting" : "Plugin server is not running", 503));
  }
  const { promise, resolve, reject } = Promise.withResolvers<http.IncomingMessage>();
  const headers: Record<string, string> = {};
  if (request.contentType) headers["content-type"] = request.contentType;
  if (request.body) headers["content-length"] = String(request.body.length);
  const outgoing = http.request({ socketPath: socketPath(id), method: request.method, path: request.path, headers, timeout: timeoutMs, signal: request.signal }, resolve);
  outgoing.on("timeout", () => outgoing.destroy(new WebPluginError("Plugin server timed out", 504)));
  outgoing.on("error", (error) => reject(error instanceof WebPluginError ? error : new WebPluginError(`Plugin server unreachable: ${error.message}`, 502)));
  outgoing.end(request.body);
  return promise;
}

/** Page responses stream with backpressure; cancelling the body closes the socket. */
export async function streamWebPlugin(id: string, request: PluginRequest): Promise<Response> {
  const response = await openWebPluginRequest(id, request, 0);
  const status = response.statusCode ?? 502;
  const empty = request.method === "HEAD" || status === 204 || status === 205 || status === 304;
  if (empty) response.resume();
  return new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, {
    status,
    headers: {
      "content-type": response.headers["content-type"] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

/** Tool calls retain their bounded-duration, buffered response contract. */
export async function requestWebPlugin(id: string, request: PluginRequest, timeoutMs = 30_000): Promise<WebPluginResponse> {
  const response = await openWebPluginRequest(id, request, timeoutMs);
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk);
  return { status: response.statusCode ?? 502, contentType: response.headers["content-type"] ?? null, body: Buffer.concat(chunks) };
}
