import { existsSync, readFileSync } from "fs";
import path from "path";
import { getAgentDir } from "./omp/paths";
import { writePolicyJson } from "./request-policy-files";
import { isRecord } from "./type-guards";

export interface AccountProxyRule { provider: string; key: string; url: string }
export interface AccountProxyStatus { configured: boolean; address?: string; authenticated?: boolean }
export const ACCOUNT_PROXY_KEY_RE = /^[a-f0-9]{64}$/;
export const ACCOUNT_PROXY_PROVIDER_RE = /^[A-Za-z0-9._-]{1,80}$/;
const initializedFiles = new Set<string>();

export function validateAccountProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!value || value.length > 2048 || !["http:", "https:"].includes(url.protocol) || !url.hostname ||
      (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) throw new Error();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.href;
  } catch { throw new Error("Use an HTTP or HTTPS proxy URL without a path, query or fragment"); }
}

export function ensureAccountProxyFile(): string {
  const file = path.join(getAgentDir(), "omp-web-account-proxies.json");
  if (!existsSync(file)) {
    if (initializedFiles.has(file)) throw new Error("Account proxy settings file is missing");
    writePolicyJson(file, { version: 1, accounts: [] });
  }
  initializedFiles.add(file);
  return file;
}

export function accountProxyEnvironment(): Record<string, string> {
  return { OMP_ACCOUNT_PROXY_FILE: ensureAccountProxyFile() };
}

export function loadAccountProxies(): AccountProxyRule[] {
  try {
    const value: unknown = JSON.parse(readFileSync(ensureAccountProxyFile(), "utf8"));
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) throw new Error();
    const seen = new Set<string>();
    return value.accounts.map((item: unknown) => {
      if (!isRecord(item) || typeof item.provider !== "string" || !ACCOUNT_PROXY_PROVIDER_RE.test(item.provider) ||
        typeof item.key !== "string" || !ACCOUNT_PROXY_KEY_RE.test(item.key) || typeof item.url !== "string") throw new Error();
      const id = `${item.provider}:${item.key}`;
      if (seen.has(id)) throw new Error();
      seen.add(id);
      return { provider: item.provider, key: item.key, url: validateAccountProxyUrl(item.url) };
    });
  } catch { throw new Error("Account proxy settings are unavailable or invalid"); }
}

export function accountProxyStatus(rule: AccountProxyRule | undefined): AccountProxyStatus {
  if (!rule) return { configured: false };
  const url = new URL(rule.url);
  const authenticated = Boolean(url.username || url.password);
  url.username = "";
  url.password = "";
  return { configured: true, address: url.href, authenticated };
}

export function saveAccountProxy(provider: string, key: string, url: string): AccountProxyStatus {
  if (!ACCOUNT_PROXY_PROVIDER_RE.test(provider) || !ACCOUNT_PROXY_KEY_RE.test(key)) throw new Error("Invalid proxy account");
  const normalized = url.trim() ? validateAccountProxyUrl(url.trim()) : "";
  const accounts = loadAccountProxies().filter(rule => rule.provider !== provider || rule.key !== key);
  const rule = normalized ? { provider, key, url: normalized } : undefined;
  if (rule) accounts.push(rule);
  writePolicyJson(ensureAccountProxyFile(), { version: 1, accounts });
  return accountProxyStatus(rule);
}
