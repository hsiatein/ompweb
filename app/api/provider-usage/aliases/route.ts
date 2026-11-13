import { NextResponse } from "next/server";
import { PROVIDER_ACCOUNT_ALIAS_MAX_LENGTH, PROVIDER_ACCOUNT_KEY_RE } from "@/lib/provider-usage-types";
import { isRecord } from "@/lib/type-guards";
import { loadWebServerSettings, saveWebServerSettings } from "@/lib/web-settings";

export const dynamic = "force-dynamic";

// PUT /api/provider-usage/aliases { accountKey, alias } - edit an account's
// shared nickname from Connected accounts; an empty alias clears it.
export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  const accountKey = isRecord(body) ? body.accountKey : undefined;
  const rawAlias = isRecord(body) ? body.alias : undefined;
  if (typeof accountKey !== "string" || !PROVIDER_ACCOUNT_KEY_RE.test(accountKey)) {
    return NextResponse.json({ error: "accountKey must be a provider account key", code: "invalid_account_key" }, { status: 400 });
  }
  if (typeof rawAlias !== "string" || rawAlias.trim().length > PROVIDER_ACCOUNT_ALIAS_MAX_LENGTH) {
    return NextResponse.json(
      { error: `alias must be a string of at most ${PROVIDER_ACCOUNT_ALIAS_MAX_LENGTH} characters`, code: "invalid_alias" },
      { status: 400 },
    );
  }
  const alias = rawAlias.trim();
  const accountAliases = { ...loadWebServerSettings().accountAliases };
  if (alias) accountAliases[accountKey] = alias;
  else delete accountAliases[accountKey];
  saveWebServerSettings({ accountAliases });
  return NextResponse.json({ accountKey, alias: alias || null });
}
