# Local wallpapers

The Wallpapers settings page supports local PNG, JPEG, WebP, GIF, AVIF, MP4 and
WebM assets. Browser codec support still applies. Wallpapers default to playing
with 50% volume; existing saved pause and mute choices are preserved. Video
playback loops and pauses when the document is hidden. The play/pause control,
volume, mute, fit and brightness are stored per browser, independently of OMP
sessions. Browser autoplay rules still apply: playback is retried on the first
pointer or keyboard interaction if audible autoplay is blocked.
Selecting or importing a wallpaper explicitly starts playback, including when
the OS reduced-motion preference is enabled; the manual pause control remains
available.
Cover mode has a draggable crop-selection preview and horizontal/vertical
position sliders. The selection matches the current viewport aspect ratio and
uses the actual image, video frame or live scene canvas, without extra media
requests or render sessions. Only cropped axes are adjustable; contain mode
keeps the complete wallpaper. Crop position persists on reload in this browser
and resets to center when a different wallpaper is selected. Existing saved
preferences default to centered positioning. Source files are never cropped.

Import uploads are streamed into `<agent-dir>/web-wallpapers/imports` with a
512 MiB limit. Larger files can be read in place by adding their server folder.
Uploads and added folders are shared by clients of that server; selection and
glass mode are not. Only imported copies can be deleted in the UI. Existing
Wallpaper Engine files are never modified.

Steam libraries are discovered from standard installation locations and
`libraryfolders.vdf`; workshop app 431960 and `projects/myprojects` are scanned.
A manually added folder may be a single Wallpaper Engine project or a library
containing project folders, or loose supported media. Scans are bounded to
three directory levels and 3000 visited folders. Custom Steam locations can be
added manually. For NAS/container deployments, add paths inside the server or
mount and set `OMP_WEB_WALLPAPER_DIRS` (OS path delimiter separated). Setting it
to an empty string disables Steam auto-discovery.

The default glass mode only blurs message bubbles, the composer, text-bearing
sidebar elements and the top bar. Chat whitespace remains unblurred. Clear
mode removes those fills and blur; frosted mode blurs entire chat/sidebar panes.
Provider usage applies glass directly to its panel, including expanded account
details. Sidebar session rows have 8px corners. The right workspace applies glass
to its toolbar, explorer rows, Git changes and code/Markdown text surfaces, while
leaving unused space clear. Frosted mode also covers the whole right workspace;
clear mode removes the surface fills and blur. Selection and Git diff colors
remain visible, and disabling wallpapers restores the original solid surfaces.
No wallpaper selected or failed media restores the original interface.
Glass opacity defaults to 35% (including preferences saved before this option
existed) and can be adjusted from 0 to 100% independently of wallpaper brightness.
Clear mode ignores the opacity setting.

The upload route skips Next.js proxy body cloning (10 MiB default), but calls
the same `guardApiRequest` origin/session check directly. Other endpoints use
the proxy normally. Assets are served only by catalog ID, with path containment,
media type/signature checks and HTTP range support. Application wallpapers
are not executed. Supported SceneScript bindings run in a bounded QuickJS WASM
guest, never as host JavaScript. Scene resources are parsed only after selection
and unsupported operations produce an explicit error.

## Browser-native scenes

Scenes no longer use the Windows capture helper or frame streaming. The server
parses `scene.pkg` (or a loose scene), decodes full-resolution TEX textures and
serves a scene manifest plus content-addressed PNG assets and original embedded
MP4 texture payloads (with HTTP range support). The browser
downloads them once and runs a Three.js/WebGL renderer on its own GPU. Animation
does not make frame requests. Legacy POST stream requests return HTTP 410.

The canvas keeps the original scene aspect ratio for the existing crop controls.
Its resolution matches the displayed device pixels (including offscreen cropped
edges), subject to GPU texture limits and a 16-megapixel safety budget. Smaller
windows no longer supersample the final scene to the original source resolution.
Effect buffers retain the source layer resolution. No artificial sharpening,
JPEG re-encoding or low-resolution preview fallback is used. A source texture
still cannot gain new detail by displaying it at a higher resolution.

The renderer requests the high-performance GPU and follows the browser's native
animation-frame cadence without a separate FPS cap. Layout measurement and output
buffer resizing only happen when the viewport, fit or device pixel ratio changes.
An unused depth buffer is disabled; antialiasing and the preserved color buffer
remain enabled so edges stay smooth and paused crop previews can read the canvas.
Actual FPS depends on GPU load, effects, browser acceleration and display refresh.

