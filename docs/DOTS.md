# ob.Pal dots

Direction C, Living Constellation, is the shared language for connection, progress and a first interaction. A dot is a small, distinct piece of the picture. On glass it is a crisp circle; in space it is a lit bead. The layout, scale, roles and motion stay recognizable between them.

This is the design contract implemented by the trust lane’s portable 2D renderer and the shared 3D adapter. The isolated material study remains in the ignored `artifacts/journey/dots-prototype/` directory. The journey build uses product modules, not the artifact renderer.

## One family, two materials

Use `src/family/family.css` for the surface, accent, ink and timing roles. Apps use Lime on Carbon by default. Site pages retain the ultraviolet surfaces and lavender depth in `src/styles/site.css`. Respect the visitor's theme and accent; do not bake lime into a renderer. Resolve CSS tokens when the theme changes, including a pairing chip's shadow scope.

| Proposed token | Source or default | Meaning |
|---|---|---|
| `--ob-dot-active` | `--bb-accent-text`, falling back to `--bb-accent` | Legible active glyph or connection in 2D |
| `--ob-dot-light` | `--bb-accent`; readable `--bb-accent-text` on light glass | Bead albedo and a permitted connection thread in 3D |
| `--ob-dot-ink` | `--bb-ink-2` | Neutral outlines, not yet active |
| `--ob-dot-muted` | `--bb-ink-3` | Optional route; retain an explicit text label |
| `--ob-dot-depth` | `--haze-rgb` on the site; `--bb-aurora` in apps | Far layer tint, never an independent status |
| `--ob-dot-surface` | `--bb-sheet` | Carbon or site glass beneath dots |
| `--ob-dot-focus` | `--bb-accent-text` | Ordinary focus ring around the control, outside the field |

Light surface variants use the darker accent-text for flat dots. Reduce the bead light's exposure and use a dark neutral outline if its silhouette lacks contrast. Connection seal raster cores need at least 4.5:1 against their opaque family sheet backing, and decorative effect cores at least 3:1. Preserved seal cells use full ink opacity. Accent-text is used only when its token ratio against that backing reaches 10:1, leaving headroom for small raster coverage; otherwise use family ink. Never use a raw accent on Light. Measure the rendered pixels, including the glass behind them; explanatory text follows the site's text contrast rules. Color, light and movement never replace a status label. Denial and faults keep the existing labeled status treatment rather than turning the whole constellation red.

## Geometry and scale

All sizes below are **CSS pixel diameters and center-to-center pitches**, measured at the focal plane. They are independent of DPR. A 3D renderer converts them through its camera projection; world units are an implementation detail, not an additional size scale.

| Token | Diameter | Pitch | Use |
|---|---:|---:|---|
| `dot.micro` | 1.8 px | 8 px | Sparse supporting field; never a small seal |
| `dot.base` | 3 px | 12 px | Panel field and device outline |
| `dot.display` | 4.2 px | 16 px | Large outline or prominent glyph |
| `dot.beacon` | 6 px | At least 20 px clear space | One progress marker |
| `dot.seal` | `min(4.2 px, 0.90 × cell pitch)` | `glyph side / 11` | Preserved trust seal cells; ordinary decorative samples retain 0.64 × pitch |

At a 28 px glyph, pitch is 2.55 px and diameter is 2.29 px. Preserve every occupied cell, order and hole. Never resample a seal to meet a decorative density cap; make the surrounding field smaller instead. Present a readable name or comparison alternative beside tiny glyphs. Enlarge the glyph when the comparison is the main task.

Square grids use equal horizontal and vertical pitch and a fixed origin. Hex grids offset alternate rows by half a pitch; row spacing is `0.866 × pitch`. Radial grids use concentric rings separated by one pitch, with `round(2πr / pitch)` samples on each ring and a stable angular origin. Constellations sample meaningful paths by arc length, with minimum separation `0.85 × pitch`; no random glitter or changing sample counts during interaction. Round corners follow the same path spacing as straight edges. Deduplicate endpoints.

Keep diameter below 0.4 × pitch for ordinary fields. The preserved seal's denser 0.90 ratio is intentional. Do not mix grid families inside one glyph. A phone, browser and PC use stable local grids, joined by evenly spaced dots on the device axis. Meaningful outlines stay in the focal plane and have generous empty space around them.

