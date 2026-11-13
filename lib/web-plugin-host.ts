import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ompBinaryFingerprint, resolveOmpBin } from "./omp/omp-cli";
import { accountProxyEnvironment } from "./account-proxy";
import { ensureGlobalRequestPolicyFile } from "./request-policy-files";
import { preferForOomKill } from "./system-stats";
import { userEnv } from "./terminal-manager";
import { WebPluginGateway } from "./web-plugin-gateway";
import { randomUUID } from "node:crypto";
import { getWebModels } from "./web-models";
import { selectableThinkingLevels } from "./thinking-levels";
import { accountRoutingSpawnArgs, releaseAccountRoutingPolicy, sanitizeAccountPins, isProviderId, loadAccountRouting } from "./account-routing";
import { getProviderUsage } from "./provider-usage";
import { groupAccountChoices } from "./account-choices";
import { loadWebServerSettings } from "./web-settings";

interface HostSocket { server: http.Server; path: string; ready: Promise<string> }
interface HostState { gateway: WebPluginGateway; sockets: Map<string, HostSocket> }
declare global { var __ompWebPluginHost: HostState | undefined; }

function state(): HostState {
  if (globalThis.__ompWebPluginHost) return globalThis.__ompWebPluginHost;
  const gateway = new WebPluginGateway({
    binary: resolveOmpBin,
    fingerprint: ompBinaryFingerprint,
    // Per-account proxies apply to plugin model calls exactly as to chats.
    environment: () => ({ ...userEnv(), ...accountProxyEnvironment(), OMP_AUTH_REQUEST_POLICY_FILES: JSON.stringify([ensureGlobalRequestPolicyFile()]) }),
    spawned: preferForOomKill,
  });
  const host: HostState = { gateway, sockets: new Map() };
  globalThis.__ompWebPluginHost = host;
  const shutdown = () => {
    void gateway.shutdown();
    for (const id of host.sockets.keys()) stopWebPluginHost(id);
  };
  process.once("exit", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return host;
}

/** Per-plugin sockets attribute failures to the requesting plugin's log. */
export function startWebPluginHost(id: string, log: (text: string) => void): Promise<string> {
  const host = state();
  const existing = host.sockets.get(id);
  if (existing) return existing.ready;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  // PID isolates dev/live servers; short names stay within sockaddr_un's limit.
  const socket = path.join(tmpdir(), `omp-web-host-${uid}-${process.pid}`, `${id}.sock`);
  if (Buffer.byteLength(socket) > 103) throw new Error("Plugin host socket path exceeds the Unix socket limit");
  mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  const server = http.createServer(async (request, response) => {
    try {
      const route = request.url ?? "/";
      const url = new URL(route, "http://plugin-host");
      if (request.method === "GET" && url.pathname === "/omp/models") {
        const catalog = await getWebModels();
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ...catalog,
          thinkingLevels: Object.fromEntries(Object.entries(catalog.thinkingLevels).map(([key, levels]) => [key, selectableThinkingLevels(levels)])),
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/omp/accounts") {
        const provider = url.searchParams.get("provider") ?? "";
        if (!isProviderId(provider)) {
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid provider" }));
          return;
        }
        const usage = await getProviderUsage({ provider, modelId: url.searchParams.get("model") ?? undefined }, loadWebServerSettings().accountAliases);
        const routing = loadAccountRouting();
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          choices: groupAccountChoices(usage.reports).get(provider) ?? [],
          disabled: routing.disabled,
          disabledProviders: routing.disabledProviders,
        }));
        return;
      }
      if (!route.startsWith("/v1/")) {
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Host API route not found" }));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) {
          response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "Host API body exceeds 64 MiB" }));
          return;
        }
        chunks.push(chunk);
      }
      let body: unknown;
      if (length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch {
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Host API expects a JSON body" }));
          return;
        }
      }
      const routingHeader = request.headers["x-omp-account-routing"];
      let gateway = host.gateway;
      if (routingHeader !== undefined) {
        let policy;
        try {
          if (typeof routingHeader !== "string") throw new Error("Invalid routing header");
          const routing = JSON.parse(Buffer.from(routingHeader, "base64url").toString("utf8"));
          if (!routing || typeof routing !== "object" || Array.isArray(routing)) throw new Error("Invalid account routing");
          if (routing.provider !== undefined && !isProviderId(routing.provider)) throw new Error("Invalid provider");
          policy = await accountRoutingSpawnArgs(`plugin-${randomUUID()}`, sanitizeAccountPins(routing.pins), routing.provider);
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error) }));
          return;
        }
        // Request-owned child: concurrent chats keep independent hard policies.
        gateway = new WebPluginGateway({
          binary: resolveOmpBin,
          fingerprint: ompBinaryFingerprint,
          environment: () => ({ ...userEnv(), ...accountProxyEnvironment(), ...policy.env }),
          spawned: preferForOomKill,
        });
        const routed = gateway;
        const file = policy.file;
        response.once("close", () => {
          void routed.shutdown().finally(() => releaseAccountRoutingPolicy(file));
        });
        if (response.destroyed) {
          void routed.shutdown().finally(() => releaseAccountRoutingPolicy(file));
          return;
        }
      }
      await gateway.request(route, request.method ?? "GET", body, response, log);
    } catch (error) {
      if (response.destroyed) return;
      log(`[omp-web host] ${error instanceof Error ? error.message : String(error)}\n`);
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error) }));
    }
  });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  server.on("error", (error) => {
    host.sockets.delete(id);
    log(`[omp-web host] ${error.message}\n`);
    reject(error);
  });
  host.sockets.set(id, { server, path: socket, ready: promise });
  server.listen(socket, () => {
    try { chmodSync(socket, 0o600); resolve(socket); }
    catch (error) { stopWebPluginHost(id); reject(error); }
  });
  server.unref();
  return promise;
}

export function stopWebPluginHost(id: string): void {
  const host = globalThis.__ompWebPluginHost;
  const socket = host?.sockets.get(id);
  if (!host || !socket) return;
  host.sockets.delete(id);
  socket.server.closeAllConnections();
  socket.server.close();
  try { unlinkSync(socket.path); } catch { /* Already removed by close. */ }
}
