# Prototype mesh sources

These scripts author original geometry from an empty Blender scene. They do not read reference models or images.
Blender 5.2.2 runs headlessly, with `BLENDER` pointing to its executable:

```powershell
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/drone.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/so101.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/rover.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/arms.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/flyers.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/vehicles.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/cameras.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/dog.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/studio.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/humanoids.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/humanoids_soft.py -- --cache
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/humanoid_arena.py
```

`common.py` makes clipped component housings, tapered planar facets, metal-framed
ceramic insets, segmented guards and turned mechanisms. Detail chamfers are 0.5 mm;
housing chamfers are 2 mm. Insets have a 1.5 mm Carbon seam, backed 1 mm below the face.
Flat faces keep their own normals rather than becoming inflated smooth shells.
Each rigid frame is merged by material. `compress.mjs` compresses the exported streams with
meshoptimizer 1.1.1 (MIT), validates them by decoding, and writes `public/models/*.glb`.
Positions normally retain 18 bits of exponential precision; the v2 humanoids opt
into 24 bits for their machined edge slivers. Normals retain 12 bits. No textures are needed.
Intermediate exports stay under ignored `artifacts/codex-style/authored/`.

`render_humanoids.py` produces the eight 3840×2160 turntable stills and the pair in
the arena under `artifacts/humanoid/phase-3b/v2/renders/`. Add `-- --draft` for
1280×720 iterations, or `-- --silhouettes` for transparent flat-black front/side
images. These are original Cycles studio renders. `humanoid_surfaces.py` supplies
the same linear colours, roughness and metalness as the runtime's three primary
robot finishes. The phone Viewer omits the obsidian/glass clearcoat lobe; smoked robot
glass is opaque, and arena fins use one alpha pass. No downloaded environment or
textures are used. The live scene approximates studio illumination with a static
procedural reflection map and sole-contact gradients, not ray-traced reflections.

Keel and Morrow retain the profile's complete pivot hierarchy at both LODs. A dot
in an anatomical joint ID becomes an underscore in glTF, whose animation binding
names exclude dots. `tests/humanoid-models.test.ts` compares every translation and
parent to the live profile, sweeps each joint through both limits and checks all
geometry, material, triangle and byte contracts. It also checks limb coverage in
folded poses and all three finger frames. Both LODs derive from the same machined
shells; distant non-socket parts are simplified to fit the 10k budget. The live
rig uses 5.5/6.5 m hysteresis and preserves all angles during swaps. The arena's
7,360 triangles and six material batches fit its 15k budget without another LOD.

The abdominal core is one elastomer envelope shared by two bodies. The thorax half (`spine_roll`) carries
the plates; the lumbar sleeve (`spine_yaw`) is the same envelope's lower half, so it twists with the waist
but stays seated in the hip bridge through pitch and roll. The halves overlap about the pivot so no bend
opens a gap. The sleeve, and at the distant LOD both halves, keep their own rings outside the tessellation
budget. `render_humanoids.py -- --lumbar [--lod]` renders waist stills at the spine's twist and bend limits.

`humanoid_clearance.py` cuts moving sleeve envelopes, expanded by 8 mm, from the
fixed shoulder/hip shells and collar surround. It samples each independent axis
at 17 positions; internal spherical bearings remain closed. The authoring audit
uses actual segment/triangle intersections at 65 positions per axis, at both
LODs, rather than bounding-box overlap. Run it with:

```powershell
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/audit_humanoids.py
```

The audit writes `clearance.json` to a new temporary directory and fails for an
exterior crossing outside the nested joint envelopes. Copy its evidence into
`artifacts/` after the run. Its scope is adjacent exterior shells in independent
sweeps; it is not a physical self-collision solver for arbitrary simultaneous
angles or manufacturing certification. `scripts/humanoid-model-proof.mjs` adds
the actual three.js desktop/phone views and per-joint sweep sheets to the guarded
humanoid e2e run, again writing only to the test's temporary directory.

`humanoids_soft.py` authors Cairn, Rill and Hush in forms I (1.73 m) and II (1.80 m),
without changing Keel or Morrow. Version 2 (H2a) follows the approved concepts:
`humanoid_forms.py` holds every cover section and asserts the pivot spread against
`humanoid-forms.json`, which also carries the landmark targets, face-glass ellipsoids
and shoe-fit tolerances that `tests/humanoid-soft.test.ts` checks on the compressed
assets. `anatomy2` in `humanoid_surfaces.py` lofts four-quadrant superellipse rings
with centre offsets and front or rear lobes, so medial thigh, bust, pectoral and
gluteal mass sit where the concepts put them, within the unchanged joint frames.

