/** The plugin page open in the right panel's plugin tab (picked from the sidebar's plugin list). */
export interface OpenPluginPage {
  id: string;
  name: string;
  entryUrl: string;
  iconUrl: string | null;
}

const STORAGE_KEY = "omp-web:open-plugin";

function isOpenPluginPage(value: unknown): value is OpenPluginPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return typeof page.id === "string" && typeof page.name === "string"
    && typeof page.entryUrl === "string" && page.entryUrl.startsWith("/api/web-plugins/")
    && (page.iconUrl === null || typeof page.iconUrl === "string");
}

export function readOpenPluginPage(): OpenPluginPage | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return isOpenPluginPage(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeOpenPluginPage(value: OpenPluginPage | null): void {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable */ }
}

/** The plugin page itself; remounts when `frameKey` changes (reload). */
export function PluginFrame({ plugin, frameKey }: { plugin: OpenPluginPage; frameKey: number }) {
  return (
    <iframe
      key={`${plugin.id}:${frameKey}`}
      src={plugin.entryUrl}
      title={plugin.name}
      style={{ flex: 1, minHeight: 0, width: "100%", border: "none", background: "transparent" }}
    />
  );
}