## Flat circles: raster rules

Use analytic geometry: Canvas `arc()` paths, SVG circles or a shader circle distance with derivative-based edge coverage. No raster dot texture, CSS background image, repeated image tile or upscaled low-resolution canvas. Canvas paths are analytic inputs to the browser's rasterizer; they are not a signed-distance shader.

Set the backing store to `round(CSS size × effective DPR)`. Derive separate x/y transforms from the actual backing size divided by the measured CSS size, so fractional element bounds remain correct. Clamp 2D effective DPR to 3. Keep coordinates in CSS pixels and share the same transform for every dot. Do not round each moving center, diameter or phase independently. Keep the grid origin stable across resize and interpolate continuous positions; round once only when caching a stationary backing store. Do not animate scale on a rasterized canvas.

Anti-alias coverage should span about one device pixel. No per-dot `shadowBlur` or bloom on a small seal. Move a field as a rigid surface or move a localized group smoothly; never crawl a dense regular lattice through fractional pixels forever. Preserve minimum projected pitch; remove entire stable rows or outer rings before undersampling creates moiré. Inspect static and moving crops at DPR 1, 2 and 3, including fractional CSS bounds. Passing a still screenshot alone is insufficient.

## Beads: light, depth and optics

Use instanced spheres for large or intersecting beads, or analytic sphere impostors for small beads. An impostor reconstructs a hemispherical normal, shades its curved surface and has correct sphere depth when it intersects other geometry. A flat unlit sprite with a radial blur does not qualify. At under 2 projected pixels, simplify lighting and remove the bead if its contribution becomes unstable. Change LOD with hysteresis, not every frame.

The material is satin glass with a solid light-catching core: starting roughness 0.32, metalness 0.08, dielectric reflectance 0.04. Use a broad upper-left key, a weaker opposite rim and a soft ambient fill. Starting relative intensities are key 1.0, rim 0.35 and fill 0.18. Keep the specular highlight broad and warm white; accent lives in the bead body. Do not animate the light independently of interaction. Convert family colors from sRGB to linear for lighting and perform output conversion once. Built-in materials may handle this; custom shaders must do it explicitly.

| Optical level | Rule |
|---|---|
| `glow.none` | Default on flat circles, seals, text and inactive beads |
| `glow.edge` | Active bead only: faint halo, radius at most 1.5 × bead radius, peak opacity 0.10 |
| `glow.beacon` | Single progress bead: halo at most 2 × radius, peak opacity 0.16 |
| `bloom.low` | Optional desktop highlight-only bloom; threshold above diffuse white, strength ≤ 0.18, half-resolution target |

Halo is light spill beyond a **sharp, shaded core**. It must not close the gap between dots. No full-screen fog used to disguise a flat dot. Turn bloom off first under load; it is not needed for the material to read.

Depth has three bands: `depth.back = -0.35H`, `depth.subject = 0`, `depth.front = +0.08H`, where H is the visible hero's world-space height at focus. Back is sparse context at 0.18–0.35 opacity; subject contains the recognizable objects and seals; front contains the one progress bead. Perspective and pointer parallax provide depth. Focus stays on subject. Background circle-of-confusion is capped at 2 CSS px on desktop and 1 px on small screens. Never defocus a comparison seal or its label. A cheap depth-dependent edge/spatial-lighting approximation is acceptable for distant beads; call it an approximation, not a photographic camera simulation.

In XR, project these same sizes at the intended reading distance, maintain stereo-correct geometry and respect scene occlusion. Do not put a moving field in a head-locked overlay. Comfort, headset resolution and physical-device performance need a separate pilot; this prototype makes no XR support claim.

## Motion vocabulary

Use `--bb-ease-out` (`0.16, 1, 0.3, 1`) for arrival and `--bb-ease` (`0.2, 0.8, 0.2, 1`) for interrupted transitions. Time is milliseconds, independent of frame rate. No springs, overshoot or physics that reorder a seal. A running effect can finish, be canceled or go directly to its final state; never queue cosmetic effects behind a new state.

