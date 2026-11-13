import http from "http";
import { networkInterfaces } from "os";

/**
 * Dedicated webhook listeners: plain HTTP servers bound to the addresses of
 * chosen network interfaces (loopback, LAN, WireGuard, ...) on a chosen port,
 * independent of where omp-web itself listens. They answer exactly one route,
 * `POST /hooks/<token>`; everything else is 404. The token is the credential,
 * as on omp-web's own `/api/hooks/<token>`.
 *
 * This module only binds and routes. Which addresses to bind, and whether a
 * token is valid on the address it arrived at, is decided by the caller
 * (lib/scheduled-tasks.ts) through `reconcileWebhookListeners`.
 */

export interface NetworkInterfaceInfo {
  name: string;
  /** Usable bind addresses (IPv6 link-local omitted: it needs a zone id). */
  addresses: string[];
  internal: boolean;
}

export interface WebhookBinding {
  iface: string;
  address: string;
  port: number;
}

export type WebhookCallResult = "accepted" | "not_found" | "disabled";

export type WebhookCallHandler = (binding: WebhookBinding, token: string, payload: string | null) => WebhookCallResult;

/** Larger than the part kept in the prompt; the rest is cut there. */
const MAX_BODY_BYTES = 256 * 1024;
/** Interface names as the kernel reports them (`lo`, `enp5s0`, `wg0`, `br-1a2b`). */
export const INTERFACE_NAME_RE = /^[A-Za-z0-9_.:@-]{1,32}$/;

interface Listener {
  binding: WebhookBinding;
  server: http.Server;
  /** Set once listening; bind failures are kept in `errors` instead. */
  ready: boolean;
}

interface ListenerState {
  listeners: Map<string, Listener>;
  /** Last bind error per address:port, retried on the next reconcile. */
  errors: Map<string, string>;
  handler: WebhookCallHandler | null;
}

declare global {
  var __ompWebhookListeners: ListenerState | undefined;
}

// On globalThis: servers survive Next.js hot-reload, and every route bundle
// reconciles the same set.
function state(): ListenerState {
  globalThis.__ompWebhookListeners ??= { listeners: new Map(), errors: new Map(), handler: null };
  return globalThis.__ompWebhookListeners;
}

function key(address: string, port: number): string {
  return `${address}|${port}`;
}

export function listNetworkInterfaces(): NetworkInterfaceInfo[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => {
    const addresses = (entries ?? [])
      .filter((entry) => !(entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80:")))
      .map((entry) => entry.address);
    if (addresses.length === 0) return [];
    return [{ name, addresses, internal: (entries ?? []).every((entry) => entry.internal) }];
  });
}

/** `http://<address>:<port>/hooks/<token>`, IPv6 in brackets. */
export function webhookListenerUrl(address: string, port: number, token: string): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `http://${host}:${port}/hooks/${token}`;
}

/** Bind error of address:port, if the last attempt failed. */
export function webhookListenerError(address: string, port: number): string | undefined {
  return state().errors.get(key(address, port));
}

function readBody(req: http.IncomingMessage): Promise<Buffer | "too_large"> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer | "too_large">();
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    resolve("too_large");
    req.resume();
    return promise;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      resolve("too_large");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
  return promise;
}

async function handle(binding: WebhookBinding, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const match = /^\/hooks\/([^/?#]+)\/?(?:[?#].*)?$/.exec(req.url ?? "");
  if (!match) return reply(404, { error: "Not found", code: "not_found" });
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return reply(405, { error: "Method not allowed", code: "method_not_allowed" });
  }
  let payload: string | null = null;
  try {
    const body = await readBody(req);
    if (body === "too_large") return reply(413, { error: "Webhook body is too large", code: "request_too_large" });
    payload = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // Not UTF-8 (or the connection dropped): run without the body.
    payload = null;
  }
  const handler = state().handler;
  const result = handler ? handler(binding, decodeURIComponent(match[1]), payload) : "not_found";
  if (result === "not_found") return reply(404, { error: "Not found", code: "not_found" });
  if (result === "disabled") return reply(409, { error: "This task is paused", code: "task_disabled" });
  reply(202, { accepted: true });
}

function start(binding: WebhookBinding): Listener {
  const current = state();
  const id = key(binding.address, binding.port);
  const listener: Listener = { binding, server: http.createServer(), ready: false };
  listener.server.on("request", (req, res) => {
    handle(listener.binding, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  listener.server.headersTimeout = 10_000;
  listener.server.requestTimeout = 30_000;
  listener.server.on("error", (error: NodeJS.ErrnoException) => {
    current.errors.set(id, error.code ?? error.message);
    if (current.listeners.get(id) === listener) current.listeners.delete(id);
    listener.server.close();
  });
  listener.server.listen({ host: binding.address, port: binding.port, exclusive: true }, () => {
    listener.ready = true;
    current.errors.delete(id);
    console.log(`[omp-web] webhook listener on ${webhookListenerUrl(binding.address, binding.port, "<token>")} (${binding.iface})`);
  });
  listener.server.unref();
  return listener;
}

/**
 * Bind exactly `wanted` (deduplicated by address:port) and route calls to
 * `handler`. Listeners no longer wanted close; failed binds retry here.
 */
export function reconcileWebhookListeners(wanted: WebhookBinding[], handler: WebhookCallHandler): void {
  const current = state();
  current.handler = handler;
  const next = new Map(wanted.map((binding) => [key(binding.address, binding.port), binding]));
  for (const [id, listener] of current.listeners) {
    if (next.has(id)) continue;
    current.listeners.delete(id);
    listener.server.close();
    console.log(`[omp-web] webhook listener closed: ${listener.binding.address}:${listener.binding.port}`);
  }
  for (const id of current.errors.keys()) if (!next.has(id)) current.errors.delete(id);
  for (const [id, binding] of next) {
    const existing = current.listeners.get(id);
    if (existing) {
      // Same address, possibly a renamed interface: route by the new name.
      existing.binding = binding;
      continue;
    }
    current.listeners.set(id, start(binding));
  }
}