Currently implemented: orthographic image and procedural quad layers; normal,
multiply, screen, additive, lighten and vivid-light image blending; validated
effect/workshop shaders, ordered passes and named/downsampled framebuffers;
masks and GLSL uniform/combo parameters;
camera parallax, shake and thresholded bloom. Sprite particles support lifetime,
size, color, velocity, rotation, alpha fades, turbulence, position/alpha/size
oscillation, control-point attraction, size changes and sprite/rope trails.
Child systems support static, follow, spawn and death events, independent
instance quotas, probability, offsets, 2D rotation/scale and one-shot bursts.
Instances of the same child definition share an instanced draw. Supported
normal-map refraction samples the previously drawn framebuffer locally.
Texture formats: RGBA8888, RG88, R8, DXT1/3/5 and encoded image payloads;
single-image sprite atlases also animate image layers. Original shader
resources are adapted to GLSL ES rather than substituted with CSS motion.
When camera parallax is enabled, layer anchors receive the native static offset
`(origin - sceneCenter) * cameraAmount * layerDepth` independently on each axis,
before mouse/shake displacement. This does not scale the layer geometry and
still applies when mouse influence is zero. It prevents small animated overlays
from drifting away from centered full-scene layers (for example, animated eyes).
The implementation is parameter-based, not a per-wallpaper pixel correction.
Property scripts support origin, scale, angle, color, alpha, visibility and
parallax depth. Vec2/Vec3 layer values are copied on read/write; script angles
use degrees and scene JSON angles use radians. A shared isolated runtime
supports layer lookup, enumeration, sorting and creation from precached image
models (including workshop-scoped asset names). Dynamic templates retain their
own material and do not inherit a placed image's effects/tint. Image alignment
is applied after the anchor's parallax transform.

Script imports cannot access Node, the DOM, network, storage or arbitrary files.
Each scene is bounded to 32 property bindings, 256 new layers, 512 total layers,
16 MiB guest memory, 200 ms initialization and 8 ms per update. Dynamic render
buffers have a separate 16-megapixel budget. Script failures stop playback with
an error, rather than silently replacing live behavior with a static image.
AudioBuffers retain per-frame left/right/average values at 16/32/64 bands.
Original scene soundtracks feed a browser Web Audio analyser, then both
SceneScript AudioBuffers and active shader spectrum uniforms. Volume/mute is
applied after analysis so a muted wallpaper can remain audio-reactive. The FFT
uses logarithmic frequency bands and is not a pixel-identical native analyser.
The optional audio-source button explicitly requests browser system/tab audio
sharing; it is never requested automatically. This requires localhost or HTTPS
and a browser that offers audio sharing. Plain HTTP through a WireGuard address
still plays wallpaper soundtracks, but cannot request system audio. Captured
audio belongs to the browser's device, not the server/NAS. No captured screen
image is read, rendered or uploaded; captured audio is analysed without echoing
it to the speakers. All sharing tracks stop on disable or wallpaper disposal.
Scenes needing audio without a soundtrack or shared source retain a warning.
Other SceneScript
APIs, dynamic text/particle creation and arbitrary resource creation remain
unsupported. Custom workshop base-image shaders use the validated effect path.

Particle simulation uses the source configuration but a local deterministic
random generator and simplex turbulence; trajectories are not guaranteed to
match Wallpaper Engine pixel for pixel. Camera and bloom are browser-side
implementations, not a pixel-identical port of the proprietary engine.
Sound objects serve their original MP3, FLAC, Ogg, WAV, M4A or AAC bytes with
signature checks and HTTP range support. Their authored volume and playback
mode are retained, with separate master volume/mute controls. There is a 256 MiB
aggregate audio budget per scene. Sounds awaiting script events remain silent
with an explicit warning; general SceneScript sound commands are not implemented.
Audio decode errors do not tear down the visual renderer. Logical image size (32 Mi pixels) and
padded texture allocation (64 Mi pixels) have separate bounds, allowing an
8192x8192 padded texture with a 6810x4742 actual image without downsampling it.

Text layers support packaged TTF/OTF/WOFF fonts, system fonts, alignment and
multiline rasterization, constrained word wrapping and row limits with optional
ellipsis. Text update scripts execute in bounded QuickJS WASM,
with no host DOM, network, filesystem or module loader. Date and saved script
properties are available. Other SceneScript APIs are not generally implemented.
Text effects use the same render-target pipeline as image effects.

MDLV0013 supports static triangle meshes and weighted bone animation with one
non-additive clip, loop/once playback, speed and blend weight. MDLV0019/0023,
clipping metadata and layered/additive clips remain unsupported. Image/text
parenting uses composed local affine transforms, preserving rotation, shear,
negative scale, inherited visibility and parallax depth. Invalid/cyclic parent
graphs fail explicitly. Parented particle systems and bone attachments remain
unsupported. Timeline-bound properties retain their saved values with warnings.
System media metadata is unavailable; media widgets receive a stopped state,
not fabricated track metadata or playback events.
Connected-particle `rope` ribbons and per-particle `ropetrail` are distinct;
rope subdivision uses centripetal Catmull-Rom interpolation. Particle behavior
is still an approximation, not a native-engine equivalence claim.
Genericimage2 reflection supports normal, roughness, metallic and reflectivity
inputs using a local mipmapped background buffer; other PBR/lighting paths are
not implemented.

