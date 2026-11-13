import { createHash, randomUUID } from "crypto";
import { createReadStream, existsSync, readFileSync, rmSync } from "fs";
import path from "path";
import { createInterface } from "readline";
import { getAgentDir } from "./omp/paths";
import { getProviderAccounts, type ProviderAccount, type ProviderAccountIdentity } from "./provider-usage";
import { PROVIDER_ACCOUNT_KEY_RE } from "./provider-usage-types";
import { isRecord } from "./type-guards";
import type { AccountPins } from "./account-choices";
import { globalRequestPolicy, globalRequestPolicyPath, routingStatePath, sessionRequestPolicy, writePolicyJson, type RoutingState } from "./request-policy-files";

const PROVIDER_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
type Binding = { sessionId: string; pins?: AccountPins; provider?: string };
declare global {
  var __ompWebHardRouting: { path: string; state: RoutingState; bindings: Map<string, Binding> } | undefined;
}
export function sanitizeAccountPins(raw: unknown): AccountPins {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("Invalid account selection");
  const pins: AccountPins = Object.create(null);
  for (const [provider, key] of Object.entries(raw)) {
    if (!isProviderId(provider) || typeof key !== "string" || !PROVIDER_ACCOUNT_KEY_RE.test(key)) throw new Error("Invalid account selection");
    pins[provider] = key;
  }
  return pins;
}
export function isAccountRoutingSessionKey(value: unknown): value is string {
  return typeof value === "string" && SESSION_KEY_RE.test(value);
}
export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_RE.test(value);
}
export function loadAccountRouting(): RoutingState {
  const file = routingStatePath();
  if (globalThis.__ompWebHardRouting?.path === file) return globalThis.__ompWebHardRouting.state;
  let state: RoutingState = { disabled: [], disabledProviders: [], sessions: {}, providers: {}, accounts: [] };
  if (existsSync(file)) {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(raw) || !Array.isArray(raw.disabled) || !raw.disabled.every(key => typeof key === "string" && PROVIDER_ACCOUNT_KEY_RE.test(key)) || !isRecord(raw.sessions)) throw new Error("Invalid account routing state");
    const disabledProviders = raw.disabledProviders ?? [];
    const providers = raw.providers ?? {};
    const accounts = raw.accounts ?? [];
    if (!Array.isArray(disabledProviders) || !disabledProviders.every(isProviderId) || !isRecord(providers) || !Array.isArray(accounts)) throw new Error("Invalid account routing state");
    const sessions: Record<string, AccountPins> = {};
    for (const [id, pins] of Object.entries(raw.sessions)) {
      if (!isAccountRoutingSessionKey(id)) throw new Error("Invalid routing session");
      sessions[id] = sanitizeAccountPins(pins);
    }
    for (const [id, provider] of Object.entries(providers)) if (!isAccountRoutingSessionKey(id) || !isProviderId(provider)) throw new Error("Invalid provider selection");
    for (const account of accounts) {
      if (!isRecord(account) || !isProviderId(account.provider) || typeof account.accountKey !== "string" || !PROVIDER_ACCOUNT_KEY_RE.test(account.accountKey) || !isRecord(account.identity) || !Object.keys(account.identity).length || !Object.entries(account.identity).every(([key, value]) => ["accountId", "email", "orgId", "projectId"].includes(key) && typeof value === "string" && value.length > 0)) throw new Error("Invalid saved account identity");
    }
    state = { disabled: raw.disabled, disabledProviders, sessions, providers: providers as Record<string, string>, accounts: accounts as ProviderAccount[] };
  }
  globalThis.__ompWebHardRouting = { path: file, state, bindings: new Map() };
  return state;
}
function writeBinding(file: string, binding: Binding, state: RoutingState): void {
  writePolicyJson(file, sessionRequestPolicy(state, state.sessions[binding.sessionId] ?? binding.pins ?? {}, state.providers[binding.sessionId] ?? binding.provider));
}
function saveAccountRouting(state: RoutingState): RoutingState {
  writePolicyJson(routingStatePath(), state);
  writePolicyJson(globalRequestPolicyPath(), globalRequestPolicy(state));
  const runtime = globalThis.__ompWebHardRouting!;
  runtime.state = state;
  for (const [file, binding] of runtime.bindings) writeBinding(file, binding, state);
  return state;
}
/** Resolve historical opaque keys once, retaining identities of logged-out disabled accounts. */
export async function refreshRoutingAccounts(): Promise<void> {
  const accounts = await getProviderAccounts();
  const current = loadAccountRouting();
  const merged = new Map(current.accounts.map(account => [account.accountKey, account]));
  for (const account of accounts) merged.set(account.accountKey, account);
  saveAccountRouting({ ...current, accounts: [...merged.values()] });
}
function requireAccount(state: RoutingState, accountKey: string, provider?: string): ProviderAccount {
  const account = state.accounts.find(account => account.accountKey === accountKey && (!provider || account.provider === provider));
  if (!account) throw new Error("Account identity is unavailable; refresh connected accounts");
  return account;
}
export function setAccountDisabled(accountKey: string, disabled: boolean): RoutingState {
  const current = loadAccountRouting();
  if (disabled) requireAccount(current, accountKey);
  const rest = current.disabled.filter(key => key !== accountKey);
  return saveAccountRouting({ ...current, disabled: disabled ? [...rest, accountKey] : rest });
}
export function setProviderDisabled(provider: string, disabled: boolean): RoutingState {
  if (!isProviderId(provider)) throw new Error("Invalid provider");
  const current = loadAccountRouting();
  const rest = current.disabledProviders.filter(value => value !== provider);
  return saveAccountRouting({ ...current, disabledProviders: disabled ? [...rest, provider] : rest });
}
export function setSessionProviderPin(sessionId: string, provider: string | null): void {
  const current = loadAccountRouting();
  if (provider !== null && (!isProviderId(provider) || current.disabledProviders.includes(provider))) throw new Error("Selected provider is disabled or invalid");
  const providers = { ...current.providers };
  if (provider) providers[sessionId] = provider;
  else delete providers[sessionId];
  for (const binding of globalThis.__ompWebHardRouting!.bindings.values()) if (binding.sessionId === sessionId) binding.provider = undefined;
  saveAccountRouting({ ...current, providers });
}
export function setSessionAccountPin(sessionId: string, provider: string, accountKey: string | null): AccountPins {
  const pins = { ...loadAccountRouting().sessions[sessionId] };
  if (accountKey) pins[provider] = accountKey;
  else delete pins[provider];
  return setSessionAccountPins(sessionId, pins);
}
export function setSessionAccountPins(sessionId: string, pins: AccountPins): AccountPins {
  const current = loadAccountRouting();
  pins = sanitizeAccountPins(pins);
  for (const [provider, key] of Object.entries(pins)) {
    if (current.sessions[sessionId]?.[provider] === key) continue;
    requireAccount(current, key, provider);
    if (current.disabledProviders.includes(provider) || current.disabled.includes(key)) throw new Error("Selected account or provider is disabled");
  }
  saveAccountRouting({ ...current, sessions: { ...current.sessions, [sessionId]: pins } });
  return pins;
}
export function forgetSessionAccountPins(sessionId: string): void {
  const current = loadAccountRouting();
  const sessions = { ...current.sessions };
  const providers = { ...current.providers };
  delete sessions[sessionId];
  delete providers[sessionId];
  saveAccountRouting({ ...current, sessions, providers });
}
export function bindAccountRoutingPolicy(file: string, sessionId: string): void {
  const state = loadAccountRouting();
  const binding = globalThis.__ompWebHardRouting!.bindings.get(file);
  if (!binding || binding.sessionId === sessionId) return;
  const pins = state.sessions[binding.sessionId] ?? binding.pins;
  const provider = state.providers[binding.sessionId] ?? binding.provider;
  binding.sessionId = sessionId;
  binding.pins = undefined;
  binding.provider = undefined;
  saveAccountRouting({
    ...state,
    sessions: pins ? { ...state.sessions, [sessionId]: state.sessions[sessionId] ?? pins } : state.sessions,
    providers: provider ? { ...state.providers, [sessionId]: state.providers[sessionId] ?? provider } : state.providers,
  });
}
export function releaseAccountRoutingPolicy(file: string): void {
  globalThis.__ompWebHardRouting?.bindings.delete(file);
  rmSync(file, { force: true });
}
export async function accountRoutingSpawnArgs(sessionId: string, pinsOverride?: AccountPins, providerOverride?: string): Promise<{ file: string; env: Record<string, string> }> {
  let state = loadAccountRouting();
  const pins = pinsOverride ?? state.sessions[sessionId] ?? {};
  const keys = [...state.disabled, ...Object.values(pins)];
  if (keys.some(key => !state.accounts.some(account => account.accountKey === key))) {
    await refreshRoutingAccounts();
    state = loadAccountRouting();
  }
  const selectedProvider = providerOverride ?? state.providers[sessionId];
  if (selectedProvider !== undefined && (!isProviderId(selectedProvider) || state.disabledProviders.includes(selectedProvider))) throw new Error("Selected provider is disabled or invalid");
  for (const [provider, key] of Object.entries(pins)) {
    requireAccount(state, key, provider);
    if (state.disabled.includes(key) || state.disabledProviders.includes(provider)) throw new Error("Selected account or provider is disabled");
  }
  writePolicyJson(globalRequestPolicyPath(), globalRequestPolicy(state));
  const file = path.join(getAgentDir(), "omp-web-routing", `${randomUUID()}.json`);
  const binding = { sessionId, pins: pinsOverride, provider: providerOverride };
  writeBinding(file, binding, state);
  globalThis.__ompWebHardRouting!.bindings.set(file, binding);
  return { file, env: { OMP_AUTH_REQUEST_POLICY_FILES: JSON.stringify([globalRequestPolicyPath(), file]) } };
}

/** omp's `credentialPinHash` (session/credential-pin.ts): the persisted id of the account that served a turn. */
export function credentialPinHash(provider: string, identity: ProviderAccountIdentity): string | undefined {
  if (!identity.accountId && !identity.email) return undefined;
  const key = [provider, identity.accountId ?? "", identity.email ?? "", identity.orgId ?? "", identity.projectId ?? ""].join("\0");
  return createHash("sha256").update(key).digest("hex");
}

/** Accounts that served this session most recently, per provider, from its `credential_pin` entries. */
export async function servingAccounts(sessionFile: string, accounts: ProviderAccount[]): Promise<AccountPins> {
  const latest = new Map<string, string>();
  const lines = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes("\"credential_pin\"")) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry) && entry.type === "credential_pin" && typeof entry.provider === "string" && typeof entry.hash === "string") {
        latest.set(entry.provider, entry.hash);
      }
    } catch {
      // Torn trailing line while omp is writing.
    }
  }
  const serving: AccountPins = {};
  for (const account of accounts) {
    if (latest.get(account.provider) === credentialPinHash(account.provider, account.identity)) serving[account.provider] = account.accountKey;
  }
  return serving;
}
