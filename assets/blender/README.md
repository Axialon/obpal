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
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/humanoid_arena.py
```

`common.py` makes clipped component housings, tapered planar facets, metal-framed
ceramic insets, segmented guards and turned mechanisms. Detail chamfers are 0.5 mm;
housing chamfers are 2 mm. Insets have a 1.5 mm Carbon seam, backed 1 mm below the face.
Flat faces keep their own normals rather than becoming inflated smooth shells.
Each rigid frame is merged by material. `compress.mjs` compresses the exported streams with
meshoptimizer 1.1.1 (MIT), validates them by decoding, and writes `public/models/*.glb`.
Positions retain 18 bits of exponential precision; normals retain 12. No textures are needed.
Intermediate exports stay under ignored `artifacts/codex-style/authored/`.

`render_humanoids.py` produces the eight 3840×2160 turntable stills and the pair in
the arena under `artifacts/humanoid/phase-3/renders/`. Add `-- --draft` for 1280×720
iterations. These are original Cycles studio renders, with the same opaque kit
finishes as the runtime; no downloaded environment or textures are used.

Keel and Morrow retain the profile's complete pivot hierarchy at both LODs. A dot
in an anatomical joint ID becomes an underscore in glTF, whose animation binding
names exclude dots. `tests/humanoid-models.test.ts` compares every translation and
parent to the live profile, sweeps each joint through both limits and checks all
geometry, material, triangle and byte contracts. The lower LOD removes bearing
segments and service details. The live rig uses 5.5/6.5 m hysteresis and preserves
all angles during swaps. The arena has no separate LOD: its 4,972 triangles and
four draws already fit its 15k budget. These visual shells are not manufacturing
geometry or a physical self-collision model.

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
The production decoder uses WebAssembly; only `/sim/arm/` and `/sim/device/` permit
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
