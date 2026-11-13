# Web plugins

Optional features that live outside this repository. A plugin is a directory
in `<agent dir>/web-plugins/<id>/` (normally `~/.omp/agent/web-plugins/`); a
symlink to a checkout works. The sidebar's **Plugins** row (above Settings) lists installed
plugins with an on/off switch; clicking an enabled plugin opens its page in the
main area in place of the chat (selecting a session brings the chat back; the
page keeps its state until it is closed with ×).

`<id>` is the directory name: lowercase letters, digits and `-`, at most 40
characters.

## manifest.json

```json
{
  "id": "stock-sim",
  "name": "模拟炒股",
  "description": "One line shown in the plugin list",
  "version": "0.1.0",
  "icon": "icon.svg",
  "entry": "index.html",
  "server": "server.mjs",
  "maxRequestBytes": 8388608,
  "tools": [
    { "name": "stock_sim", "description": "…", "parameters": { "type": "object", "properties": {} } }
  ]
}
```

- `id` is optional; when present it must equal the directory name.
- `icon`, `entry` (default `index.html`) and `server` are paths inside the
  plugin directory.
- `tools` requires `server`. Tool names are `[a-z][a-z0-9_]*` and cannot replace
  omp-web's own tools (`scheduled_tasks`, `memos`, …); a taken name is skipped
  and noted in the plugin log.
- `maxRequestBytes` sets the page API request-body limit in bytes: default
  1048576 (1 MiB), maximum 67108864 (64 MiB), positive integer. For example,
  8388608 allows an 8 MiB upload. Oversized requests receive HTTP 413.

## Page

Files are served at `/api/web-plugins/<id>/files/<path>` (enabled plugins
only, confined to the plugin directory), and the main area loads `entry` from
there, so relative URLs in the page work. Include the helper first:

```html
<script src="/plugin-sdk.js"></script>
```