| Motion | Duration / curve | Bounds and trigger |
|---|---|---|
| Assemble | 640 ms / family ease-out | Once on a real completed pair or explicit replay; stagger ≤ 80 ms; each dot settles into its fixed sample |
| Ripple | 480 ms / family ease-out envelope | One wave after acknowledgment; radius increase ≤ 20%, displacement ≤ 0.25 pitch |
| Shimmer | 700 ms / family ease with a smooth bell envelope | One broad light sweep on deliberate reveal; no twinkles or random blinking |
| Breathe | 6400 ms / smooth cosine | Optional lone waiting marker, opacity 0.86–1; stop after 2 cycles; no radius scaling |
| Stream | 900 ms / linear along arc length, ease-out for final 120 ms | One bead travels along a permitted route after a state change, then rests |
| Part around touch | 200 ms in, 320 ms out / family ease | Local radius 54 px, maximum movement `min(8 px, 0.45 pitch)`; decorative field only |

One motion owns a surface at a time. Pointer response is allowed to interrupt a finite effect; it does not add an autonomous loop. A second surface can redraw to input without starting another idle animation. The trust lane's synchronized handshake keeps its caller-owned 1200 ms sequence and exact source-to-glyph mapping; these tokens govern its material and sub-stages, not its authenticated timing or identity derivation. Inside that sequence, use normalized caller progress and scale cosmetic sub-stages to fit; do not concatenate the standalone durations. A QR's black modules, white quiet zone and scan target receive no dot effect while they remain scannable.

## Interaction and accessibility

Pointer input stays canvas-local and passive. Smooth parallax over about 120 ms with frame-rate-independent damping; cap at ±3° and ±6 CSS px on the subject, ±10 px on background. Leave labels and controls fixed. Pointer leave restores the neutral view. Never change a comparison glyph's cell positions, hide its dots or rotate it enough to confuse a match; adjust only its light.

Touch uses the same local radius, with no hover assumption. Do not capture scrolling, pinch or browser navigation. A short touch can part a decorative panel and return it; the dot is not a touch target. Actual controls retain ordinary focus, keyboard operation and at least 44 × 44 px touch areas. No drag is required to understand the diagram.

Tilt consumes already permitted motion input, clamped to ±1 after a 15° range and a small dead zone. Do not request sensors for decoration on page load. An explicit Use tilt action can request permission; denial or an unavailable API leaves pointer/touch usable. Remove listeners when disabled. Orientation values remain local, with no logging or transmission.

With reduced motion, disable assembly travel, ripple, shimmer, breath, stream, displacement, tilt and parallax. Show the final state immediately; a state change may use an opacity fade of at most 120 ms. Changes to the preference take effect during an animation. Text, labels and the full comparison remain available. Hidden tabs and offscreen fields have no active RAF or compositor animation; resume in the current state without replaying missed effects.

## Density and performance contract

These are engineering ceilings and targets, not measured device guarantees. Dots never become smaller just because DPR increases. Use stable subsets of decorative samples at lower tiers; preserve the meaningful outlines and all seal cells. More DPR means more raster cost, not more dots.

| Surface / tier | Maximum dots | Effective DPR | Active-frame target |
|---|---:|---:|---|
| 2D small panel | 300 per decorative field; preserve every meaningful seal sample | ≤ 3 | p95 CPU draw ≤ 2 ms |
| 3D phone hero, width < 600 px | 600 total | ≤ 2 (DPR-3 device included) | p95 CPU submit ≤ 4 ms; GPU ≤ 8 ms |
| 3D desktop hero | 1200 total | ≤ 2 | p95 CPU submit ≤ 4 ms; GPU ≤ 8 ms |
| All visible fields | 1800 total desktop, 900 phone | — | p95 RAF interval ≤ 20 ms on a 60 Hz physical target |

At most one 3D context and six draw calls for the hero; instancing rather than an object per bead. Keep the hero's pixel area under 3 megapixels and optional bloom targets under 8 MiB. Retained GPU geometry/material/target allocation budget is 24 MiB, excluding the browser's default framebuffer. No shadows, per-dot textures or per-frame allocations proportional to dot count. Render on input and finite effects; idle means zero draws. Stop and dispose observers, RAF, sensors, materials and buffers with the owning surface.

If p95 active frame intervals exceed 20 ms in two 2-second windows: remove bloom/DOF, lower 3D DPR in 0.25 steps to 1, then remove background samples. Keep a stable 2D fallback if WebGL is absent, lost or still over budget. Do not oscillate tiers within a session. Measure RAF cadence and JS submission separately; include asynchronous GPU timer results only if supported and valid. Never use `gl.finish()` to make a favorable-looking timing. A phone-sized browser viewport on a desktop is not a physical phone benchmark.

