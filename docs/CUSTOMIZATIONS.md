# Fork customizations

This fork adds the following features to OMP WebUI:

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

## Validation

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
