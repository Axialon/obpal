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

Light surface variants use the darker accent-text for flat dots. Reduce the bead light's exposure and use a dark neutral outline if its silhouette lacks contrast. A meaningful dot glyph needs at least 3:1 contrast against its immediate surface; explanatory text follows the site's text contrast rules. Color, light and movement never replace a status label. Denial and faults keep the existing labeled status treatment rather than turning the whole constellation red.

## Geometry and scale

All sizes below are **CSS pixel diameters and center-to-center pitches**, measured at the focal plane. They are independent of DPR. A 3D renderer converts them through its camera projection; world units are an implementation detail, not an additional size scale.

| Token | Diameter | Pitch | Use |
|---|---:|---:|---|
| `dot.micro` | 1.8 px | 8 px | Sparse supporting field; never a small seal |
| `dot.base` | 3 px | 12 px | Panel field and device outline |
| `dot.display` | 4.2 px | 16 px | Large outline or prominent glyph |
| `dot.beacon` | 6 px | At least 20 px clear space | One progress marker |
| `dot.seal` | `min(4.2 px, 0.64 × cell pitch)` | `glyph side / 11` | Trust lane's occupied 11×11 cells |

At a 28 px glyph, pitch is 2.55 px and diameter is 1.63 px. Preserve every occupied cell, order and hole. Never resample a seal to meet a decorative density cap; make the surrounding field smaller instead. Present a readable name or comparison alternative beside tiny glyphs. Enlarge the glyph when the comparison is the main task.

Square grids use equal horizontal and vertical pitch and a fixed origin. Hex grids offset alternate rows by half a pitch; row spacing is `0.866 × pitch`. Radial grids use concentric rings separated by one pitch, with `round(2πr / pitch)` samples on each ring and a stable angular origin. Constellations sample meaningful paths by arc length, with minimum separation `0.85 × pitch`; no random glitter or changing sample counts during interaction. Round corners follow the same path spacing as straight edges. Deduplicate endpoints.

Keep diameter below 0.4 × pitch for ordinary fields. The seal's denser 0.64 ratio is intentional. Do not mix grid families inside one glyph. A phone, browser and PC can have separate, stable local grids, joined by one continuous thin thread. Meaningful outlines stay in the focal plane and have generous empty space around them.

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
