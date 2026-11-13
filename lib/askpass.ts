import { spawn } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import http from "http";
import path from "path";
import { AskpassPeerError, verifyAskpassPeer } from "./askpass-peer";

/**
 * Password prompts for agent commands (sudo) answered in the web UI.
 *
 * Agent shells have no terminal, so omp-web puts `bin/askpass/sudo` first on
 * the omp child's PATH; it runs the real sudo with -A, and sudo starts
 * $SUDO_ASKPASS (`bin/askpass/omp-web-askpass` → askpass-client.cjs). The
 * client asks this module over a loopback-only HTTP server with the child's
 * token; after checking (lib/askpass-peer.ts) that the request really comes
 * from that client under sudo, the request is shown in every open tab
 * (/api/events). The typed password goes back to the client, which
 * prints it for sudo. It never reaches the model, is never logged or stored.
 * Linux only: everywhere else agent sudo behaves as before.
 */

export interface AskpassRequestInfo {
  id: string;
  sessionId: string;
  sessionName?: string;
  cwd: string;
  /** sudo's own prompt, e.g. "[sudo] password for alice: ". */
  prompt: string;
  /** Verified command line of the sudo process asking. */
  command: string[];
  createdAt: number;
  expiresAt: number;
}

export interface AskpassSessionIdentity {
  sessionId: string;
  sessionName?: string;
  cwd: string;
}

/** Long enough to switch to the tab, short enough to end before omp's 300 s bash timeout. */
export const ASKPASS_TIMEOUT_MS = 240_000;
const MAX_REQUEST_BYTES = 8 * 1024;

const WEB_SUDO_INSTRUCTIONS = `## omp-web sudo authorization
Use only omp-web's browser password dialog for sudo authentication, even if earlier conversation history used a desktop askpass.
Run ordinary sudo commands through PATH; omp-web supplies the sudo wrapper and SUDO_ASKPASS. sudo -n remains allowed for non-interactive checks.
Do not replace or unset SUDO_ASKPASS, bypass the wrapper to change authentication, or invoke a different askpass, pkexec, kdialog, zenity, or another desktop authorization prompt to obtain a password.
Never ask for passwords in chat or generic input tools, or pass passwords through command arguments, sudo -S, files, or logs.
If web authorization is refused, times out, or is unavailable, stop the privileged operation and report the failure. Do not switch authentication channels or retry a refusal unless the user requests it.`;

/** Preserve the workspace's effective append prompt: omp accepts only the last occurrence. */
export function withWebAskpassPrompt(args: string[], cwd: string, enabled: boolean): string[] {
  if (!enabled) return args;
  const separator = args.indexOf("--");
  const end = separator < 0 ? args.length : separator;
  let previous = "";
  for (let i = 0; i < end; i++) {
    if (args[i] === "--append-system-prompt" && i + 1 < end) previous = args[++i];
    else if (args[i].startsWith("--append-system-prompt=")) previous = args[i].slice("--append-system-prompt=".length);
  }
  if (previous) {
    const file = path.resolve(cwd, previous);
    if (existsSync(file)) previous = readFileSync(file, "utf8");
  }
  const prompt = previous ? `${previous}\n\n${WEB_SUDO_INSTRUCTIONS}` : WEB_SUDO_INSTRUCTIONS;
  return [...args.slice(0, end), "--append-system-prompt", prompt, ...args.slice(end)];
}

interface PendingRequest {
  info: AskpassRequestInfo;
  finish: (password: string | null) => void;
}

interface AskpassState {
  tokens: Map<string, () => AskpassSessionIdentity>;
  pending: Map<string, PendingRequest>;
  listeners: Set<(requests: AskpassRequestInfo[]) => void>;
  server: Promise<number> | null;
  /**
   * Settings → "Answer sudo automatically": the verified password, held in
   * this process's memory only (never written or logged). A restart turns it off.
   */
  autoPassword?: string | null;
}

declare global {
  var __ompAskpass: AskpassState | undefined;
}

function state(): AskpassState {
  globalThis.__ompAskpass ??= { tokens: new Map(), pending: new Map(), listeners: new Set(), server: null };
  return globalThis.__ompAskpass;
}

function helperDir(): string {
  return path.join(process.cwd(), "bin", "askpass");
}

function findRealSudo(skipDir: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || path.resolve(dir) === skipDir) continue;
    const candidate = path.join(dir, "sudo");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function pendingList(): AskpassRequestInfo[] {
  return [...state().pending.values()].map((entry) => entry.info).sort((a, b) => a.createdAt - b.createdAt);
}

function publish(): void {
  const list = pendingList();
  for (const listener of state().listeners) listener(list);
}

/** Browser side: called with the full pending list now and on every change. */
export function subscribeAskpassRequests(listener: (requests: AskpassRequestInfo[]) => void): () => void {
  state().listeners.add(listener);
  listener(pendingList());
  return () => { state().listeners.delete(listener); };
}

/** Answer (or with `null`, refuse) a pending request. */
export function answerAskpassRequest(id: string, password: string | null): boolean {
  const entry = state().pending.get(id);
  if (!entry) return false;
  entry.finish(password);
  return true;
}

/** Can this server answer sudo prompts at all (Linux, helper files, a real sudo)? */
export function askpassSupported(): boolean {
  if (process.platform !== "linux") return false;
  const dir = helperDir();
  return existsSync(path.join(dir, "omp-web-askpass")) && existsSync(path.join(dir, "askpass-client.cjs")) && findRealSudo(dir) !== null;
}

export function askpassAutoEnabled(): boolean {
  return typeof state().autoPassword === "string";
}

