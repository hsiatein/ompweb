import { useCallback, useEffect, useRef, useState } from "react";
import { Puzzle, RefreshCw, RotateCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { WebPluginInfo } from "@/lib/web-plugin-types";
import { ToggleSwitch } from "./ui/field";
import { toast } from "./ui/toast";
import { SidebarIconButton } from "./SessionSidebar-chrome";

export function PluginIcon({ iconUrl, size }: { iconUrl: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  if (iconUrl && !failed) {
    // eslint-disable-next-line @next/next/no-img-element -- plugin files are served by our own route, not next/image
    return <img src={iconUrl} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ flexShrink: 0, borderRadius: 4 }} />;
  }
  return <Puzzle size={size} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />;
}

/** Sidebar body in plugin mode: the installed web plugins with their switches.
 *  Clicking an enabled plugin opens its page in the main area (AppShell). */
export function PluginsPanel({ visible, activePluginId, onOpenPlugin, onClosePlugin }: {
  visible: boolean;
  activePluginId: string | null;
  onOpenPlugin: (plugin: WebPluginInfo) => void;
  /** The open plugin was switched off or uninstalled. */
  onClosePlugin: (id: string) => void;
}) {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<WebPluginInfo[] | null>(null);
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const apply = useCallback((list: WebPluginInfo[]) => {
    setPlugins(list);
    if (activePluginId && !list.some((plugin) => plugin.id === activePluginId && plugin.enabled)) onClosePlugin(activePluginId);
  }, [activePluginId, onClosePlugin]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/web-plugins", { cache: "no-store" });
      const data = await response.json() as { root?: string; plugins?: WebPluginInfo[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? response.statusText);
      apply(data.plugins ?? []);
      setRoot(data.root ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apply]);

  useEffect(() => {
    if (!visible || loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [visible, load]);

  // Server status changes (starting → running, crashes) while the list is shown.
  const watching = visible && plugins?.some((plugin) => plugin.enabled && plugin.hasServer && plugin.status !== "running");
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [watching, load]);

  const post = async (body: Record<string, unknown>) => {
    setBusyId(body.id as string);
    try {
      const response = await fetch("/api/web-plugins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { plugins?: WebPluginInfo[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? response.statusText);
      apply(data.plugins ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: visible ? "flex" : "none", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}>
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "6px 10px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 0 4px" }}>
          <span style={{ flex: 1, color: "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {t("plugins.heading")}
          </span>
          <SidebarIconButton label={t("plugins.refresh")} onClick={() => { void load(); }}>
            <RefreshCw size={13} strokeWidth={1.9} aria-hidden="true" />
          </SidebarIconButton>
        </div>
        {error && <div role="alert" style={{ padding: "8px 4px", color: "var(--status-error)", fontSize: 12 }}>{error}</div>}
        {plugins === null && !error && <div aria-hidden="true" className="skeleton" style={{ height: 44, marginTop: 6 }} />}
        {plugins?.length === 0 && (
          <div style={{ padding: "8px 4px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
            {t("plugins.empty", { dir: root })}
          </div>
        )}
        {plugins?.map((plugin) => {
          const canOpen = plugin.enabled && plugin.status !== "invalid";
          const active = plugin.id === activePluginId;
          const problem = plugin.status === "invalid" || plugin.status === "crashed" ? plugin.error : null;
          return (
            <div
              key={plugin.id}
              className="wallpaper-inset"
              style={{
                display: "flex", alignItems: "flex-start", gap: 8, padding: 8, marginTop: 6,
                border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "var(--border)"}`,
                borderRadius: "var(--radius-card)",
                background: active ? "var(--bg-selected)" : "var(--bg)",
              }}
            >
              <button
                type="button"
                disabled={!canOpen}
                aria-current={active ? "page" : undefined}
                onClick={() => onOpenPlugin(plugin)}
                title={canOpen ? t("plugins.open") : t("plugins.enableToOpen")}
                style={{ flex: 1, minWidth: 0, display: "flex", gap: 8, alignItems: "flex-start", padding: 0, background: "none", border: "none", textAlign: "left", color: "var(--text)", cursor: canOpen ? "pointer" : "default" }}
              >
                <span style={{ paddingTop: 1 }}><PluginIcon iconUrl={plugin.iconUrl} size={18} /></span>
                <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {plugin.name}
                    {plugin.version && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 500, color: "var(--text-dim)" }}>{plugin.version}</span>}
                  </span>
                  {plugin.description && <span style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}>{plugin.description}</span>}
                  {plugin.enabled && plugin.status === "starting" && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("plugins.starting")}</span>}
                  {plugin.enabled && plugin.tools.length > 0 && plugin.status === "running" && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("plugins.tools", { tools: plugin.tools.join(", ") })}</span>
                  )}
                  {problem && <span style={{ fontSize: 11, color: "var(--status-error)", lineHeight: 1.45, wordBreak: "break-word" }}>{problem}</span>}
                </span>
              </button>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                <ToggleSwitch
                  checked={plugin.enabled}
                  disabled={busyId === plugin.id || plugin.status === "invalid"}
                  aria-label={t("plugins.enable", { name: plugin.name })}
                  onChange={(enabled) => { void post({ id: plugin.id, enabled }); }}
                />
                {plugin.enabled && plugin.hasServer && (
                  <SidebarIconButton label={t("plugins.restart")} disabled={busyId === plugin.id} onClick={() => { void post({ id: plugin.id, action: "restart" }); }}>
                    <RotateCw size={12} strokeWidth={1.9} aria-hidden="true" />
                  </SidebarIconButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
