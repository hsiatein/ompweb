import { isRecord } from "../type-guards";
import type { OmpLoginProvider } from "./rpc-utility";

/**
 * Login methods that store their credentials under another provider — omp's
 * catalog `store-as` rules (packages/catalog/src/compat/rules/auth/*.kdl).
 * `get_login_providers` does not report this mapping, so it is mirrored here.
 */
const LOGIN_METHOD_STORE_AS: Readonly<Record<string, string>> = {
  "openai-codex-device": "openai-codex",
  "zai-coding-plan": "zai",
};

/** Provider id whose credentials a login with `id` creates or refreshes. */
export function credentialProviderId(id: string): string {
  return LOGIN_METHOD_STORE_AS[id] ?? id;
}

export interface LoginMethod {
  /** Provider id passed to omp's `login` command. */
  id: string;
  name: string;
}

export interface MergedLoginProvider extends OmpLoginProvider {
  /** Ways to sign in, the provider's own first; more than one when aliases were folded in. */
  loginMethods: LoginMethod[];
}

export function parseLoginProviders(value: unknown): OmpLoginProvider[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const { id, name, available, authenticated } = entry;
    if (typeof id !== "string" || typeof name !== "string" || typeof authenticated !== "boolean") return [];
    return [{ id, name, available: available !== false, authenticated }];
  });
}

/**
 * One entry per credential provider: an alias login method is folded into the
 * provider it stores credentials for (they share accounts and login state).
 * An alias whose target is absent stays its own entry.
 */
export function mergeLoginMethods(providers: OmpLoginProvider[]): MergedLoginProvider[] {
  const merged = new Map<string, MergedLoginProvider>();
  for (const provider of providers) {
    if (credentialProviderId(provider.id) !== provider.id) continue;
    merged.set(provider.id, { ...provider, loginMethods: [{ id: provider.id, name: provider.name }] });
  }
  for (const provider of providers) {
    const target = credentialProviderId(provider.id);
    if (target === provider.id) continue;
    const owner = merged.get(target);
    if (owner) owner.loginMethods.push({ id: provider.id, name: provider.name });
    else merged.set(provider.id, { ...provider, loginMethods: [{ id: provider.id, name: provider.name }] });
  }
  return [...merged.values()];
}