/**
 * Check `password` against this machine's sudo without using or refreshing
 * sudo's cached credentials (`-k` with a command). The password goes through
 * the child's stdin only.
 */
function verifySudoPassword(password: string): Promise<boolean> {
  const realSudo = findRealSudo(helperDir());
  if (!realSudo) return Promise.resolve(false);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const child = spawn(realSudo, ["-S", "-k", "-p", "", "--", "true"], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, LC_ALL: "C" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  child.on("error", () => { clearTimeout(timer); resolve(false); });
  child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  child.stdin.on("error", () => {});
  child.stdin.end(`${password}\n`);
  return promise;
}

/**
 * Turn automatic answers on (after verifying the password) or off. While on,
 * every verified sudo prompt from an agent is answered with the stored
 * password without a dialog; prompts already waiting are answered at once.
 */
export async function setAskpassAuto(password: string | null): Promise<boolean> {
  if (password === null) {
    state().autoPassword = null;
    return true;
  }
  if (!(await verifySudoPassword(password))) return false;
  state().autoPassword = password;
  for (const entry of [...state().pending.values()]) entry.finish(password);
  return true;
}

/**
 * Queue a verified request until a tab answers, the client goes away or it
 * times out. With no tab open there is nobody to ask: refuse at once so the
 * command fails fast instead of hanging.
 */
export function awaitAskpassAnswer(
  identity: AskpassSessionIdentity,
  prompt: string,
  command: string[],
  signal: AbortSignal,
  timeoutMs = ASKPASS_TIMEOUT_MS,
): Promise<string | null> {
  if (state().listeners.size === 0 || signal.aborted) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const now = Date.now();
  const info: AskpassRequestInfo = { id: randomUUID(), ...identity, prompt, command, createdAt: now, expiresAt: now + timeoutMs };
  let done = false;
  const finish = (password: string | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    state().pending.delete(info.id);
    publish();
    resolve(password);
  };
  const onAbort = () => finish(null);
  const timer = setTimeout(onAbort, timeoutMs);
  timer.unref?.();
  signal.addEventListener("abort", onAbort);
  state().pending.set(info.id, { info, finish });
  publish();
  return promise;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let size = 0;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      reject(new Error("request too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
  return promise;
}

async function handleClient(req: http.IncomingMessage, res: http.ServerResponse, serverPort: number, clientScript: string): Promise<void> {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });

  let token = "";
  let prompt = "";
  try {
    const body = JSON.parse(await readBody(req)) as { token?: unknown; prompt?: unknown };
    token = typeof body.token === "string" ? body.token : "";
    prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 500) : "";
  } catch {
    return reply(400, { error: "bad request" });
  }
  const identity = state().tokens.get(token);
  if (!identity) return reply(403, { error: "unknown token" });

  let command: string[];
  try {
    command = verifyAskpassPeer({
      clientPort: req.socket.remotePort ?? 0,
      serverPort,
      nodePath: realpathSync(process.execPath),
      clientScript,
    }).sudoCommand;
  } catch (error) {
    const reason = error instanceof AskpassPeerError ? error.message : "verification failed";
    console.warn(`[omp-web] refused a password request: ${reason}`);
    return reply(403, { error: "refused" });
  }

  const aborted = new AbortController();
  res.on("close", () => aborted.abort());
  const auto = state().autoPassword;
  if (typeof auto === "string") {
    const who = identity();
    console.info(`[omp-web] sudo answered automatically for ${who.sessionName || who.sessionId}: ${command.join(" ")}`);
    return reply(200, { password: auto });
  }
  const password = await awaitAskpassAnswer(identity(), prompt, command, aborted.signal);
  if (password === null) return reply(410, { error: "no password given" });
  reply(200, { password });
}

/** Loopback server the askpass client talks to; one per omp-web process. */
function ensureServer(clientScript: string): Promise<number> {
  const current = state();
  if (current.server) return current.server;
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  current.server = promise;
  let port = 0;
  const server = http.createServer((req, res) => {
    handleClient(req, res, port, clientScript).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.on("error", (error) => {
    current.server = null;
    reject(error);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
    server.unref();
    resolve(port);
  });
  return promise;
}

export interface AskpassSpawn {
  /** Environment for the omp child. */
  env: Record<string, string>;
  /** Call when the child exits; its token stops working. */
  revoke: () => void;
}

/**
 * Set up sudo password prompts for one omp child. Returns null where the
 * mechanism cannot work (not Linux, no sudo, helper files missing); the child
 * then runs exactly as before.
 */
export async function prepareAskpassSpawn(identity: () => AskpassSessionIdentity): Promise<AskpassSpawn | null> {
  if (process.platform !== "linux") return null;
  const dir = helperDir();
  const launcher = path.join(dir, "omp-web-askpass");
  const clientScript = path.join(dir, "askpass-client.cjs");
  if (!existsSync(launcher) || !existsSync(clientScript)) return null;
  const realSudo = findRealSudo(dir);
  if (!realSudo) return null;
  let port: number;
  try {
    port = await ensureServer(clientScript);
  } catch (error) {
    console.warn(`[omp-web] sudo password prompts unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const token = randomBytes(32).toString("hex");
  state().tokens.set(token, identity);
  return {
    env: {
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
      SUDO_ASKPASS: launcher,
      OMP_WEB_REAL_SUDO: realSudo,
      OMP_WEB_ASKPASS_URL: `http://127.0.0.1:${port}/`,
      OMP_WEB_ASKPASS_TOKEN: token,
      OMP_WEB_ASKPASS_NODE: process.execPath,
      OMP_WEB_ASKPASS_CLIENT: clientScript,
    },
    revoke: () => {
      state().tokens.delete(token);
    },
  };
}
