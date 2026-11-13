import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ServerResponse } from "node:http";

interface GatewayFrame {
  id?: string;
  ready?: boolean;
  status?: number;
  headers?: Record<string, string>;
  chunked?: boolean;
  chunk?: string;
  end?: boolean;
  error?: string;
  body?: unknown;
  encoding?: string;
}

/** Demultiplex replies without buffering streaming bodies. */
export class GatewayReplies {
  readonly pending = new Map<string, { response: ServerResponse; fail: (error: Error) => void; encoding?: string }>();

  accept(frame: GatewayFrame): void {
    if (typeof frame.id !== "string") return;
    const entry = this.pending.get(frame.id);
    if (!entry) return; // A cancelled request may still have queued frames.
    const { response } = entry;
    if (frame.error !== undefined) {
      this.pending.delete(frame.id);
      entry.fail(new Error(frame.error));
    } else if (frame.chunked) {
      entry.encoding = frame.encoding;
      response.statusCode = frame.status ?? 200;
      for (const [name, value] of Object.entries(frame.headers ?? {})) {
        if (["content-type", "cache-control", "retry-after"].includes(name.toLowerCase())) response.setHeader(name, value);
      }
      if (!response.hasHeader("content-type")) response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders();
    } else if (typeof frame.chunk === "string") {
      response.write(entry.encoding === "base64" ? Buffer.from(frame.chunk, "base64") : frame.chunk);
    } else if (frame.end) {
      this.pending.delete(frame.id);
      response.end();
    } else {
      this.pending.delete(frame.id);
      response.statusCode = frame.status ?? 502;
      // Older gateways return the complete SSE body in one envelope.
      const body = frame.encoding === "base64" && typeof frame.body === "string"
        ? Buffer.from(frame.body, "base64")
        : typeof frame.body === "string" ? frame.body : JSON.stringify(frame.body ?? null);
      if (typeof frame.body !== "string" || !response.hasHeader("content-type")) response.setHeader("content-type", frame.encoding === "base64" ? "application/octet-stream" : "application/json");
      response.end(body);
    }
  }

  failAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.fail(error);
  }
}

interface GatewayOptions {
  binary: () => string | null;
  fingerprint: () => string | null;
  environment: () => Record<string, string | undefined>;
  spawned: (pid: number) => void;
}

/** One lazy child shared by all plugin sockets; retained across Next hot reload. */
export class WebPluginGateway {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private fingerprint: string | null = null;
  private readonly replies = new GatewayReplies();
  private idleTimer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private stopping: Promise<void> | null = null;
  private closed = false;

  private readonly options: GatewayOptions;

  constructor(options: GatewayOptions) { this.options = options; }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.replies.pending.size || !this.child) return;
    this.idleTimer = setTimeout(() => { void this.stop(); }, 10 * 60_000);
    this.idleTimer.unref();
  }

  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    timer.unref();
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
    this.stopping = promise.finally(() => { this.stopping = null; });
    return this.stopping;
  }

  shutdown(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.replies.failAll(new Error("omp auth gateway is shutting down"));
    return this.stop();
  }

  private async ensure(): Promise<void> {
    if (this.closed) throw new Error("omp auth gateway is shutting down");
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.child) {
      // Preserve in-flight generations across a binary replacement.
      if (this.fingerprint === this.options.fingerprint() || this.replies.pending.size) return;
      await this.stop();
      return this.ensure();
    }
    const binary = this.options.binary();
    if (!binary) throw new Error("omp auth gateway unavailable: omp binary not found");
    const env = this.options.environment();
    this.fingerprint = this.options.fingerprint();
    const child = spawn(binary, ["auth-gateway", "stdio"], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    if (child.pid) this.options.spawned(child.pid);
    let stderr = "";
    let ready = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      reject(new Error(`omp auth gateway startup timed out${stderr ? `: ${stderr.trim()}` : ""}`));
      child.kill("SIGKILL");
    }, 30_000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const frame: GatewayFrame = JSON.parse(line);
        if (frame.ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        } else {
          const response = frame.id ? this.replies.pending.get(frame.id)?.response : undefined;
          this.replies.accept(frame);
          if (response?.writableNeedDrain) child.stdout.pause();
          this.scheduleIdle();
        }
      } catch (error) {
        const failure = new Error(`Invalid omp auth gateway reply: ${error instanceof Error ? error.message : String(error)}`);
        reject(failure);
        this.replies.failAll(failure);
        child.kill("SIGKILL");
      }
    });
    child.stdin.on("error", (error) => {
      this.replies.failAll(new Error(`omp auth gateway input failed: ${error.message}`));
    });
    child.once("error", (error) => reject(new Error(`omp auth gateway startup failed: ${error.message}`)));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      lines.close();
      if (this.child === child) this.child = null;
      const error = new Error(`omp auth gateway ${ready ? "exited" : "startup failed"} (${signal ?? `code ${code}`})${stderr ? `: ${stderr.trim()}` : ""}`);
      reject(error);
      this.replies.failAll(error);
    });
    this.starting = promise.finally(() => { this.starting = null; this.scheduleIdle(); });
    return this.starting;
  }

  async request(path: string, method: string, body: unknown, response: ServerResponse, log: (text: string) => void): Promise<void> {
    const fail = (error: Error) => {
      log(`[omp-web host] ${error.message}\n`);
      if (response.destroyed) return;
      if (response.headersSent) response.destroy(error);
      else {
        response.statusCode = 502;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: error.message }));
      }
    };
    try {
      await this.ensure();
      if (response.destroyed) return;
      const id = String(++this.sequence);
      const stream = !!body && typeof body === "object" && "stream" in body && body.stream === true;
      if (stream) response.setHeader("content-type", "text/event-stream");
      this.replies.pending.set(id, { response, fail });
      this.scheduleIdle();
      const child = this.child!;
      response.on("drain", () => child.stdout.resume());
      response.once("close", () => {
        child.stdout.resume();
        if (this.replies.pending.delete(id) && !child.stdin.destroyed) {
          child.stdin.write(`${JSON.stringify({ id, cancel: true })}\n`);
        }
        this.scheduleIdle();
      });
      child.stdin.write(`${JSON.stringify({ id, path, method, body, ...(stream ? { chunks: true } : {}) })}\n`, (error) => {
        if (error && this.replies.pending.delete(id)) { fail(error); this.scheduleIdle(); }
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
