import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";
import type { ProviderAccount } from "./provider-usage";
import type { AccountPins } from "./account-choices";

export interface RoutingState {
  disabled: string[];
  disabledProviders: string[];
  sessions: Record<string, AccountPins>;
  providers: Record<string, string>;
  accounts: ProviderAccount[];
}
export interface RequestPolicy {
  version: 1;
  disabledProviders?: string[];
  disabledAccounts?: Array<{ provider: string; account: ProviderAccount["identity"] }>;
  accounts?: Record<string, ProviderAccount["identity"]>;
  allowedProviders?: string[];
  error?: string;
}
export function routingStatePath(): string {
  return path.join(getAgentDir(), "omp-web-account-routing.json");
}
export function writePolicyJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}
export function globalRequestPolicyPath(): string {
  return path.join(getAgentDir(), "omp-web-request-policy.json");
}
export function globalRequestPolicy(state: RoutingState): RequestPolicy {
  const disabledAccounts: NonNullable<RequestPolicy["disabledAccounts"]> = [];
  for (const key of state.disabled) {
    const account = state.accounts.find(account => account.accountKey === key);
    if (!account) return { version: 1, error: `Disabled account ${key} requires identity resolution` };
    disabledAccounts.push({ provider: account.provider, account: account.identity });
  }
  return { version: 1, disabledProviders: state.disabledProviders, disabledAccounts };
}
export function sessionRequestPolicy(state: RoutingState, pins: AccountPins, provider?: string): RequestPolicy {
  const accounts: NonNullable<RequestPolicy["accounts"]> = Object.create(null);
  for (const [owner, key] of Object.entries(pins)) {
    const account = state.accounts.find(account => account.accountKey === key && account.provider === owner);
    if (!account) return { version: 1, error: `Selected account ${key} for ${owner} requires identity resolution` };
    accounts[owner] = account.identity;
  }
  return { version: 1, accounts, ...(provider ? { allowedProviders: [provider] } : {}) };
}
/** Every RPC process, including utility/model-test processes, inherits the global gate. */
export function ensureGlobalRequestPolicyFile(): string {
  const file = globalRequestPolicyPath();
  const stateFile = routingStatePath();
  if (!existsSync(stateFile)) writePolicyJson(file, { version: 1 });
  else {
    const raw: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!isRecord(raw) || !Array.isArray(raw.disabled) || !isRecord(raw.sessions)) throw new Error("Invalid account routing state");
    writePolicyJson(file, globalRequestPolicy({ ...raw, disabledProviders: raw.disabledProviders ?? [], accounts: raw.accounts ?? [], providers: raw.providers ?? {} } as RoutingState));
  }
  return file;
}