Covers end in rolled lips short of each joint over a slim, closed elastomer
under-suit; the suit shows dark only at the designed seams (waist, armpits, neck,
elbows, knees, wrists and ankles). `lining` gives the pelvis and thigh under-suit
the cover's colour, so the crotch reads as one leotard line; the audit still skips
every under-suit by name. Elbows and knees fold against a fixed bisector plane:
each cover flattens from its lip, and the gaskets and under-suit taper or stop short
beneath it, with any vertex beyond the lip seated 3 mm under the plane. No sampled Boolean cuts remain: `clear_sweeps` samples each audited
pair at the audit's own 65 angles per axis and eases fixed cover vertices toward
their own body until clear of the union of moving-cover poses, then eases the moving
cover's lip back from the result; `settle` then smooths each rim only to positions
that stay clear. Each face window
is one clean Boolean with a dense designed cutter, filled by a glass lens on the
profile's face ellipsoid and finished with a rolled lip. Cairn's panel seams are
left out until a texture or vertex-attribute path exists. Shoes stand on the physics
foot box's bottom plane and span at least 85% of its length. The independent audit
keeps the original envelope radii and samples 65 positions per axis, across all six
forms and both LODs. `node scripts/humanoid-proportions.mjs` prints the measured
landmarks and writes them to a temporary folder.

The optional `--cache` saves the unmerged authored scenes under ignored artifacts.
It lets the audit and renderer use the same geometry without rebuilding. Run
`audit_humanoids.py -- --soft --cache` and `render_soft_humanoids.py -- --cache`
after the build. The renderer writes four 3840 x 2160 body views, two head studies
and front/side silhouettes for each form under `artifacts/humanoid-third/renders/`.
Tests validate the compressed assets, rather than relying on these authoring caches.

`scripts/humanoid-soft-comparisons.mjs` assembles the concept/model and head boards,
silhouette sheet and review index after the renders. It records compressed asset
budgets and verifies Keel/Morrow's four GLBs against master byte for byte.

Coordinates are metres, Y up, in the original procedural model's local frame. The export disables
Blender's axis conversion intentionally. Named empty objects are the moving pivots; material names
are the contract with `src/sim/kit/prototype.ts`. Exported materials only identify kit finishes.
The live sims assign the actual ceramic, dark titanium, gunmetal, polished steel, Carbon, glass and Lime.
The arm's elbow and wrist actuators and the rover's suspension have separate sleeve and rod frames.
`src/sim/kit/mechanism.ts` solves their attachment points from the live joints; it does not change
the authoritative kinematics or add another animation clock.

The mesh's download and the production meshopt decoder start at once, beside the page's own scripts
(`src/sim/kit/early.ts`, and a preload in each built device page), only in the live views that use
authored assets. Until the mesh is in, the device's procedural rig is built (it carries the device's
state) but kept out of view, and a small loading pill shows (`src/sim/kit/reveal.ts`, `loading.ts`);
the finished device then eases in. The procedural rig is shown instead only if the mesh fails or
is still missing after four seconds. Catalogue previews retain their lightweight procedural rigs.
The production decoder uses WebAssembly; `/sim/arm/`, `/sim/device/` and `/sim/humanoid/` permit
`'wasm-unsafe-eval'`. Trusted Types and the `obpal-templates` policy remain enforced everywhere.

`scripts/style-prototypes.mjs` writes regression evidence to a fresh temporary folder and prints
its path. Copy that folder's `loading/` and `stress.json` into the ignored review artifacts when
assembling the viewer; the tests themselves never write evidence into the repository.

The rollout uses `skins.ts` for explicitly named rigid appearance slots. These replace no control
objects. The procedural scene owns the wheels, rotors, lenses, fingers, instrument heads and keys,
and the `pov` camera anchors. Static authored details are joined with the kit by material after
loading, with texture-coordinate streams made compatible. Repeated marble-run channels use
instances so filling both boards does not multiply draw calls.

`scripts/rollout-proof.mjs` checks every sim with all seats active, delayed and failed optional
model loads, finite moving camera frames and full-scene render budgets. It uses the assigned
`OBPAL_E2E_PORT`, `OBPAL_E2E_WORKER_PORT` and `OBPAL_E2E_CHROMIUM` environment variables.
Its `stress.json` is written to a fresh temporary folder; copying it into the ignored rollout
review folder adds the active-scene measurements to the viewer.
