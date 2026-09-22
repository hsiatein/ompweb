# Public showcase captures

These PNGs are real browser captures of the app, not UI mockups. All conversations,
workspace paths, models and balances are fictional. The landscape is original
procedural Canvas artwork generated in memory by the capture script; it is not a
Steam workshop wallpaper or a screenshot of a personal desktop. The captures and
procedural artwork are provided under the repository's MIT license.

- `workspace.png`: per-message glass, wallpaper palette, table/inline-code styling
  and a clearly marked demo credit estimate.
- `wallpaper-settings.png`: actual Material text mode, palette toggle, glass
  controls and crop-position UI.
- `mobile.png`: the same synthetic session at a 430 x 932 viewport.
- `dictation.png`: the upstream recording deck in the glass composer, captured
  with Chromium's fake microphone. No real audio is recorded or sent to ASR.

The screenshots demonstrate image-wallpaper mode. See
[the compatibility guide](../local-wallpapers.md) for the separate scene renderer.
No wallpaper files, ASR weights, credentials or pet packs are included.

## Reproduce

Build and start an isolated checkout on `127.0.0.1:13030` with an empty
`PI_CODING_AGENT_DIR`. Do not rebuild a checkout that serves active agent tasks.
Then run from the repository root:

```sh
QA_BASE=http://127.0.0.1:13030 node scripts/capture-readme-showcase.cjs
```

On PowerShell, set `$env:QA_BASE='http://127.0.0.1:13030'` before the Node command.
The script needs Playwright and its Chromium browser; `PLAYWRIGHT_MODULE` can
point to a separately installed module. `QA_OUT` optionally changes the output
directory. All `/api/` requests are intercepted with fixtures; no agent prompt,
filesystem listing, provider lookup, upload or private asset request reaches the
server. Review new images before publishing them. Other local QA captures may
contain personal data and must not be added to this directory.
