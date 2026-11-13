import { NextResponse } from "next/server";
import { ProviderResetError, spendProviderReset } from "@/lib/provider-usage";
import { PROVIDER_ACCOUNT_KEY_RE, PROVIDER_RESET_CREDIT_ID_RE } from "@/lib/provider-usage-types";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

// POST /api/provider-usage/reset { accountKey } - spend one saved rate-limit
// reset (Codex / Claude) on that account through `omp usage reset`. omp's
// verdict comes back as { ok, message }, refusals included.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  const accountKey = isRecord(body) ? body.accountKey : undefined;
  if (typeof accountKey !== "string" || !PROVIDER_ACCOUNT_KEY_RE.test(accountKey)) {
    return NextResponse.json({ error: "accountKey must be a provider account key", code: "invalid_account_key" }, { status: 400 });
  }
  const rawCreditId = isRecord(body) ? body.creditId : undefined;
  if (rawCreditId !== undefined && (typeof rawCreditId !== "string" || !PROVIDER_RESET_CREDIT_ID_RE.test(rawCreditId))) {
    return NextResponse.json({ error: "creditId must be a valid reset credit id", code: "invalid_credit_id" }, { status: 400 });
  }
  try {
    return NextResponse.json(await spendProviderReset(accountKey, rawCreditId));
  } catch (error) {
    if (error instanceof ProviderResetError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "omp could not spend the reset", code: "reset_failed" }, { status: 502 });
  }
}
