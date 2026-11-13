"use client";

import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { ToggleSwitch } from "@/components/ui/field";
import { groupAccountChoices, notifyAccountRoutingChanged, type AccountChoice, type AccountRoutingView } from "@/lib/account-choices";
import type { ProviderUsageSnapshot } from "@/lib/provider-usage-types";
import type { ApiKeyProvider, OAuthProvider } from "./ModelsConfig-types";
import { ProviderIcon } from "./ModelsConfig-panels";
import { usageTone } from "./AppShell-provider-usage";

type Manage = { type: "oauth" | "apikey"; providerId: string };

/**
 * Settings → Models & Providers → Connected accounts: one card per provider with its accounts, quota and the global
 * enable switches (lib/account-routing.ts). Aliases, proxies and sign-in live behind the card's manage button.
 */
export function ConnectedProviders({ oauth, apiKey, onManage }: { oauth: OAuthProvider[]; apiKey: ApiKeyProvider[]; onManage: (target: Manage) => void }) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<Map<string, AccountChoice[]> | null>(null);
  const [extraProviders, setExtraProviders] = useState<string[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [usageResponse, routingResponse, modelsResponse] = await Promise.all([
          fetch("/api/provider-usage", { cache: "no-store", signal: controller.signal }),
          fetch("/api/account-routing", { cache: "no-store", signal: controller.signal }),
          fetch("/api/models", { cache: "no-store", signal: controller.signal }),
        ]);
        const snapshot = usageResponse.ok ? await usageResponse.json() as ProviderUsageSnapshot : null;
        if (!routingResponse.ok) throw new Error(`HTTP ${routingResponse.status}`);
        const routing = await routingResponse.json() as AccountRoutingView;
        const models = modelsResponse.ok ? await modelsResponse.json() as { modelList?: Array<{ provider: string }> } : {};
        if (controller.signal.aborted) return;
        setGroups(groupAccountChoices(snapshot?.reports ?? []));
        // Providers that only come from models.yml or are disabled still need their switch.
        setExtraProviders([...new Set([...(models.modelList ?? []).map((model) => model.provider), ...routing.disabledProviders])]);
        setDisabled(routing.disabled);
        setDisabledProviders(routing.disabledProviders);
      } catch (error) {
        if (!controller.signal.aborted) {
          setGroups(new Map());
          toast.error(t("accountRouting.loadFailed"), error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => controller.abort();
  }, [t]);

  const save = async (body: { accountKey: string; disabled: boolean } | { provider: string; disabled: boolean }) => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/account-routing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { disabled?: string[]; disabledProviders?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      // The route answers with the list it changed only.
      if (data.disabled) setDisabled(data.disabled);
      if (data.disabledProviders) setDisabledProviders(data.disabledProviders);
      notifyAccountRoutingChanged();
    } catch (error) {
      toast.error(t("accountRouting.saveFailed"), error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };

  // Signed-in OAuth first, then API keys, then providers known only from usage/models/routing.
  const names = new Map<string, string>([...oauth.map((p) => [p.id, p.name] as const), ...apiKey.map((p) => [p.id, p.displayName] as const)]);
  const manageable = new Map<string, Manage>([...apiKey.map((p) => [p.id, { type: "apikey" as const, providerId: p.id }] as const), ...oauth.map((p) => [p.id, { type: "oauth" as const, providerId: p.id }] as const)]);
  const ids = [...new Set([...oauth.map((p) => p.id), ...apiKey.map((p) => p.id), ...[...(groups?.keys() ?? []), ...extraProviders].sort()])];

  return (
    <div className="provider-cards">
      {ids.map((id) => {
        const providerOff = disabledProviders.includes(id);
        const accounts = groups?.get(id) ?? [];
        const manage = manageable.get(id);
        return (
          <section key={id} className="provider-grid-card provider-card" data-off={providerOff || undefined} aria-label={names.get(id) ?? id}>
            <div className="provider-card-head">
              <ProviderIcon id={id} size={24} />
              <span className="provider-card-name">{names.get(id) ?? id}</span>
              {names.has(id) && names.get(id) !== id && <span className="provider-card-id">{id}</span>}
              {manage && (
                <button type="button" className="provider-card-manage" title={t("modelsConfig.manageProvider")} aria-label={`${t("modelsConfig.manageProvider")} · ${names.get(id) ?? id}`} onClick={() => onManage(manage)}>
                  <Settings2 size={15} aria-hidden="true" />
                </button>
              )}
              <ToggleSwitch checked={!providerOff} disabled={saving || groups === null} aria-label={`${t("accountRouting.enabled")} · ${names.get(id) ?? id}`} onChange={(next) => void save({ provider: id, disabled: !next })} />
            </div>
            {accounts.length > 0 && (
              <ul className="provider-card-accounts">
                {accounts.map((choice, index) => {
                  const off = disabled.includes(choice.accountKey);
                  const name = choice.name ?? t("appShell.account", { number: index + 1 });
                  const used = choice.usedPercent === undefined ? undefined : Math.round(choice.usedPercent);
                  return (
                    <li key={choice.accountKey} data-off={off || undefined}>
                      <span className="provider-card-account">
                        <span className="provider-card-account-name">{name}</span>
                        {choice.plan && <span className="provider-card-account-plan">{choice.plan}</span>}
                      </span>
                      {used !== undefined && (
                        <span className="provider-card-usage" aria-label={`${used}%`}>
                          <span className="provider-card-usage-bar"><span style={{ width: `${Math.min(100, used)}%`, background: usageTone(used) === "var(--text-muted)" ? "var(--accent)" : usageTone(used) }} /></span>
                          <span style={{ color: usageTone(used) }}>{used}%</span>
                        </span>
                      )}
                      <ToggleSwitch checked={!off} disabled={saving} aria-label={`${t("accountRouting.enabled")} · ${name}`} onChange={(next) => void save({ accountKey: choice.accountKey, disabled: !next })} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
