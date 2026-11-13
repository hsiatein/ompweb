# omp-web - Development Notes

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

If a local `docs/DEV-WORKFLOW.md` exists (machine-specific, not tracked), follow it
(Node runtime path, dev server command, browser smoke checks).

---

## Architecture

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/events ──────▶ page-wide SSE (running, sudo, host tools)│
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).
- `login-providers.ts` — `get_login_providers` parsing; folds alias login
  methods into the provider they store credentials for (`openai-codex-device`
  → `openai-codex`, `zai-coding-plan` → `zai`). omp's RPC does not report
  `storeCredentialsAs`, so the table mirrors the catalog `store-as` rules;
  update it when omp adds one.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId?, accountPins?, providerPin? }
  account-routing/route.ts        GET ?sessionId= {disabled,disabledProviders,providerPin,pins,serving} | PUT global disables / strict session selections
  provider-usage/route.ts         GET ?provider=&model= usage snapshot (`omp usage --json`, 60 s cache)
  provider-usage/reset/route.ts   POST {accountKey, creditId?} spend one saved Codex/Claude rate-limit reset → {ok, message}
  agent/[id]/route.ts             GET state | POST any RPC command
  agent/[id]/events/route.ts      GET SSE stream
  events/route.ts                 GET page-wide SSE: running ids + "needs you" dialogs, session-list hints, sudo requests, cross-session host tools
  auth/**                         provider list, login (?mode=add: another account; success reports added accounts), API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  github-repo/route.ts            GET ?cwd= — GitHub owner/repo of the checkout (for #N links)
  home/route.ts                   GET user home directory
  uploads/route.ts                POST ?name= raw body: store one non-inlinable chat attachment (lib/chat-uploads.ts) → {name, path, size}
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  agent-model-overrides/route.ts  GET {overrides} | PUT {agent, model|null}: omp task.agentModelOverrides, one agent per write
  models-config/test/route.ts     POST test a configured model/provider
  omp-settings/route.ts           GET/PUT native config.yml settings (allow-listed)
  web-settings/route.ts           GET/PUT omp-web's own server settings (auto-resume)
  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  terminals/route.ts              GET {available, terminals} | POST start a shell (cwd, cols, rows)
  terminals/[id]/route.ts         POST {input} | {cols, rows} | DELETE close
  terminals/[id]/events/route.ts  GET SSE: scrollback replay, then output/exit
  system/route.ts                 GET dashboard snapshot | PUT {memoryGuard} | POST {stopPid} (agent/terminal trees only)
  worktrees/route.ts              GET/POST/DELETE git worktrees
  scheduled-tasks/route.ts        GET list (+ server timeZone) | POST create a scheduled task
  scheduled-tasks/[id]/route.ts   PATCH edit / {enabled} / {action:"run"} | DELETE
  hooks/[token]/route.ts          POST run a webhook-triggered scheduled task (token = credential, bypasses password)
  favorite-directories/route.ts   GET/PUT directory picker favorites (omp-web-settings.json)
  web-plugins/route.ts            GET {root, plugins} | POST {id, enabled} / {id, action:"restart"}
  web-plugins/[id]/files/[...path]/route.ts  GET static file of an enabled plugin (confined to its dir)
  web-plugins/[id]/api/[...path]/route.ts    streaming HTTP → plugin socket, abort propagation, manifest body limit (excludes /__tools)

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  uploaded-files.ts    client-safe: upload a chat attachment + the `<file name path size>` prompt reference (mirrored by ompnative src/attachments.ts)
  chat-uploads.ts      server: `<agent dir>/uploads/<date>/<random>/<name>` store, 30-day pruning
  account-routing.ts   server: live global provider/account denials + strict per-session pins
  request-policy-files.ts  atomic native request-policy JSON files and process environment
  account-choices.ts   client-safe account grouping (usage reports → one choice per account)
  login-accounts.ts    client-safe login outcome diff (added / same account) + add-account auth URL (OpenAI prompt=login)
  attention.ts         client-safe "needs you" item type + dialog title helpers
  app-events.ts        client: the page's one shared EventSource on /api/events (snapshot replay for late subscribers)
  context-menu.ts      client-safe right-click menu core: contributions, native-menu rules, quoteMarkdown
  terminal-request.ts  "open in built-in terminal" window event (requestTerminalAt → AppShell → TerminalPanel)
  native-terminal-prefs.ts  client-safe: "Copy terminal command" mode/SSH host (localStorage) + command builder
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  github-refs.ts       remark plugin linking #N / owner/repo#N + GithubRepoContext
  text-links.ts        client-safe URL/path detection in plain text (prose, whole inline code, tool output) + `~` expansion
  remark-text-links.ts remark plugin: link detected paths/URLs (`data-text-link`), trim GFM autolinks at CJK text
  home-dir.ts          client: `useHomeDir()` — server home dir from /api/home, fetched once per page
  github-repo.ts       server: pick the gh-default GitHub remote from git config
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  rpc-manager.ts       session registry + startRpcSession over RpcProcess
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  session-resume.ts    running-session list for auto-resume after a restart
  scheduled-messages.ts  server-sent "Send later" messages into an existing session
  scheduled-tasks.ts   standalone scheduled tasks (new session per run, retention)
  webhook-listeners.ts server: per-interface webhook listeners (bind/reconcile, POST /hooks/<token>)
  schedule-recurrence.ts  client-safe repeat rules + next-run computation
  session-archive.ts   archive one session (stop child, gc layout, cache flush)
  web-settings.ts      omp-web server settings (~/.omp/agent/omp-web-settings.json)
  web-plugins.ts       server: web plugin discovery, server supervisor, socket proxy, plugin agent tools
  web-plugin-host.ts   server: private per-plugin Host API sockets + global-policy gateway environment
  web-plugin-gateway.ts server: shared lazy auth-gateway child, NDJSON demux, streaming/cancel/idle lifecycle
  web-plugin-types.ts  client-safe plugin shapes + id rule
  skills-service.ts    pure-Node skill discovery mirroring omp's providers
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getToolNamesForPreset()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  word-prediction.ts   pure ghost-text arithmetic (advance/accept) for composer word prediction
  terminal-manager.ts  server: PTY shells via optional node-pty (globalThis registry, scrollback)
  system-stats.ts      /proc readers (meminfo, stat, process table, descendants) + preferForOomKill
  status-board.ts      server: status board store (items per session, push tokens, debounced save, coalesced notify)
  status-board-blocks.ts  rich item blocks: validation, shorthands, limits
  status-board-layout.ts  client-safe board layout rules (ordering, progress rate/ETA, staleness)
  agent-status-tool.ts server host tool `status_board` (set/remove/clear/list/endpoint for the calling session)
  memory-guard.ts      server: low-memory guard (kills largest agent/terminal command) + dashboard snapshot
  memory-guard-settings.ts / system-monitor-types.ts  client-safe guard settings + /api/system shapes
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  AccountPicker.tsx   composer chip: Auto or strict per-chat provider/account selections
  ConnectedProviders.tsx  Settings → Models & Providers → Connected accounts: one card per provider with usage + provider/account enable switches
  AttentionCenter.tsx sidebar bell listing pending dialogs/sudo prompts; click jumps to the session
  ComposerPanels.tsx  composer-attached todo + subagent panels (collapsible, live states)
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  TextLink.tsx        selectable text that opens on click (delayed single click; double click selects); LinkifiedText.tsx for tool output
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       MCP inventory + project editor (Settings → Extensions & Skills)
  SkillsConfig.tsx    loaded/search/installable skills (Settings → Extensions & Skills)
  ScheduledTasksPanel.tsx  scheduled tasks window (task list, detail/editor, recent runs)
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab (text, image, audio/video, PDF/DOCX; binary → download)
  FilePreviews.tsx    CSV/TSV table and Jupyter notebook previews (lib/delimited.ts, lib/notebook.ts)
  GhostMirror.tsx     textarea overlay painting ghost-text word completion
  TabBar.tsx          right-panel tab bar (Explorer, Git, Terminal + open file tabs)
  TerminalPanel.tsx   right-panel Terminal tab: shell tabs + xterm.js view (Ctrl+` toggles)
  SystemPanel.tsx     right-panel System tab: memory/CPU gauges, per-session usage, memory guard
  StatusBoardPanel.tsx right-panel Status tab: per-session status items (progress, metrics, notes)
  StatusBlocks.tsx    status item blocks: markdown, key/values, tables, sub-bars, charts, code
  PluginsPanel.tsx    sidebar plugin mode: plugin list with switches (opening adds a right-panel tab)
  PluginPage.tsx      right-panel plugin tab: open-plugin state (localStorage) + iframe
  ui/                 shared primitives: Dialog/Tooltip/InfoHint/Collapsible, fields (ToggleSwitch, TagInput), toast, ContextMenuHost

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts              completion sound + browser AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state (localStorage key "omp-theme")
  useWordPrediction.ts     debounced omp predict_word ghost text + feedback
```

---

## Key Design Decisions & Traps

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.

### sudo password prompts (`lib/askpass.ts`, `lib/askpass-peer.ts`, `bin/askpass/`)
- Linux only. `prepareAskpassSpawn()` gives every omp child a token and env:
  `bin/askpass` first on PATH (its `sudo` adds `-A` unless the call picks
  `-A`/`-S`/`-n`), `SUDO_ASKPASS=bin/askpass/omp-web-askpass` (→
  `askpass-client.cjs`), and the URL of a loopback-only HTTP server started
  inside the Next process (not a Next route: it needs the TCP peer port).
- `verifyAskpassPeer()` maps the connection through /proc to the client pid
  and requires: node running exactly the client script, no NODE_OPTIONS, a
  root (euid 0) parent named `sudo`, stdout an anonymous pipe held by no other
  same-user process. The dialog shows that sudo's real cmdline.
- Browser side: `askpass_requests` frames on `/api/events` (pending list
  only, never passwords) and `/api/askpass/answer`; `hooks/useAskpassRequests.ts`
  (in AppShell) feeds `components/AskpassDialog.tsx` (a floating, non-modal
  card in the top-right corner: no overlay, no focus grab, Escape folds it,
  refusing is an explicit button) and the attention bell, whose password
  entries focus that card instead of switching chats. No listening tab → refused immediately; 240 s timeout (omp's bash
  tool times out at 300 s). Never log or persist a password.
- Settings → System & Updates → "Answer sudo automatically"
  (`/api/askpass/auto`, `setAskpassAuto()`): turning it on verifies the
  password with the real sudo (`-S -k -p '' -- true`, password on stdin
  only) and keeps it in `__ompAskpass.autoPassword` — memory only, so a
  restart turns it off. While on, verified prompts are answered at once
  without a dialog (prompts already waiting too), and the server log records
  the session and command, never the password. Off clears it.
- A determined same-user agent can still race the pipe or edit the client
  file; the checks block trivial phishing, not everything.

### Integrated terminal (`lib/terminal-manager.ts`, `components/TerminalPanel.tsx`)
- Shells run on PTYs from `node-pty` (an `optionalDependency`, loaded with a
  runtime `require` and listed in `serverExternalPackages`). Linux builds it
  from source at install, so a missing toolchain only disables the feature:
  `GET /api/terminals` reports `available: false` and the tab says why.
- Terminals belong to the server, not a tab: they survive reloads, are shared
  by every open tab, and stay until closed (or the server stops); at most 8.
  A view attaching gets the last 512 KiB of output replayed, then live output
  (coalesced per 8 ms). The terminal env drops omp-web's own variables
  (`OMP_WEB_*` incl. the password, `PORT`, `NODE_ENV`, Next internals). It adds
  `OMP_ACCOUNT_PROXY_FILE`, so `omp` run there keeps per-account proxies.
- No WebSocket (route handlers cannot upgrade): output is SSE, keystrokes are
  POSTs chained in order and batched per microtask. Only the visible
  terminal holds an SSE connection, to stay within the browser's per-host
  HTTP/1.1 connection limit alongside the other streams.
- Same trust level as the agents' bash: anyone who can use omp-web gets a shell.

### Right-click menu (`lib/context-menu.ts`, `components/ui/context-menu.tsx`)
- One `ContextMenuHost` (base-ui `Menu`, non-modal, anchored to the pointer)
  is mounted in AppShell. Components never open it themselves: their
  `onContextMenu` calls `contributeContextMenu(event, section)` and lets the
  event bubble, so nested targets stack (code block, then message). The host
  listens on `window` (after React's root listener), so all contributions are
  in when it decides. Item closures are captured at right-click time; act on
  the clicked thing by id, never on "the active" state (see the file-tab
  handlers in AppShell, which take a tab id).
- Order: selection (Copy / Quote in reply) → contributions innermost first →
  the AppShell app section only when nothing else applied and the target is
  not in a dialog. No items at all means the browser menu.
- The browser menu is kept for Shift+right-click, touch long-press, text
  fields/contenteditable, media, `http(s)`/`mailto` links, and anything under
  `[data-native-context-menu]` (the terminal screen). Mark new surfaces that
  need the browser menu with that attribute.
- "Open in built-in terminal" is a `window` event (`lib/terminal-request.ts`);
  AppShell opens the Terminal tab and `TerminalPanel` starts a shell in that cwd.
- "Copy terminal command" (workspace rows, `components/native-terminal-action.ts`):
  omp-web never launches terminal apps (a page cannot start programs on the
  browser's computer). It copies `cd <dir>` (Auto when the page URL is
  loopback, or mode `local`) or `ssh -t <host> 'cd <dir> && exec "$SHELL" -l'`
  (mode `ssh`, or Auto from another computer) with the per-device SSH host
  from Settings → Interaction behavior → Terminal command.
- Copy actions use `copyFromContextMenu` (toast feedback: the menu is gone).

### Web plugins (`lib/web-plugins.ts`, `components/PluginsPanel.tsx`, docs/PLUGINS.md)
- Optional features kept out of this repo: `<agent dir>/web-plugins/<id>/`
  (symlinks allowed) with `manifest.json`, static pages and an optional
  `server`. docs/PLUGINS.md is the contract for plugin authors — update it
  with any change here.
- On/off state is `enabledPlugins` in omp-web-settings.json. Enabled servers
  start from `instrumentation.node.ts` and on enable: `node <server>` from
  `process.execPath`, cwd = plugin dir, env = `userEnv()` (omp-web's own vars
  stripped) + `OMP_WEB_PLUGIN_{ID,SOCKET,DATA}` and `OMP_WEB_HOST_SOCKET`, oom_score_adj 800, logs in
  `<agent dir>/web-plugin-data/<id>/server.log`. Runtimes live on a globalThis
  map with a generation counter so stale exits/timers are ignored; crashes
  restart with 1 s → 30 s backoff.
- Manifest tools become server host tools (`registerServerHostTool`) once
  the socket accepts connections and are removed on exit/disable;
  `refreshServerHostTools()` re-sends `set_host_tools` (browser tools kept per
  wrapper in `browserHostTools`) to every live child. A plugin can never
  replace an existing server tool name.
- Page responses stream through `Readable.toWeb`; keep the request AbortSignal
  attached through response close. Body limits use manifest `maxRequestBytes`
  (1 MiB default, 64 MiB cap). Tool calls remain buffered.
- Host sockets are private per plugin and multiplex through one globalThis
  `omp auth-gateway stdio` child. Always pass the global request-policy file
  and `accountProxyEnvironment()` (per-account proxies);
  startup errors include stderr in HTTP 502 and the plugin log. Fingerprint
  changes restart an idle child; existing generations finish first. Host HTTP
  disconnects send cancel by id. Legacy single-envelope responses remain valid.
- Composer catalog loading lives in `lib/web-models.ts`, shared by `/api/models`
  and host `/omp/models`; the host adds selectable thinking-level ordering.
  `/omp/accounts` reuses provider usage, aliases and account grouping.
  Base64url JSON in `x-omp-account-routing` selects strict account/provider
  routing through `accountRoutingSpawnArgs`. Each pinned request owns a gateway
  child; keep global policy enforcement and release the binding only after
  shutdown completes. Unpinned requests retain the shared child.
- Plugin page backgrounds stay transparent; drawers/dialogs/menus/fullscreen
  editors need theme-derived near-opaque surfaces even with clear wallpaper
  glass. Iframe blur can blur underlying plugin content.
- The sidebar footer's **Plugins** row (above Settings) switches the sidebar body to
  `PluginsPanel` (mode in localStorage; the workspace list is hidden with
  `display: none`, not unmounted). Clicking a plugin opens it as a closable
  right-panel tab after System (`rightView === "plugin"`, `openPlugin` in
  AppShell, persisted as `omp-web:open-plugin`); the chat always stays the
  chat. The iframe stays mounted while other tabs are shown; × on the tab
  closes it; switching the plugin off closes it too. Collapse the chat to
  give the tab the whole width.
- `public/plugin-sdk.js` mirrors the app's CSS variables/`data-theme`/font
  into the same-origin iframe. Same origin means a plugin has omp-web's full
  power: plugins are trusted code, like the terminal.

### Collapsible chat pane (`components/AppShell.tsx`)
- Desktop (≥ 960 px) only: « in the top bar opens the right panel and sets
  `chatCollapsed` (not persisted). `<main>` is `display: none` (still mounted),
  the sidebar keeps its width, and the right panel gets `right-panel-fill`
  (flex: 1, no resize handle). A 28 px rail (`chat-collapsed-rail`) between
  them brings the chat back; so do selecting a session, starting a new chat
  or closing the right panel.

### Status board (`lib/status-board.ts`, `components/StatusBoardPanel.tsx`)
- Agents publish status items for THEIR session with the `status_board` server
  host tool (session id from the RPC wrapper, never from arguments); programs
  they start push with `POST /api/status/<token>` (one secret 43-char token per
  session, created by the tool's `endpoint` action, persisted; `proxy.ts` lets
  exactly that path past the password/origin checks, like `/api/hooks`).
- Callers only describe items (`id`, `title`, `value`, `max`, `unit`,
  `detail`, `state`, `kind` inferred, `blocks`); updates merge and a progress
  item at `max` turns done. `blocks` is rich content validated and normalized
  by `lib/status-board-blocks.ts` (markdown, kv, table, progress, chart, code;
  YAML-friendly shorthands; 20 blocks / 48 KiB per item) and rendered by
  `components/StatusBlocks.tsx`. A list replaces the old one, null clears.
- Updates may be JSON or YAML: `parseStatusDocument()` (JSON first, then
  YAML) serves both the push route (256 KiB body; the token is checked before
  parsing) and the tool's `document` argument. The board owns layout: `lib/status-board-layout.ts`
  (open chat first, live sessions next; failed → running → paused → notes →
  done; rate/ETA from a 10-minute history window; stale after 10 min).
  History keeps one sample per 2 s, 120 max; a counter going backwards resets it.
- Store: `omp-web-status-board.json` in the agent dir (mode 600, debounced
  save). Finished items expire after 24 h, any item after 7 days idle; 30
  items per session, requests all-or-nothing.
- Live updates ride `/api/events` as `status_board` snapshot frames
  (coalesced 250 ms, replayed to late subscribers). The panel is always
  mounted to keep the tab badge (live count, red dot on failures) current and
  renders only while shown.

### Memory guard (`lib/memory-guard.ts`, `components/SystemPanel.tsx`)
- Started from `instrumentation.node.ts` (globalThis state, Linux only); polls
  `/proc/meminfo` every 500 ms. Below `memoryGuard.killBelowPercent` of RAM
  free (omp-web-settings.json) it SIGTERMs the largest process (≥ 64 MiB)
  descended from an omp process or a terminal shell (`pickVictim`), then
  SIGKILLs it after 1.5 s or at once below half the line; an omp process
  itself only when none of its commands qualifies. Never the server, never
  anything outside those trees.
- Notification goes through the wrapper (`memoryGuardKilled`: chat `notice`,
  plus a `steer` to the agent when the run is active) or `noticeTerminal`.
  Read the victim's cmdline before signaling (it vanishes on exit).
- `RpcProcess` and terminal shells set `oom_score_adj` 800 at spawn
  (inherited by every command they run), so the kernel OOM killer prefers
  agent work over the server. The service unit needs `OOMPolicy=continue`
  (generated unit sets it); with systemd's default `stop`, one OOM-killed
  agent command stops the whole service.

### "Needs you" attention bell (`lib/attention.ts`, `components/AttentionCenter.tsx`)
- Session items are the wrapper's `pendingUiRequests` (select/confirm/input/
  editor/ask/open_url; `attentionItems()`), aggregated by `getAttentionItems()`
  and carried as `attention` on every `running` frame of `/api/events`.
  `notifyRunningChange()` includes them in its dedupe snapshot, so every path
  that adds or drops a pending dialog (new request, `cancel`, the browser's
  `extension_ui_response`, timeout expiry, destroy) must reach a
  `notifyRunningChange()` call.
- The sidebar (the only running-stream subscriber) reports items up via
  `onAttentionChange`; AppShell merges them with sudo prompts, renders the
  bell in the sidebar header (`headerAccessory`), prefixes the tab title with
  the count, dots the sidebar toggle while the sidebar is closed, and sends an
  OS notification for new items while the tab is hidden (only if permission
  was already granted). Clicking an item selects its session, where the
  dialog is replayed above the composer.

### Scheduled messages (`lib/scheduled-messages.ts`, `/api/sessions/[id]/scheduled`)
- Sent by the server, not the tab: entries live in
  `omp-web-scheduled-messages.json` in the agent dir (mode 600) with one timer
  each on a `globalThis` registry; startup (`instrumentation.node.ts`) and the
  first API call re-arm them, and overdue ones fire immediately.
- Delivery is `deliverScheduledMessage()` in `lib/rpc-manager.ts`: starts the
  session's omp if needed, sends `prompt` when idle and `follow_up` when a run
  is in progress. A failure keeps the entry with `error` (no automatic retry);
  PATCH with a new `sendAt` reschedules and clears it ("Send now"/"Retry").
- Two omp-web servers on one agent dir would both fire the same messages.

### Scheduled tasks (`lib/scheduled-tasks.ts`, `/api/scheduled-tasks`, `components/ScheduledTasksPanel.tsx`)
- Recurring prompts with two targets. New-session tasks call
  `spawnNewSession()` (shared with `/api/agent/new`) in the task's cwd, send
  the prompt, and name the session `<task name> · <YYYY-MM-DD HH:MM>`; every
  run is an ordinary session, kept on purpose so its transcript stays.
  Session tasks (`targetSessionId`) deliver through `deliverScheduledMessage()`
  into that existing session; model/thinking/keepRuns/maxRun do not apply and
  `cwd` is copied from the session header for display only.
- Store: `omp-web-scheduled-tasks.json` in the agent dir (mode 600), one timer
  per task on a `globalThis` registry, re-armed at startup. Repeat rules
  (`lib/schedule-recurrence.ts`, client-safe): once / interval / daily /
  weekly / webhook, wall-clock times in the SERVER's time zone. A scheduled fire
  advances `nextRunAt` before starting, so a crash never repeats a run; runs
  missed while down collapse into one catch-up run.
- Busy sessions do not skip triggers. Session tasks reuse
  `deliverScheduledMessage()`: `prompt` while idle, `follow_up` while busy,
  with OMP's existing queue lifecycle and delivery mode (no separate scheduler
  queue). New-session tasks always start independently, even if a prior run
  is still starting or working. A `started` run record means delivery was
  accepted, not that a queued prompt has finished.
  `maxRunMinutes` arms an in-memory watchdog that sends `abort` (lost on
  restart; new-session runs only). Pending dialogs of a run reach the user
  through the attention bell like any session.
- Retention (new-session tasks only — session tasks share the user's session
  and must never archive it): run sessions beyond `keepRuns` are archived
  through `archiveSession()` (`lib/session-archive.ts`, shared with the
  archive route), skipping running ones and ones with forked children.
- Webhook trigger (`repeat.kind === "webhook"`, no schedule): the task gets a
  `webhookToken` (32 random bytes, base64url) and runs on
  `POST /api/hooks/<token>`. `proxy.ts` lets exactly that path past the
  password and origin checks — the token is the only credential, compared in
  constant time in `triggerScheduledTaskWebhook()`. Unknown/malformed tokens
  and non-webhook tasks all answer 404; paused tasks 409. The token survives
  edits, rotates via PATCH `{action:"regenerate-webhook"}`, and is dropped when
  the task leaves webhook mode. With `webhookIncludeBody` the request body
  (read with `readTextWithinLimit`, cut to 16k chars) is appended inside
  `<webhook-body>` and labelled as external data; otherwise it is ignored.
- Webhook listen (`webhookListen: {interfaces, port}`, `lib/webhook-listeners.ts`):
  instead of omp-web's own route, the URL works only on a dedicated plain-HTTP
  listener bound to the chosen interfaces' current addresses (IPv6 link-local
  skipped) on that port, path `POST /hooks/<token>` (nothing else is served).
  `triggerScheduledTaskWebhook(token, payload, via)` checks the arrival
  binding: such a task answers 404 on `/api/hooks/<token>`, and a server-route
  task answers 404 on any listener. `syncWebhookListeners()` reconciles the
  globalThis listener set after create/update/delete and every 30 s
  (interfaces coming up, address changes); bind errors (`EADDRINUSE`, ...) show
  per endpoint in `webhookEndpoints` of the task view. A stored, malformed
  `webhookListen` drops the token instead of widening where it works.
- Agent-created tasks (`lib/agent-task-tool.ts`, tool `scheduled_tasks`:
  create / list / cancel). Always target the CALLING session — the id comes
  from the RPC wrapper, never from tool arguments — so an agent can only
  message itself. Marked `createdByAgent`, at most
  `MAX_AGENT_TASKS_PER_SESSION` per session. `webhook` and `once` are
  `oneShot`: a one-shot URL is spent by its first call (token dropped before
  the run starts) and the task is deleted once delivered (kept, without a
  token, when delivery failed so the error shows). Agent webhooks always
  include the body and carry `expiresAt` (unused URLs are deleted then).
  The returned URL is `localServerUrl()` (OMP_WEB_HOSTNAME/OMP_WEB_PORT set by
  the launcher; a dev server needs `OMP_WEB_PORT` or the URL points at 30177).
  With `listenInterfaces` (+ optional `listenPort`, default 30179) the agent's
  webhook gets a dedicated listener instead (same `webhookListen` rules); the
  tool waits 300 ms for the bind and returns the listening URLs plus any
  interface without an address or bind error. `list` also prints the
  server's interfaces with their addresses.
  The description's FIRST LINE is all a session sees in its tool list (omp
  shows plugin tools as `xd://` devices, summary capped at 200 bytes; the rest
  only after reading the device), so it must name every capability.
- Server host tools (`registerServerHostTool` in `lib/rpc-manager.ts`): tools
  omp-web answers itself, with no browser. Registered on a `globalThis` map
  at startup (`instrumentation.node.ts` imports `lib/agent-task-tool.ts` and
  `lib/agent-memo-tool.ts`, the read-only `memos` tool: list / search / read
  of `web-memos.json`, no writes),
  sent with `set_host_tools` when each child initializes, and merged into
  every browser `set_host_tools` because omp replaces the whole tool set.
  A browser tool cannot shadow a server tool name.
- UI: a memo-style window (`ScheduledTasksPanel`, mounted once in AppShell),
  opened by the sidebar header's calendar button through the
  `lib/scheduled-tasks-ui.ts` window event. The one-shot composer "Send later"
  stays separate (`lib/scheduled-messages.ts`).

### Auto-resume after a restart (`lib/session-resume.ts`)
- Off by default (`autoResumeSessions` in `omp-web-settings.json`). When on,
  `notifyRunningChange()` keeps `omp-web-interrupted-sessions.json` in the
  agent dir listing sessions that are mid-run; startup
  (`instrumentation.node.ts`) consumes it, restarts each session and sends
  `RESUME_PROMPT`.
- A service stop signals every process at once, so an omp child can die
  before omp-web's own SIGTERM handler runs. A session whose process died
  therefore stays listed for `EXIT_GRACE_MS`; the shutdown handler freezes the
  list (`markShuttingDown`) so those deaths count as interrupted, while a
  crash with omp-web still up is dropped after the window.
- Only session ids are stored; paths are re-resolved on resume.
- Known limit: resume does not detect a terminal `omp --resume <id>` started
  on the same session while omp-web was down; both would write the file.
- Production only (`NODE_ENV === "production"`): a `next dev` server on the
  same agent dir neither claims nor writes the list. The list it would find is
  the live service's, and resuming those sessions in a second omp makes omp
  fork each locked session into a duplicate that keeps running.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Live tool execution (`tool_execution_start/update/end`)
omp announces a tool the moment it starts, streams the tool's output while it
runs, and only commits the `toolResult` message at the end. The UI must not
wait for that commit:
- `useAgentSession` keeps a `liveToolResults` map keyed by `toolCallId`
  (seeded on `tool_execution_start` with `partial: true`, refreshed on
  `tool_execution_update` — omp sends the FULL accumulated partial result per
  chunk, latest wins — and released on `_end`/the committed toolResult).
  Committed results always win over live entries (`ChatWindow` merges them), so
  a reload never shows a stale snapshot.
- `ToolCallBlock` renders a `partial` result as **running** (spinner, and
  "Running tool…" instead of the "(no output)" marker when nothing has been
  printed yet), and opens the row while it runs when the "Keep tool calls
  collapsed" setting is off — that is what that setting means. `AppShell` must
  pass `toolCallsDefaultCollapsed` into `ChatWindow`; without it the setting is
  inert (the chat then always collapses).
- `tool_execution_update` is coalesced per tool call at display rate in
  `lib/message-update-coalescer.ts` (chatty commands emit ~10-100+ frames/s).
  `message_end` drops the pending `message_update` (the committed message
  supersedes it) but must NOT drop buffered tool updates.
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `queue_update` /
`compaction_start` / `compaction_end` events. Completion is `agent_end`
(`isTerminal !== false`), errors surface as failed RPC responses plus `notice`
events, and the queue length comes from `get_state.queuedMessageCount`.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Running state SSE + reconciliation
- The sidebar listens to `running` / `sessions-changed` frames on `/api/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling. `running` frames also carry `subagentSessions` (`{id, count}` of subagents a session's child reported `started` and not yet finished, from `subagent_lifecycle` payloads): background subagents outlive the main run, which `isRunning()` alone does not show.
- Each tab holds ONE page-wide stream (`lib/app-events.ts`: shared EventSource, latest `running`/`askpass_requests` snapshot replayed to late subscribers). Browsers allow six HTTP/1.1 connections per host and SSE holds them; a new always-on feature must add a frame type to `/api/events`, not its own EventSource, or ordinary requests (the session list) queue behind open streams.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Composer-attached panels (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`) and the subagent roster live **pinned above
  the chat input**, not inside the scrollable message list. `ComposerPanels`
  renders both, each independently collapsible via its header row (`chevron`);
  panels start collapsed (headers always show live progress / running-summary).
  Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. Running chips come
  first; finished ones (anything not `started` in a live process, all history
  rows) sit in a nested **Finished · N** group, newest first, folded by
  default (`omp-web:composer-finished-subagents-collapsed`). `TodoList` keeps a
  non-collapsible default (`collapsible` prop) for SSR tests.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. `subagent_event`
  frames also feed a bounded per-subagent activity buffer shown in the
  transcript dialog.
- **Roster hydration**: `get_subagents` snapshots (which carry progress)
  rehydrate the roster after SSE reconnect (`refreshSubagentRoster`, wired
  into mount, send, and the reconcile poll). Terminal subagents vanish from
  the RPC registry — history fills that gap.
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots. omp-web recovers
  the roster from disk (`extractSubagentHistory`, result fields win over the
  mid-run snapshot), so past/finished runs show in the composer panel after a
  reload. The transcript route pages the sibling file byte-wise (mirroring
  `get_subagent_messages`, which is RPC-registry-gated and refuses files it
  doesn't know). The dialog reads only the final output — `<id>.md` via
  `?mode=completion` (bounded tail read that also works for transcripts
  beyond the 16MB paging cap) with a live `get_subagents` snapshot fallback
  for header enrichment; it never pages the raw transcript. Subagent ids are
  `[A-Za-z0-9_-]{1,80}` — the route validates before joining to confine reads
  to the sibling dir.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists **managed projects**: explicitly added directories (registered in
  `~/.omp/agent/projects.json`, written atomically as temp-file + rename) plus
  session-discovered ones — hidden entries excluded. Removing a project only
  marks it hidden (reversible via re-adding); hidden entries suppress session
  re-discovery.
- Registry paths are canonical `projectRoot`s: `POST` resolves worktrees to
  their main repo via `resolveProject`, and `resolveProject` returns the
  symlink-free on-disk form for plain directories so registered and
  session-discovered paths compare equal on Windows casing.
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` —
  the in-memory browse allowlist does not survive restarts, and empty managed
  projects derive no root from sessions.
- The client sorts the merged list pinned-first, then by manual `sortOrder`,
  then most-recently-added (registration order), then by path for
  session-discovered projects (`lib/project-ordering.ts`); the order
  deliberately does NOT depend on session activity, so project rows never
  jump around while sessions refresh. Pinned projects render under a
  **Pinned** section label. Drag-reorder and pin/unpin go through
  `moveManagedProject` (the moved project adopts its drop target's section)
  and persist the whole list as ONE batched `PATCH /api/projects`
  (`sortOrder` + `pinned` per entry), applied optimistically first. The drag
  source lives in a ref; the re-rendering drag state is deferred one frame
  because changing layout inside `dragstart` makes Chrome abort the drag.
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Outside those roots a file opens only with `?sessionId=` when that session's entries name it (`isFilePathReferencedByEntries`): its absolute path, `file://` form, or `~/…` relative to the server's home (the UI expands `~` the same way through `/api/home`). Any new client-side way of turning text into a file link must have a matching rule there, or the click ends in "Access denied".

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).
- The compacted/full history toggle replaces the whole transcript and the
  first entry id. `CommittedTranscript` drops its anchored render window when
  `entryIds[0]` changes (old row indices mean other rows), and ChatWindow
  restores the reading position from `data-entry-id` anchors (messages and
  the compaction summary) captured at click time. The default view comes
  from `getHideCompactedHistory()` (`lib/composer-prefs.ts`) when a session
  is opened.

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `$schema`, ...), and support rename via `previousName`.
- The MCP editor shares Settings → Extensions & Skills (`SettingsTabs` id
  `"extensions"`) with built-in image generation and the Skills library.
  The category stays available without a workspace; project MCP editing and
  skill management require one. Server list rows show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files`.

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- The obsolete plugin settings panel, tab aliases, component and reload callback
  have been removed; the API and installed packages are unchanged. Skills live
  in the unified `extensions` settings page, not a separate `skills` tab.
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring omp's discovery order: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` queries the npm registry for `@kahme247/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @kahme247/ompweb` or `bun add -g @kahme247/ompweb`).
- `POST /api/omp-update` (`action: "check"`) returns the installed version through
  `getOmpVersion()` (`omp --version`), `updatesDisabled: true`,
  `reason: "source_managed"`, and `updateCommand: null`. This web fork requires
  its paired OMP runtime: official update checks and UI installation controls
  are removed. `lib/self-update.ts` rejects OMP prepare/commit with
  `409 runtime_source_managed` before touching leases or launching workers;
  `bin/omp-web-update-worker.js` also rejects `--kind omp` before side effects.
  Historical status/acknowledgment remain available for artifact cleanup.
- `OMP_WEB_DISABLE_AUTOUPDATE` controls omp-web's own registry check and
  self-update. The OMP source-management lock is independent of that setting.
  Upgrade OMP through the maintained source checkout and atomic binary
  replacement. Terminal `omp update` retains its native behavior.
- omp replaces its binary by rename, so running children keep the old one. Each wrapper records `ompBinarySpawned` (`ompBinaryFingerprint()`); an idle `prompt` restarts the child first when it changed (`spawnOutdated()`), preserving running work.
- `POST /api/omp-update` (`action: "restart"`) restarts every active OMP session at once, running ones included.
- App update notices and commands remain in Settings. The OMP card shows its
  local version, the source-management lock, refresh, restart and release notes.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

### Strict provider/account routing (`lib/account-routing.ts`, `lib/request-policy-files.ts`)
- `omp-web-account-routing.json` stores global disabled providers/accounts,
  per-session provider/account pins and identity metadata (mode 600).
  `omp usage --json` supplies identities; ambiguous or unknown new selections
  fail explicitly. Historical identities keep logged-out denials effective.
- Global denials win over session selections. Auto permits only allowed
  candidates; explicit pins fail when unavailable. Account restrictions also
  exclude anonymous static/env/config keys for that provider. Single-account
  providers support the same disable/pin controls.
- `RpcProcess` supplies `OMP_AUTH_REQUEST_POLICY_FILES`: one global policy and,
  for chat children, one per-process session policy. Atomic file replacement
  updates live children at their next request; `accountRoutingPolicyFile`
  tracks the binding and is released at child exit. Missing or invalid files
  fail closed. Detached descendants retaining a released file fail on their
  next policy-controlled request.
- The maintained OMP fork checks policy during model availability, credential
  selection/rotation and HTTP dispatch, including SDK retries and auxiliary
  model calls. Already-admitted HTTP requests can finish. RPC readiness must
  advertise `requestPolicyVersion: 1`; older runtimes fail startup explicitly.
  These are model-pipeline controls; arbitrary shell clients have their own
  network and credential behavior.
- A new chat passes `accountPins` and `providerPin` with `ensure_session`.
  `bindAccountRoutingPolicy` persists them under the real session id, and
  `routingSessionId` lets the composer edit that live policy before its first
  prompt. `routingInitializing` gates changes while creation is in flight.
- "Last used" reads the session's `credential_pin` entries and matches omp's
  `credentialPinHash` (sha256 of provider, accountId, email, orgId, projectId).
- `/api/provider-usage` preserves the full inventory and attaches each report's
  `disabled` flag from current global provider/account denials AFTER the quota
  cache lookup. `ProviderUsageBar` shows only enabled rows, and highest usage
  uses that same set. Account management keeps the complete inventory and is
  the single place to enable or disable providers/accounts.
  `notifyAccountRoutingChanged()` emits a same-tab event and a storage signal
  after successful settings saves; `useProviderUsage` refreshes immediately or
  on visibility/network return, coalescing changes during an in-flight fetch.

### Saved rate-limit resets (`lib/provider-usage.ts`, `components/ProviderUsageBar.tsx`)
- The usage report's `resetCredits` (Codex / Claude only) becomes
  `ProviderUsageReport.resets`: count, `nextCreditId`, dated credits (`id`,
  `clears`, `remainingCount`, `usable`, `title`), `spendable`, omp's `reason`
  (Claude's `not_at_wall`: its resets only apply at the limit). Each usable
  grant shows its scope pill (`5H`, `5H + Fable`, `Full (5H+7D)`); when an
  account has 2+ usable grants with `id`s, rows expose per-card **Use** buttons
  and the confirmation dialog renders a radio card selector (`creditId`), while
  non-usable banked grants show as `queued`. Stored logins in `omp usage --json`'s
  `accountsWithoutUsage` merge as `noUsageData: true` rows (`—` in the usage
  bar) so transient `/usage` 429s never hide connected accounts.
- Spending goes through `omp usage reset <provider>/<credentialId>[/<creditId>] --redact`,
  never a direct provider call: omp fences the spend against other omp
  processes and confirms it. The browser sends the opaque `accountKey` (plus
  optional `creditId` validated by `PROVIDER_RESET_CREDIT_ID_RE`); the server
  maps `accountKey` to omp's credential id via `omp usage reset --json`. omp's
  sentence comes back as `{ok, message}` (stderr + exit 1 = refused/unconfirmed).
- `omp usage reset` invalidates omp's own per-credential cache (`invalidateAfterReset`,
  preserving peer accounts' `resetCredits`), so omp-web only calls
  `invalidateProviderUsage()` (`usageGeneration` bump) rather than running a
  provider-wide `omp usage invalidate` that would wipe peer accounts' cached resets;
  the panel then calls the hook's `refresh()`.

### Composer word prediction (`hooks/useWordPrediction.ts`, `components/GhostMirror.tsx`)
- Ghost text comes from omp's `predict_word` RPC (engine = omp's
  `spelling.autocomplete` setting; omp applies the prose gates). Tab or →
  accepts; accept/typed-past outcomes go back as `predict_word_feedback`.
- Keystroke predictions never spawn or replace an omp child: the agent route
  answers `{ suffix: null }` when no process is alive, so sessions that are not
  running show no ghost text until the first send.
- Ghost text paints only when the caret ends its line (the mirror overlay would
  otherwise overlap typed text). Settings → Interface & Behavior → Word
  completion (`lib/composer-prefs.ts`, localStorage `omp-web:word-completion`):
  Auto (default) enables it only when the primary pointer is fine
  (`(pointer: fine)` — mouse/trackpad; browsers cannot detect an on-screen
  keyboard), Enabled/Disabled force it. Also skipped for
  drafts past 20k chars (omp's prose-gate cap); an omp without `predict_word`
  ("Unknown command") pauses requests for a minute.
- Ghost state lives in a small external store (`useSyncExternalStore` in
  `GhostMirror`), not ChatInput state: re-rendering the composer per ghost
  change was the dominant per-keystroke cost.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
  `playAttentionSound()` (same toggle, three higher notes) chimes for new attention
  items (AppShell) and the agent `notify` host tool.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible, and `InfoHint`: the "?" for
secondary explanations — opens on hover with a pointer, tap toggles on touch;
its popup is portaled, so custom outside-click handlers must ignore
`.info-hint-popup`), `field.tsx` (form fields + ConfirmDialog, ToggleSwitch,
TagInput), `toast.tsx` (`toast.success/error/info`, mounted in AppShell).
Short condition/behavior badges use the `.hint-chip` class.
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