It copies omp-web's CSS custom properties (`--bg`, `--text`, `--accent`,
`--border`, `--radius-card`, …) as they apply at the plugin's `<iframe>` onto
the page, keeps them in sync when the theme changes, and applies the app font.
`html[data-theme]` is `light` or `dark` (from the app's color scheme);
`html[data-omp-theme]` carries the app's theme name.

Keep the page background transparent. With a wallpaper the app paints its
frosted glass behind the iframe (an iframe's own `backdrop-filter` sees only
content inside that iframe) and the SDK sets `html[data-wallpaper="on"]`
plus `data-glass` (`default`, `frosted` or `clear`, the user's glass style).
Then `--bg`/`--bg-panel` are transparent and `--bg-subtle`/`--bg-hover`/
`--bg-selected` are faint tints. In-flow page surfaces use translucent fills
(for example `color-mix(in srgb, var(--text) 5%, transparent)`) and clear glass
uses no page fills. **Overlays must cover content beneath them:** drawers,
dialogs, menus and fullscreen editors use a theme-derived solid or nearly
opaque surface in every glass mode. Derive a solid color from `--text` mixed
with a light/dark base selected by `data-theme`, then optionally add
`backdrop-filter: blur(20px)` to blur underlying plugin content. Keep native
select option surfaces solid too. Pages range from phone to desktop width.
`window.ompWeb.api(path, init)` is `fetch` against the plugin server
(`/api/web-plugins/<id>/api/<path>`).

Plugins that render untrusted HTML use `sandbox="allow-scripts"` child frames.
Such opaque-origin frames inherit the plugin page CSP, which permits inline
scripts and `blob:` script modules. The trusted plugin page loads bridge bundles
with its same-origin credentials and embeds them inline in the child document.
The host API origin guard remains active for opaque frames (including static
plugin-file requests); API reads/writes go through a validated `postMessage`
bridge implemented by the plugin.

## Server

When the plugin is switched on, omp-web runs `node <server>` (the Node that
runs omp-web) with the plugin directory as cwd and restarts it with backoff
(1 s doubling to 30 s) when it exits. Environment: the user's environment
without omp-web's own variables, plus

| Variable | Meaning |
| --- | --- |
| `OMP_WEB_PLUGIN_ID` | the plugin id |
| `OMP_WEB_PLUGIN_SOCKET` | unix socket path; serve HTTP on it (remove a stale file first) |
| `OMP_WEB_PLUGIN_DATA` | writable data directory, `<agent dir>/web-plugin-data/<id>/` |
| `OMP_WEB_HOST_SOCKET` | private HTTP Unix socket for omp's model/auth gateway (see below) |

stdout/stderr go to `<data dir>/server.log` (rotated at 1 MB). The server
must exit on SIGTERM; it is killed 3 s later otherwise. The plugin counts as
running once the socket accepts connections (15 s limit).

Requests from the page to `/api/web-plugins/<id>/api/<path>?<query>` reach
the server as `<METHOD> /<path>?<query>` with `content-type` and the body
(bounded by `maxRequestBytes`). Status and `content-type` pass through;
response bodies stream incrementally with backpressure, including SSE.
Use `response.writeHead(200, {"content-type": "text/event-stream"})`,
`response.flushHeaders()` and `response.write("data: …\\n\\n")` in a Node server.
The proxy disables caching and buffering. Closing/cancelling the page request
closes its plugin socket request; use heartbeats as needed for your clients.
`/__tools/` remains reserved for agent calls.

## Host model API

Plugin servers can use `http.request({socketPath: process.env.OMP_WEB_HOST_SOCKET,
path: "/v1/models", method: "GET"}, callback)` with Node's `node:http`.
The socket is owned by omp-web, mode 0600, in a private temporary directory.
Its lifetime follows the enabled plugin server.

- `GET /omp/models` returns the composer's catalog from the same `getWebModels`
  loader as `/api/models`: `{models, modelList, defaultModel, thinkingLevels,
  connectedProviders?, modelError?}`. `modelList` entries carry `id`, `name`,
  `provider`; default is `{provider, modelId} | null`. The registry applies
  authentication and disabled-provider policy. Thinking levels here include
  `auto` and use the composer's ordering. Send `auto` by omitting
  `reasoning_effort`, `off` as `"none"`, and other efforts verbatim on
  `/v1/chat/completions`.
- Match the composer UI with numeric, case-insensitive locale sorting by
  name, provider, id; group by provider in that order and put the current
  provider first. Search name/id/provider case-insensitively. On phones use
  provider → model navigation; desktop shows the model pane beside a provider
  rail. Same-origin pages can honor the `omp-composer-models` localStorage
  visibility list (`provider:id` keys, missing value means all).
- `GET /omp/accounts?provider=<id>&model=<id>` returns `{choices, disabled,
  disabledProviders}` using the same quota/alias source and account grouping
  as `AccountPicker`. Choices carry `provider`, opaque `accountKey`, optional
  `name`, `plan`, `usedPercent`. Keep automatic account/provider selection
  available; disabled choices remain visible and disabled.
- `/v1/*` requests may carry `x-omp-account-routing`, the base64url-encoded
  UTF-8 JSON `{pins: {[provider]: accountKey}, provider?: providerId}`.
  `provider` restricts provider routing; each pin restricts that provider's
  account. Persist this object per plugin chat. The host validates identities
  and denials through `accountRoutingSpawnArgs`, then uses a request-owned
  gateway child with both global and request policy files. Concurrent requests
  stay isolated. Response completion/disconnect stops that child and releases
  its policy after exit; global denial changes update live policy bindings.
  Invalid selections return HTTP 400. Credentials and identity records remain
  host-owned. Omit the header for automatic routing and the shared child.

- `GET /v1/models` lists models available through omp.
- `POST /v1/chat/completions` accepts the OpenAI Chat Completions JSON body,
  including omp model selectors such as `anthropic/claude-haiku-4-5` and `@role`.
- Other `/v1/*` routes and HTTP methods pass through to the gateway; bodies
  are JSON (maximum 64 MiB). Availability follows the installed omp version.
- `stream: true` delivers incremental `text/event-stream` bytes. Consume the
  HTTP response as a stream. Closing this host request cancels its upstream
  model call. Older omp versions can return the whole SSE body at completion.

Unpinned plugin requests share one lazy `omp auth-gateway stdio` child.
The gateway's stdio protocol has no per-request policy field; pinned requests
therefore use the request-owned child described above.
Concurrent unpinned requests
are multiplexed by id. A later request restarts a crashed gateway; an idle
gateway stops after ten minutes. A binary replacement takes effect on the next
request once existing requests have completed. Server shutdown stops the child.

The child inherits the user's environment and omp-web's global request policy
through `OMP_AUTH_REQUEST_POLICY_FILES`. Provider/account denials apply to every
plugin call, with credentials and model configuration managed by omp. Startup
failures return HTTP 502 JSON with the stderr tail and are recorded in the
requesting plugin's `server.log`; policy remains enforced throughout.

For backend-owned generation, retain the host request in your plugin job and
let page SSE connections subscribe to job updates independently. Explicit job
cancellation closes the host request.

## Agent tools

While the server runs, every omp session gets the manifest tools. A call
arrives as `POST /__tools/<name>` with

```json
{ "arguments": { … }, "caller": { "sessionId": "…", "cwd": "…" } }
```

Answer `200 {"text": "…"}`; the text is the tool result the agent reads. A
non-2xx answer becomes a tool error (`{"error": "…"}` supplies the message).
Calls time out after 120 s.

## Trust

A plugin page is served from omp-web's own origin and its server runs as the
user: both can do anything omp-web can (read sessions, send prompts, open
terminals). Install only plugins you wrote or trust.
