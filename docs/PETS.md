# Codex-compatible web pets

Open **Settings > Pets** (Chinese: **设置 > 桌宠**).

- Local Codex pets are discovered from `$CODEX_HOME/pets` or `~/.codex/pets`.
  `OMP_WEB_CODEX_PETS_DIR` overrides that discovery directory.
- To import a pet, select **pet.json and its referenced image together** using
  the Import button. Archive/ZIP and executable plugins are not supported.
- Imports live in `<OMP agent directory>/web-pets`, not in this checkout.
  Persist this directory on a NAS. Mount external Codex assets read-only.
- Enabled pet, size, position, and pointer tracking are browser preferences.
  Each device can choose its own display. Drag or arrow keys reposition it;
  the close icon hides it. Restore it from Settings > Pets.
- While settings are open, only the settings preview is shown, so the floating
  pet cannot obscure controls. Other dialogs remain above the pet.

## Supported assets

`pet.json`: `id`, `displayName`, optional `description`, `spritesheetPath`,
optional `spriteVersionNumber` (defaults to 1).

| Version | Grid | Raster dimensions | Content |
| --- | --- | --- | --- |
| 1 | 8 x 9 | 1536 x 1872 | Nine standard animation rows |
| 2 | 8 x 11 | 1536 x 2288 | Standard rows plus 16 clockwise gaze directions |

Cells are 192 x 208. Images must be PNG or static WebP, at most 8 MiB.
The current row/frame durations are encoded in `lib/pets.ts`. This is asset
format compatibility, not an embedded Codex runtime or a promise of future
format compatibility. Art is not bundled in the repository; respect the
asset creator's license when sharing or redistributing it.

## Activity and performance

Only the currently displayed chat drives the pet: pending extension input
maps to `waiting`, active runs/commands/compaction to `running`, failures to
`failed`, and finished assistant output to `review`. A fresh conversation is
`idle`. Pointer dragging uses the directional movement rows and clicking
plays `waving`. The settings preview can play all nine rows.

No model request is made for the pet. Animation stops when the document is
hidden, and reduced-motion preferences show a static first frame. v2 gaze is
enabled only during idle and returns to neutral after the pointer stops.

## Trust boundary

The existing same-origin and optional password protections cover pet APIs.
Imported metadata is allow-listed; only sibling raster filenames are allowed.
Original Codex directories are read-only through this feature. Uploaded paths
are never used as storage paths. Upload bodies are bounded even when there is
no Content-Length. Unknown directories, links, and bad packages are skipped.
Deleting a pet removes only the imported manifest/image, not original Codex
files. An authenticated/trusted-network user can manage shared imported pets.

## Verification

```sh
node --experimental-strip-types --test lib/pets.test.mjs lib/pet-store.test.mjs components/PetCompanion.test.mjs
```

Manual acceptance: v1/v2 render; animations advance; v2 gaze follows; drag
survives reload; hide/show, size and reset work; import/delete preserves the
original; narrow touch layout stays in bounds; reduced-motion stays still.
Use an isolated `PI_CODING_AGENT_DIR` for import/delete tests.