This is not a complete Wallpaper Engine replacement. Unsupported 3D/puppet
formats, general SceneScript, particle control-point inheritance and shader
features still fail explicitly, without a static preview or streaming fallback.
Audio spectrum shaders can display with silent input but are recorded as partial
support; scripted shader bindings that retain saved values are also reported.
Disabled native audio branches do not generate this warning.
Regression coverage includes synthetic geometry, effects, audio, large padded
textures, interaction and timeline fixtures. Private library inventories and
machine-specific deployment reports are not distributed with the source.
Particle trajectories and child pre-warm/nested inheritance semantics are not
a complete implementation of the native particle engine.

Pausing freezes local simulation; hidden tabs stop rendering without discarding
their current time. Changing wallpaper releases geometries, render targets,
textures, image bitmaps and the WebGL context. The server needs no desktop or
GPU, and Windows Wallpaper Engine does not need to be running.

For Linux/NAS, copy the user's wallpaper folder and any required built-in engine
assets from their own installation. Set `OMP_WEB_WALLPAPER_ASSETS` to the copied
`assets` directory (multiple roots use the OS path delimiter). On Windows,
standard Steam installation assets are discovered automatically; an existing
`OMP_WEB_WALLPAPER_ENGINE` setting is also used only to locate adjacent assets.
No proprietary binaries, artwork or engine assets are distributed in this repo.
Only resources referenced by the validated scene are served, by hash rather than
arbitrary client-supplied paths. Resource sizes and decode allocations are bounded.

Images and videos remain original-file delivery through native browser media
elements, without any scene rendering or transcoding.

## Web wallpapers and presets

Project types are case-insensitive (`Scene`, `Video`, `Web`, etc.). Numeric
workshop dependencies resolve only against projects already in the catalog;
the base project must be installed/scanned. Presets reuse its resources; web
presets apply their property overrides. Cycles, excessive nesting and missing bases
produce a specific library reason instead of an unexplained unsupported label.

Web projects run their original HTML/CSS/JavaScript in a browser iframe with
`sandbox="allow-scripts"`, without `allow-same-origin`. The host app's DOM,
cookies and storage are inaccessible. Server-minted capability URLs allow
read-only access exclusively to that project's resources, with path and symlink
containment. CSP blocks external scripts/network calls, frames and navigation
forms. Parent application APIs retain their origin and session checks. These
are local wallpapers, not arbitrary website hosting.

The bridge implements property/general settings callbacks, isolated ephemeral
storage, HTML media volume/mute and pause/visibility messaging. It supplies
Wallpaper Engine's `audioVolume` general property as a percentage. Arbitrary
Web Audio graphs created by web wallpaper scripts are not automatically routed
through a master gain; those scripts must honour the general-property callback.
Animation-frame callbacks
are suspended while paused; arbitrary timers/CSS animation and all of Wallpaper
Engine's web integration APIs are not emulated. Network-dependent wallpapers,
audio analysis and native plugin APIs can still require further adapters.
Restarting the server invalidates asset capabilities; reload the app afterward.

The RainEffect workshop template receives scoped compatibility repairs for
missing slideshow links and the renamed city image. It reloads after viewport
resizing because its original script allocates its canvas only once. Presets
require their corresponding base project to be installed locally.

## Adaptive text contrast

Wallpaper settings enable adaptive text contrast by default. The app samples
visible image/video/WebGL wallpaper pixels locally at 2 Hz and composites the
text's ancestor background fills (including glass opacity). Neutral black or
near-white ink is selected using WCAG relative luminance and contrast, retaining
the previous ink while it remains readable to reduce flicker. No samples leave
the browser. This is an approximation on blurred, moving or textured backgrounds,
not a guarantee of WCAG conformance for every rendered pixel.

CSS Custom Highlight ranges preserve React text nodes, text selection/copy and
streaming updates. Words crossing a light/dark boundary can use individual
grapheme colors. Code blocks, inline code, diffs, alerts and explicit status
colors retain their semantic styling. Native inputs/selects keep a single text
color sampled near their text origin, with a fine opposite-color halo for text
crossing mixed backgrounds; the workspace arrow is sampled separately.
Scroll, resizing and text/layout mutations invalidate cached ranges. The
settings checkbox disables this behavior without changing the normal theme.

Sandboxed web wallpaper iframes and browsers without the Custom Highlight API
retain theme text colors; their isolation is not weakened to read pixels.

## Safe deployment

OMP RPC processes belong to the web server. Restarting it destroys its managed
sessions, so do not restart or rebuild its active `.next` while work is running.
Build and test an isolated source copy with a separate `PI_CODING_AGENT_DIR`
and port instead. Deploy only after active tasks have finished or the user has
explicitly accepted interruption. A standalone terminal OMP process is separate.