## Where dots belong

Use them for the Link route diagram, the connection seal beside a phone's name, one pairing transition and a small, clipped connection panel. The same phone/browser/optional-PC outlines can carry the web install companion's pair → enable → try story. Show an unallowed PC branch as muted, labeled and inactive. Pairing is not input enabled; a matching seal is a comparison aid, not PC permission, software signing or certification. Follow `spec/MESSAGING.md`; the PC route stays Windows only.

Do not fill empty space with a dot wallpaper. Keep at least half of a hero clear. No dots behind body text, QR quiet zones, Allow/Deny, the panic key, error explanations, tables or dense settings. Do not replace ordinary icons with unreadable dot miniatures. Routine install instructions use stable glass and plain text; dots appear only where they explain the route or its state. No connection stream before the real state permits that edge. Each appearance must answer which device, which route, which state or which next action.

## Product adoption

The portable `DotField` now resolves the semantic tokens, size profile and finite timing defaults once. Explicit spacing, maximum-dot and color overrides remain supported. Chip shadow tokens, source-to-glyph ordering and caller handshake timing remain intact. Backing transforms use rounded dimensions independently on each axis, 2D DPR is capped at three, breath is opt-in and limited to two cycles, and displacement requires a decorative field.

`DotSpace` owns projection, instanced sphere material and on-demand parallax. Both renderers accept the same normalized point layout and semantic roles. The adapter never derives a seal. Retain the flat renderer for popup, panels and WebGL fallback. Physical-device performance and XR comfort still require their own pilot.

