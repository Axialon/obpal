# Prototype mesh sources

These scripts author original geometry from an empty Blender scene. They do not read reference models or images.
Blender 5.2.2 runs headlessly, with `BLENDER` pointing to its executable:

```powershell
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/drone.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/so101.py
& $env:BLENDER -b --factory-startup --python-exit-code 1 --python assets/blender/rover.py
```

`common.py` makes clipped component housings, tapered planar facets, metal-framed
ceramic insets, segmented guards and turned mechanisms. Detail chamfers are 0.5 mm;
housing chamfers are 2 mm. Insets have a 1.5 mm Carbon seam, backed 1 mm below the face.
Flat faces keep their own normals rather than becoming inflated smooth shells.
Each rigid frame is merged by material. `compress.mjs` compresses the exported streams with
meshoptimizer 1.1.1 (MIT), validates them by decoding, and writes `public/models/*.glb`.
Positions retain 18 bits of exponential precision; normals retain 12. No textures are needed.
Intermediate exports stay under ignored `artifacts/codex-style/authored/`.

Coordinates are metres, Y up, in the original procedural model's local frame. The export disables
Blender's axis conversion intentionally. Named empty objects are the moving pivots; material names
are the contract with `src/sim/kit/prototype.ts`. Exported materials only identify kit finishes.
The live sims assign the actual ceramic, dark titanium, gunmetal, polished steel, Carbon, glass and Lime.
The arm's elbow and wrist actuators and the rover's suspension have separate sleeve and rod frames.
`src/sim/kit/mechanism.ts` solves their attachment points from the live joints; it does not change
the authoritative kinematics or add another animation clock.

The loader and production meshopt decoder load after the procedural scene's first paint, only in
the live drone, SO-101 and rover views. Catalogue previews retain their lightweight procedural rigs.
The production decoder uses WebAssembly; only `/sim/arm/` and `/sim/device/` permit
`'wasm-unsafe-eval'`. Trusted Types and the `obpal-templates` policy remain enforced everywhere.

`scripts/style-prototypes.mjs` writes regression evidence to a fresh temporary folder and prints
its path. Copy that folder's `loading/` and `stress.json` into the ignored review artifacts when
assembling the viewer; the tests themselves never write evidence into the repository.
