# Fork customizations

A short feature summary is in the [English README](../README.md#what-the-fork-adds),
[简体中文 README](../README.zh-CN.md#本分支新增) and [日本語 README](../README.ja.md#フォークでの追加).
This page contains selected implementation, installation and privacy notes:

- Charm Hyper credit balance display, with a clearly marked 250-credit estimate
  only when the provider does not report a total. Subscription status and reset
  time are not inferred from a balance.
- Local Codex-compatible animated pets. See [Pets](PETS.md).
- Original-file image/video wallpapers and browser-native scene rendering,
  audio controls, crop positioning, glass surfaces and adaptive text contrast.
  See [Local wallpapers](local-wallpapers.md) for compatibility and limitations.

## Installation and private state

The server needs both OMP and OMP WebUI to run agent tasks. Install a compatible
`omp` binary on PATH or set `OMP_WEB_OMP_BIN`. No OMP credentials or model
configuration are bundled. Keep the OMP agent directory outside the checkout
and persist it separately when deploying on a NAS or in a container.

Use the service entry points documented in the main README for your platform.
Machine-specific firewall, VPN and login-startup scripts are local-only and
are not published. The default server listens on loopback. Remote exposure
must use suitable authentication and/or an explicitly trusted private network;
do not expose an unauthenticated agent to the public internet.

## Scoped custom instructions

**Settings → Agents & Policies → Instructions** stores multiple prompt rules:

- Global, provider ID, or exact provider ID + model ID.
- **Model > provider > global**: by default only the most specific matching
  text is appended. A provider or model rule can instead **append to
  inherited** (`"combine": "append"`): the broader level's effective rules
  apply too, this text after them, walking up until a replacing or blocking
  level (`resolveAgentInstructions` returns the applied rules broadest first;
  each becomes its own system-prompt entry). Identical model IDs under
  different providers are independent; display names and fuzzy model aliases
  are not scope keys.
- An absent rule inherits. Explicit empty text disables broader custom
  instructions for that scope. Deleting the rule restores inheritance.
- Provider and model fields are linked dropdowns, not free-text inputs. Providers
  come from connected accounts and available models; the model list is filtered
  to the chosen provider. Switching provider clears the model selection.
  Historical rules for removed catalog entries remain readable/editable, but
  do not add those entries to the choices for new rules. The preview displays
  the effective **saved** rule, not an unsaved draft.
- The card, text area, buttons and closed dropdown controls reuse
  `wallpaper-inset`. Across the app, `Select` in `components/ui/field.tsx`
  renders option lists through Base UI portals using `dropdown-surface`, so
  expanded workspace/settings/task menus also follow the shared glass/clear
  modes instead of opening opaque native OS menus. The path autocomplete uses
  the same popup surface and still accepts paths outside its suggestions.
  Keyboard navigation, disabled options and focus return remain supported;
  Escape dismisses the dropdown before Settings. With wallpapers disabled,
  controls use the normal light/dark theme.

Rules live in `<agent dir>/omp-web-agent-instructions.json`, outside the
checkout, with atomic mode-600 saves. The API updates one scope at a time,
preserving other scopes; concurrent edits to the same scope are last-save-wins.
Limits are 100 rules and 20,000 characters per prompt. This does not edit
`AGENTS.md`, OMP's native settings, or task-agent definitions in the separate
Subagents tab.

Every main-chat start/resume/restart loads `bin/omp-web-instructions.ts`
explicitly. Its native `before_agent_start` handler reads the latest file and
selects by OMP's current main-chat model when an ordinary prompt or a queued
user-containing batch starts. Saving or switching models therefore takes
effect on the next such message, including scheduled/webhook delivery, without
restarting the child or interrupting an in-flight response. Selection is not
rerun for each provider retry, tool-only step, or internal helper request.
Native system instructions, project context, and the web sudo policy are
preserved. Children already running before this feature was installed need
one restart to load the extension; independently launched terminal OMP sessions
do not receive it.

Verified against OMP 18.12.6 using real RPC and captured loopback-provider
requests: model/provider/global precedence, same model ID on another provider,
empty overrides, deletion, no accumulated old prompts, preserved base/sudo
instructions, and fresh rule selection when a follow-up leaves the queue.
Keep `bin/omp-web-instructions.ts` and its local TypeScript dependencies in
deployment packages; they are included in npm files and Next's tracing list.

## Agent file-opening approval

**Settings → Interface & Behavior → Allow background sessions to open files
in the side panel**, directly below **Automatically open web links in the
browser**, is off
by default and saved only in the current browser. With it off, requests from
other sessions (including while Settings hides the current chat) still ask
before opening a file. Requests from the viewed chat already open directly.

With it on, any session can open an authorized file in the side panel without
confirmation. This can switch the active file tab and leave Settings to reveal
the panel. File API authorization and editing permissions are unchanged;
the preference grants no additional filesystem access. URL approval remains
separate, and URLs from other sessions always ask.

## Interface & Behavior

**Settings → Interface & Behavior** (`general`) uses three horizontal tabs:

- **Interface layout**: tool-call collapse and sidebar provider-usage visibility.
- **Interaction behavior**: native selection scope, automatic link/file opening,
  completion sound, speech playback/voice, active-run submission, and word completion.
- **Keyboard Shortcuts**: all application key bindings.

The split follows whether a control changes the arrangement/visibility of UI
content or how interaction works. The segmented navigation is shared with
Appearance & Personalization, including arrow/Home/End navigation and narrow-screen
scrolling. Search opens the corresponding subtab. All three panels contain
browser preferences and remain usable while native OMP settings are loading.
Only the selected panel mounts.

The shortcut editor retains all 21 actions, recording, removal, clearing,
default restoration and conflict hints. Its store and
`omp-web:keyboard-shortcuts` key are unchanged, so existing custom bindings,
immediate application and cross-tab synchronization are preserved.

## Models & Providers

**Settings → Models & Providers** uses category ID `providers`. Its horizontal
tabs cover connected accounts, custom providers, model registry/routing, and
default parameters. The former `models` sidebar category is removed.

The five global defaults retain their native keys: `defaultThinkingLevel`,
`textVerbosity`, `personality`, `hideThinkingBlock`, and `externalThinking`.
They use the existing `/api/omp-settings` automatic-save path; model registry
changes continue using their own save controls. Switching subtabs retains the
provider editor's configuration draft. Settings search carries the destination
subtab, and each default parameter opens the Defaults panel.

Native-setting loading/errors stay inside Defaults, keeping account and
registry navigation available. A malformed `models.yml` retains its parse
error and write protection while allowing access to global defaults.

## Agents & Policies

**Settings → Agents & Policies** uses category ID `agents`, combining the
former Agents, Agent & Intelligence, and Safety & Approvals categories.
Horizontal tabs organize the existing controls:

- **Instructions**: scoped global, provider, and model custom instructions.
- **Subagents**: delegation permission, maximum nesting depth and concurrency,
  plus task-agent definitions, bundled templates and user/project agents.
- **Runtime policies**: all 13 existing compaction, memory, automatic-learning,
  and retry controls.
- **Tool approvals**: approval mode, Bash override, and extension-tool requests.

Runtime and approval controls retain their native configuration keys and
automatic saves through `/api/omp-settings`. Instruction and subagent editors
retain their own save controls and keep drafts while switching subtabs.
Settings search opens the matching subtab. Native-setting loading/errors stay
with their controls, leaving the instruction and subagent editors available.
Browser link/file-opening preferences remain in Interface & Behavior → Interaction behavior.

## Appearance & Personalization

**Settings → Appearance & Personalization** uses category ID `appearance`
and the same horizontal segmented-tab styling as Models & Providers:

- **Theme & Display**: system/light/dark theme, chat font size, interface scale.
- **Wallpapers & Glass**: the existing wallpaper library, glass, colors and audio.
- **Pets**: the existing pet library, imports, size and pointer-following controls.
- **Motion**: whale-tail animation selection and previews.

The former top-level wallpaper/pet pages and General's font/scale/whale controls
are removed. Theme selection shares the topbar's store. Preference keys,
asset storage and APIs do not change.

`AppShell` owns the selected appearance subtab so wallpaper and pet shortcuts
open the correct panel. Setting search results carry the subtab explicitly;
category-only results open Theme & Display. Only the selected panel mounts.
Arrow keys wrap between tabs; Home/End select the first/last. On narrow screens
the tab strip scrolls horizontally without widening the page.

## Extensions & Skills

**Settings → Extensions & Skills** uses the single category ID `extensions`.
It groups built-in image generation, MCP server configuration, and the Skills
library. Settings search navigates to the relevant section. The category can
be opened without a workspace: image generation and the global MCP inventory
remain available; project MCP editing and skill management explain that a
workspace must be selected.

The existing MCP editor and skill manager retain their storage and permission
rules, including skill invocation toggles, installation, and updates. The old
`mcp`, `skills`, and `plugins` tab identities, normalization alias, unreachable
plugin panel, reload callback, component, and translations are removed.
This does not uninstall plugins or remove the backend `/api/plugins` endpoint.

## Validation

### Subagent policy

**Settings → Agents & Policies → Subagents** automatically saves:

- **Allow subagents**: `subagentsEnabled` in `omp-web-settings.json`, initially
  false, through `/api/web-settings`.
- **Maximum subagent depth**: native `task.maxRecursionDepth` in `config.yml`,
  through `/api/omp-settings`. The main agent is depth 0; 1 allows one child
  level, 0 disables creation, and -1 permits unlimited nesting.
- **Maximum concurrent subagents**: native `task.maxConcurrency`. Positive
  integers bound each parent's running children; 0 permits unlimited concurrency.

Every RPC launch appends the atomically generated
`omp-web-subagent-policy.json` as its final configuration overlay. Saved web
limits therefore take precedence over workspace and custom launch arguments.
Disabled delegation forces depth 0, disables speculative spawning and denies
task approval. Enabled delegation restores the saved depth/concurrency limits;
tool presets and other native approval rules continue to apply.
Changes take effect for new or restarted OMP processes.

The paired OMP runtime shares one parent budget across task calls, direct Eval
`agent()` calls and workpools. Excess children queue; cancellation releases
queued admission. Nested parents have independent budgets so a waiting parent
can let its own children finish. These controls cover OMP's delegation APIs;
arbitrary shell clients retain their own process and network behavior.

The opt-in smoke uses temporary settings and a loopback model fixture:

```sh
node scripts/check-subagent-policy.mjs task,eval-agent,eval-workpool,read-normal,enabled-task,enabled-zero-depth
```

Those six scenarios were exercised against the paired 18.12.6 source build:
disabled task/Eval/workpool admission, preserved ordinary reads, a real enabled
child completion, and a saved zero-depth limit overriding a broader launch config.
Additional script cases cover batch, Python, xdev and ordinary write/Eval paths.

### Stop and restart

Full and minimized composers and configured stop shortcuts interrupt the
current task directly. Manual shell commands use `abort_bash`; agent runs use
`abort`. Reload replaces the child against its transcript. Restart OMP sessions
stops all live children, with subsequent commands reopening their sessions.
In-flight operations may lose progress. External tmux jobs remain independent.

### First-run provider setup

Registry queries and login flows tolerate an OMP profile with no configured
models. If OMP exits at startup with `No models available.`, an ephemeral
control process retries once with a built-in catalog model, without adding
credentials or sending a prompt. Normal starts retain the configured default
model; explicit model choices and unrelated startup errors are not overridden.
This applies only to `--no-session` utility/login processes, never chat sessions.
The bootstrap catalog selector was verified with OMP 18.4.4. Recheck it when
updating OMP. The provider list still comes from OMP's own registry.

### Application tests

```sh
npm ci
npm run typecheck
npm test
```

Browser regression scripts in `scripts/check-wallpaper-*.cjs` use Playwright.
Install it separately or point `PLAYWRIGHT_MODULE` at an existing installation.
Use an isolated test server/profile and set `QA_BASE` to its URL. Some scripts
target a dedicated scene-renderer QA harness rather than the normal app page.
Local asset checks require `QA_ID` or `QA_IDS`; GPU/video diagnostics also use
`QA_VIDEO_SCENE_ID` and `QA_VIDEO_URL` as appropriate. Do not run those checks
against private production sessions or publish generated screenshots/reports.

Never rebuild the active `.next` directory or restart its server while agent
tasks are running. Build in an isolated checkout and switch only after tasks
finish or interruption is explicitly accepted.

## Publication hygiene

The repository excludes local credentials, databases, sessions, private writing,
wallpaper/pet artwork, diagnostic captures and workstation deployment records.
These remain local; assets must be supplied from the user's own installation.
