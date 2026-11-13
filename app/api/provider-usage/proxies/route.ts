import { NextResponse } from "next/server";
import { ACCOUNT_PROXY_KEY_RE, ACCOUNT_PROXY_PROVIDER_RE, accountProxyStatus, loadAccountProxies, saveAccountProxy, validateAccountProxyUrl } from "@/lib/account-proxy";
import { getProviderProxyAccounts } from "@/lib/provider-usage";
import { getAgentProcesses } from "@/lib/rpc-manager";
import { loadWebServerSettings } from "@/lib/web-settings";
import { isRecord } from "@/lib/type-guards";
import { utilitySupportsAccountProxy } from "@/lib/omp/rpc-utility";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const runtimeReady = () => utilitySupportsAccountProxy() && getAgentProcesses().every(({ wrapper }) => wrapper.accountProxyReady === true);

export async function GET(req: Request) {
  const provider = new URL(req.url).searchParams.get("provider");
  if (!provider || !ACCOUNT_PROXY_PROVIDER_RE.test(provider)) return NextResponse.json({ error: "Invalid provider" }, { status: 400, headers });
  try {
    const accounts = await getProviderProxyAccounts(provider, loadWebServerSettings().accountAliases);
    const rules = loadAccountProxies();
    return NextResponse.json({ runtimeReady: runtimeReady(), accounts: accounts.map(account => ({ ...account, proxy: accountProxyStatus(rules.find(rule => rule.provider === provider && rule.key === account.key)) })) }, { headers });
  } catch (error) {
    const unsupported = error instanceof Error && error.message === "account_proxy_runtime_required";
    return NextResponse.json({ error: unsupported ? "Build and restart the maintained OMP runtime" : "Account inventory is unavailable", code: unsupported ? "runtime_upgrade_required" : "accounts_unavailable" }, { status: unsupported ? 409 : 503, headers });
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }
  if (!isRecord(body) || typeof body.provider !== "string" || !ACCOUNT_PROXY_PROVIDER_RE.test(body.provider) ||
    typeof body.key !== "string" || !ACCOUNT_PROXY_KEY_RE.test(body.key) || typeof body.url !== "string") {
    return NextResponse.json({ error: "Invalid proxy account" }, { status: 400, headers });
  }
  const { provider, key } = body;
  const url = body.url.trim();
  try { if (url) validateAccountProxyUrl(url); } catch {
    return NextResponse.json({ error: "Use an HTTP or HTTPS proxy URL without a path, query or fragment", code: "invalid_proxy_url" }, { status: 400, headers });
  }
  try {
    if (url) {
      const accounts = await getProviderProxyAccounts(provider);
      if (!runtimeReady()) return NextResponse.json({ error: "Restart OMP sessions to enable account proxies", code: "runtime_upgrade_required" }, { status: 409, headers });
      if (!accounts.some(account => account.key === key)) return NextResponse.json({ error: "Account is no longer available", code: "account_unavailable" }, { status: 409, headers });
    }
    return NextResponse.json({ proxy: saveAccountProxy(provider, key, url) }, { headers });
  } catch (error) {
    const unsupported = error instanceof Error && error.message === "account_proxy_runtime_required";
    return NextResponse.json({ error: unsupported ? "Build and restart the maintained OMP runtime" : "Account proxy settings could not be saved", code: unsupported ? "runtime_upgrade_required" : "proxy_save_failed" }, { status: unsupported ? 409 : 503, headers });
  }
}