Technical reference: custom material uniforms and shader responsibilities follow the [three.js ShaderMaterial documentation](https://threejs.org/docs/pages/ShaderMaterial.html). The prototype uses the repository's installed three.js r186, without changing dependencies. Prototype optics and desktop-emulated measurements are recorded with the ignored evidence; they do not certify mobile or XR performance.

Stage A resolves sizes, roles and timing in `packages/host/src/dot-tokens.ts`. `src/ui/kit/dot-field.ts` re-exports that contract; `src/ui/kit/dot-space.ts` projects the same normalized point shape as instanced satin spheres. The hero uses one context and on-demand pointer redraws, with a flat fallback on missing or lost WebGL. The first build uses depth-dependent contrast falloff rather than photographic depth of field, and no bloom. Device outlines stay below the phone density limit.

Seal callers opt into preserved samples and never into decorative displacement. The existing caller-owned performance clock and 1200 ms sequence remain unchanged. `DotTimeline` carries an epoch `startedAt` and duration; `dotProgress` can align later consumers. The seal moment records that epoch alongside its existing local start. Stage B must carry the authoritative shared start through the existing handshake, estimate clock offset and use QR geometry for camera projection; no camera flight or new authentication is shipped here.

## Reusable dot loader and connection surface

`DotLoader({ size, label })` and `DOT_LOADER_STYLE` are exported by the portable host package and `src/ui/kit/dot-field.ts`. Sizes start at 16 CSS px and can grow to a hero footprint. Mount `loader.el` in a reserved box, adopt the style once, call `start()` idempotently, `finish()` when the result is ready, and `destroy()` on removal. `aria-busy` follows loading; the accessible label describes the work. The three circles use family ink, with transform and opacity updates only. They never measure layout in a frame. All instances use `dotClock`, one rAF request per document, with an absolute phase that state updates do not restart. Hidden documents, offscreen loaders and reduced motion stop subscribing; reduced motion leaves three crisp stationary circles.

`SealSurface` owns the QR's existing footprint. Its loader hands three source dots into the QR in 240 ms. The scannable SVG then stays still. Authenticated `reveal(id, delayMs)` keeps the caller's original 1200 ms clock, including late delivery: QR modules lift, gather into a ribbon, assemble into the seal and ripple. The flight canvas hands off to the same-size resting glyphs. Extra peers start from an add-dot burst; departure and add/cancel reverse the path. Only one flight or resting plane moves at a time. Full comparison is available from each peer button; names and controls remain accessible. Reduced motion settles immediately, with no travel or hover animation.

Mount `addControl` in the card's icon footer so it never covers a seal at the eight-peer limit. `setPlaceholder(symbol)` stops busy work when no code is available; `loading()` reuses the existing loader when generation resumes.

## Loading surface inventory

The inventory covers the site, controller, embedded host, Link popup/options and Desktop companion. A pending operation owns its state; the dot adapters never infer permission, readiness or a successful download from time elapsed. Short busy titles become accessible labels; instructions, cancellation, denial explanations and safety reasons remain readable. Completed controls use their existing family glyphs. A failed operation stops motion and retains its labeled recovery action.

| Surface | State owner / file | Previous treatment | Adopted treatment |
|---|---|---|---|
| QR generation, add and regeneration, including home, sims, viewer and embed | `packages/host/src/seal-surface.ts` | Seal lane's three dots | Existing `DotLoader` API and QR handoff retained |
| Collapsed pairing chip awaiting or reconnecting to a phone | `packages/host/src/chip.ts` | Pulsing status dot | 24 px dots; stops when the QR card opens or connection settles |
| Sim model download, decode and rig reveal | `src/sim/kit/loading.ts`, `sim/{arm,device,humanoid}/index.html` | CSS turning ring and Loading model(s) | 48 px dots in the existing centred footprint; existing hold budget and fallback retained |
| Sim graphics warm-up | `src/sim/vr/experience.ts`, `src/sim/view.ts` | Hidden canvas plus loading pill | Flat dots during the hidden gate; scene beads compile inside that gate and fade with the reveal |
| Catalogue live preview startup | `src/sim/previews.ts` | Still picture until the first live frame | 32 px dots until the first actual drawn frame; static dots on other pending cards |
| Community catalogue fetch | `src/catalogue/community.ts`, `catalogue/index.html` | Loading packs caption and empty list | 32 px dots; completion or cached/offline result stops them |
| Community preview images | `src/catalogue/community.ts` | Empty image footprint | Static 20 px dots until load/error; family pack glyph remains the fallback |
| Viewer GLB/procedural/local selection | `src/viewer/main.ts`, `view/index.html` | CSS ring, model name and initial Loading caption | Accessible model label and three lit scene beads; newest-selection token still owns completion |
| Viewer dropped GLB/STL/OBJ files | `src/viewer/main.ts` | No progress marker | Same scene loader, including failure, supersession and resource cleanup |
| Viewer model thumbnails | `src/viewer/main.ts` | Empty lazy image | Static 20 px dots in the tile footprint; cube glyph on failure |
| Phone picker thumbnails | `src/controller/main.ts` | Empty lazy image | Static 20 px dots in the reserved picker and selection footprint |
| Portable SDK pairing card and QR generation | `packages/host/src/remote.ts` | Text status, pulsing circle and empty QR | Shared dots during QR generation, then one status loader; connected label retained |
| Shared-scene Watch/Play QR generation | `src/ui/share-panel.ts` | Empty reserved QR area while its module arrives | 64 px shared dots; QR replaces them, close stops them, failure leaves the family glyph and usable link |
| Viewer folder scan | `src/viewer/local-folder.ts` | CSS ring and scanned count | 48 px dots; folder name and scan count remain available |
| Viewer folder refresh | `src/viewer/local-folder.ts` | Rotating refresh icon | 24 px dots in the same button |
| Phone first connection and reachability retry | `src/controller/main.ts` | CSS spinner and Connecting title | 48 px dots, accessible state title and readable recovery/cancel actions |
| Phone ten-digit code lookup | `src/controller/main.ts` | Connecting button text | 24 px dots in the existing button; normal Connect label returns |
| Phone reconnect status badge | `src/controller/linkbadge.ts` | Seal lane's dot loader | Retained; banner does not add another progress loop for that reconnect |
| Phone waiting for host or PC approval | `src/controller/main.ts` | Text banner | Dots beside the explanation; approval remains separate from pairing |
| Remembered screens read/save | `src/controller/connection-sheet.ts` | Loading screens text / aria-busy | 32 px dots, accessible work label |
| Saved-screen connection attempt | `src/controller/connection-sheet.ts` | Three CSS-pulsed icon circles | Shared 24 px dots; connected/check, paused and failed glyphs retained |
| Saved-screen rename and code lookup | `src/controller/connection-sheet.ts` | Saving/Finding text, aria-busy | Dot progress; existing result and input-error explanations retained |
| Phone pack handoff fetch | `src/controller/packs.ts` | Empty handoff while fetching | 24 px dots, then the checked pack's attribution or unavailable explanation |
| Camera permission/device startup and flip | `src/ui/camera.ts` | Rotating ring around the brand | 37 px dots in that footprint; camera identity returns on readiness/failure |
| QR scanner module/device warm-up | `src/ui/camera.ts` | Brand ring and breathing scan corners | Same dots until ready; scannable target stays stationary |
| Hand/body/finger model download and WASM preparation | `src/ui/camera.ts` | CSS ring and conic progress border | Shared dots driven by the existing tracker progress/ready callbacks |
| Sim/viewer audio context startup | `src/sim/audio/session.ts` | No pending cue | 24 px dots during `sound.start()`; a failure stops them and keeps retry guidance |
| Humanoid simulated-driver connection/guardian arm acknowledgement | `src/sim/humanoid/driver-panel.ts` | Connecting/Arming heading | 24 px dots with accessible state; guardian, deadman and fault reasons remain readable |
| Shared scene host connection wait (desktop, first person, XR route) | `src/sim/vr/presence.ts`, `experience.ts` | Connecting/Waiting for host status and pulsing circle | Shared dot status; scene-loading beads are world anchored in XR |
| VR support check and session startup | `src/sim/vr/experience.ts` | Disabled checking button or unchanged Enter VR | Dots in the button while the request is pending; Enter VR returns after acknowledgement |
| Link popup waiting/connecting | `extension/src/popup/popup.ts` | Pulsing dot and text, obsolete shimmer skeleton CSS | 24 px dots; QR generation continues to own its existing footprint |
| Link This tab permission acknowledgement | `extension/src/popup/popup.ts` | Pulsing switch under aria-busy | Dots replace the switch while pending; normal switch returns |
| Link PC startup / phone answer wait | `extension/src/popup/popup.ts` | Starting/Waiting title and PC glyph | Dots beside the family device glyph; short state is accessible |
| Link options PC startup | `extension/src/options/options.ts` | Starting Desktop note | Shared dots; fault explanations and explicit retry/install actions retained |
| Link popup/options Allow or Deny acknowledgement | `extension/src/ui/ask.ts` | aria-busy buttons and autonomous prompt ring | Dots in the phone glyph footprint while saving; Allow/Deny and scope explanation stay readable |
| Desktop install companion status check | `src/link/desktop.ts` | Link is checking Desktop text | Dots during the reported check; family check/close glyph at completion/failure |
| `/link/`, `/link/try/` diagram setup and unavailable WebGL | `src/link/constellation.ts`, `src/link/try.ts` | Synchronous beads or flat fallback | On-demand material adapter shares `dotClock`; no invented asynchronous wait |
| Trust illustrations | `src/trust/main.ts` | Finite assemble/shimmer with zero idle draws | Retained; trust is an illustration, without a loading operation |
| Embed page setup | `src/embed/page.ts`, portable host chip | Synchronous page and lazy pairing QR | Host loader applies when pairing actually starts; no page-wide decorative wait |
| Home sound waiting for a deliberate gesture | `src/landing/main.ts` | Sound family icon and action guidance | Retained as an actionable permission choice; no endlessly busy state while awaiting a gesture |

`dotLoading()` marks a reserved host. The family entry mounts one document observer, destroys detached loaders and uses intersection changes to choose one visible managed progress owner. Other pending hosts retain a static dot frame. The portable `dotLoaderClock()` also shares that single moving owner with QR cards, SDK pairing cards and scene beads; completing or suspending the owner transfers its lease without starting another rAF. Image thumbnails always use that static frame. Hidden pages and offscreen components release clock subscriptions. `DotLoader.finish()` is idempotent, so settled surfaces make no cosmetic writes or redraws. Pairing QR waits retain the family plate and ink until a finished code needs its white background; this avoids a white pending-card flash before the dot morph. The morph primes its starting frame while hidden, so exposing the flight cannot paint the destination and then retract it on the first clock tick.

`dotLoaderFrame()` is the common absolute-phase motion function. `SceneDotLoader` uses `dotBeads()` from the existing material adapter: one instanced mesh, three satin spheres, the caller's lighting, camera projection and render loop, and no extra WebGL context. It owns/disposes its geometry, material, observers and clock subscription. The desktop projection is captured on entry/resize; XR retains the world anchor rather than following the headset. During a sim's hidden warm-up the bead material is compiled with the scene, then fades out over 120 ms when the existing gate reveals it. Viewer completion uses the same bounded fade. The handoff briefly owns the shared motion lease, so a waiting QR pill cannot strand the outgoing beads. The gate, decoder grace, rig fallback and entrance timing are unchanged. Reduced motion supplies static dots and an immediate handoff.

`tests/loading-surfaces.test.ts` rejects CSS busy rotations/skeletons and text-only Loading states in product source. The input-demonstration gyro/gamepad keyframes are explicitly excluded. `scripts/e2e-dot-loaders.mjs`, called by the pages suite, holds real model downloads, checks centred dots, follows completion into the scene, exercises camera cancellation and Desktop status completion, and verifies reduced-motion/settled writes. The viewer guard inspects the actual three-bead mesh, its optical centre and rendered core contrast of at least 3:1 on Carbon and Light. Its accessible host has no backdrop blur over the scene beads. The control-ink guard includes the loader's stable reserved box, rather than its moving individual beads. Browser-emulated pacing does not establish physical-phone or headset performance.

The phone's `landSeal(row, delayMs, source)` drives the existing compact status canvas and leaves it mounted. Tilt uses already permitted input. The Link popup's activity observer is local, carries no input payload and does not join the controlled page's input port. Live activity causes one finite, one-pixel breath; it never starts a continuous idle loop.

## Link hero journey preview

The /link/ hero uses `src/link/hero-points.ts` and `src/link/hero.ts`. A bounded square grid spells a rounded phone with notch and screen, a browser with tab bar and viewport, and a monitor with stand. Both links are separate, evenly spaced dot rows on the same axis. One instanced satin material from `dotBeads()` renders the composition in one draw call; unavailable or lost WebGL uses analytic Canvas circles at the identical samples and phases. Shader readiness uses the parallel compilation extension on the shared clock, with the flat frame visible until a 120 ms opacity handoff into the beads. Polling pauses offscreen and hidden, and releases on teardown; missing parallel compilation or a four-second visible timeout retains the flat illustration. Reduced motion switches to the prepared still frame immediately. The /link/try/ controller demonstration keeps its existing renderer and feedback contract.

Pair, Enable and Try select explicitly labelled illustrations, not connection or permission reports. Hovering or focusing the existing instruction articles selects the matching preview. PC starts unchosen: its link has zero opacity, its monitor keeps neutral ink at 72% opacity and its label says optional / Windows. Only Preview PC route activates that illustrative branch. This page never enables a tab, grants native permission or controls the PC. Reset collapses the first link into three resting dots.

The shared `dotLoaderClock` gives the hero one moving device or route at a time, including arbitration with pending DotLoaders. Finite previews take turns: phone tilt and touch shimmer (700 ms), travelling dot wave (900 ms pairing, 1800 ms idle/connected), browser refresh ripple (480 ms), and one subtle PC screen breath (6400 ms) or enabled pulse (900 ms). A chosen PC route then gets its own wave. These previews deliberately settle instead of running indefinitely. Pointer activity interrupts the sequence with only the selected device effect; permitted tilt affects the phone. Motion changes transforms and opacity, never the grid, material, labels or authenticated seal. Device frames keep family ink; the optional PC frame is muted to 72% until chosen, then returns to full opacity. Decorative screen opacity is separate. Connected routes use family accent-text only with the seal standard's 10:1 token headroom; otherwise they retain family ink, including during the moving opacity phase on Light.

Reduced motion selects the complete still frame. Offscreen, hidden and persisted-history lifecycles release the clock and resume a static current composition without replaying missed effects. Explicit controls can replay a preview. The fixed stage and caption reserve layout space from 360 px through desktop. Browser checks sample meaningful frame/connection cores at 4.5:1 on Carbon and Light, retain labels, check state/PC scope, and prove no settled, hidden or offscreen redraws. `scripts/proof-link-hero.mjs` captures fixed-time state strips, a separate 700 ms warm-up and 2 s rAF timestamp sample at native and 4x CPU throttle. These are desktop browser measurements, not physical phone or GPU claims. Baseline state cells are labelled when round one had no equivalent state.
