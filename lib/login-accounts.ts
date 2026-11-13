import type { ProviderUsageReport } from "./provider-usage-types";

/** An account as the login flow reports it to the browser (no raw identity). */
export interface LoginAccount {
  provider: string;
  accountKey: string;
  name?: string;
  plan?: string;
}

/** What a finished login did, from the account inventory before and after it. */
export interface LoginOutcome {
  /** Accounts that did not exist before (a second login of the same provider adds one). */
  added: LoginAccount[];
  /**
   * True when the provider reports its accounts and nothing was added: the
   * browser signed into an account omp already had, which was only refreshed.
   */
  sameAccount: boolean;
}

export function loginAccounts(reports: ProviderUsageReport[]): LoginAccount[] {
  const accounts = new Map<string, LoginAccount>();
  for (const report of reports) {
    if (accounts.has(report.accountKey)) continue;
    const name = report.accountAlias ?? report.accountLabel;
    accounts.set(report.accountKey, {
      provider: report.provider,
      accountKey: report.accountKey,
      ...(name ? { name } : {}),
      ...(report.plan ? { plan: report.plan } : {}),
    });
  }
  return [...accounts.values()];
}

export function diffLoginAccounts(before: LoginAccount[], after: LoginAccount[], provider: string): LoginOutcome {
  const known = new Set(before.map((account) => account.accountKey));
  const added = after.filter((account) => !known.has(account.accountKey));
  return { added, sameAccount: added.length === 0 && after.some((account) => account.provider === provider) };
}

/**
 * Authorization URL for adding another account. OpenAI's sign-in otherwise
 * reuses the browser's current ChatGPT session, so a second login silently
 * re-authorizes the account omp already has; `prompt=login` (standard OIDC)
 * asks to sign in again. Other providers' URLs are returned unchanged.
 */
export function addAccountAuthUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "auth.openai.com" || !parsed.pathname.startsWith("/oauth/authorize")) return url;
    parsed.searchParams.set("prompt", "login");
    return parsed.toString();
  } catch {
    return url;
  }
}
