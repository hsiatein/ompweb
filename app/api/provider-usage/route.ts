import { NextResponse } from "next/server";
import { getProviderUsage } from "@/lib/provider-usage";
import { loadWebServerSettings } from "@/lib/web-settings";
import { loadAccountRouting } from "@/lib/account-routing";

export const dynamic = "force-dynamic";

const IDENTIFIER_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

function readIdentifier(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return IDENTIFIER_RE.test(trimmed) ? trimmed : undefined;
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const rawProvider = searchParams.get("provider");
  const rawModel = searchParams.get("model");
  const provider = readIdentifier(rawProvider);
  const modelId = readIdentifier(rawModel);

  if ((rawProvider !== null && !provider) || (rawModel !== null && !modelId)) {
    return NextResponse.json(
      { error: "Invalid provider or model identifier", code: "invalid_usage_query" },
      { status: 400 },
    );
  }

  try {
    const snapshot = await getProviderUsage({ provider, modelId }, loadWebServerSettings().accountAliases);
    // Apply live permissions after the usage cache: disabling an account must
    // be visible immediately while its quota report remains useful in Settings.
    const routing = loadAccountRouting();
    const disabledProviders = new Set(routing.disabledProviders);
    const disabledAccounts = new Set(routing.disabled);
    return NextResponse.json({
      ...snapshot,
      reports: snapshot.reports.map(report => ({
        ...report,
        disabled: disabledProviders.has(report.provider) || disabledAccounts.has(report.accountKey),
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "Provider usage is currently unavailable", code: "provider_usage_unavailable" },
      { status: 502 },
    );
  }
}
