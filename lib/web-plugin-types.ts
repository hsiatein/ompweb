/** Client-safe shapes for web plugins (`<agent dir>/web-plugins/<id>`). See docs/PLUGINS.md. */

export const WEB_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `stopped`: disabled. `running`: enabled and its server (if any) answers. */
export type WebPluginStatus = "stopped" | "starting" | "running" | "crashed" | "invalid";

export interface WebPluginInfo {
  id: string;
  name: string;
  description: string;
  version: string | null;
  enabled: boolean;
  /** URL of the manifest icon, or null for the default icon. */
  iconUrl: string | null;
  /** URL of the page shown in the sidebar. */
  entryUrl: string;
  hasServer: boolean;
  /** Agent tools the plugin offers while it runs. */
  tools: string[];
  status: WebPluginStatus;
  /** Manifest problem or the server's last failure. */
  error: string | null;
}

/** URL of a file inside a plugin directory (relative paths in the page keep working). */
export function webPluginFileUrl(id: string, path: string): string {
  return `/api/web-plugins/${id}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}
