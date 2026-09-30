---
name: obpal-models
description: Author or revise ob.Pal Blender-scripted models, meshopt GLBs, LODs and pivot/clearance proofs within the relevant simulation budgets.
---

# Authored models

Read the simulation's plan and existing authoring/proof scripts first. If `docs/MODEL-STANDARD.md` exists, follow it; otherwise use the relevant plan, such as [HUMANOID.md](../../../docs/HUMANOID.md), without inventing global budgets. Obtain Blender from `BLENDER` or the brief; keep machine paths out of tracked source.

Retain reproducible sources under `assets/blender/`, sharing primitives/materials from `common.py`. Export raw GLBs to ignored evidence or a temporary folder, then use `assets/blender/compress.mjs <input> <model-name> [position-bits]` for meshopt compression. Its decoder check must pass. Preserve the runtime's named pivots, axes, rest transforms, joint limits and material conventions.

Build the required hero and distant LODs; keep pivot/animation contracts identical. Measure compressed bytes, triangles, draws, decoded textures and full-scene work against the simulation's budgets. Test cold, warm, failed and late loads, reveal behavior and LOD switching; a low polygon count alone does not prove a scene meets its frame budget.

Audit pivots against independent forward kinematics. Sweep the specified limits at both LODs for clearance and contact; retain pose counts, minimum clearances, tolerances and audit geometry. Do not loosen tolerances or hide intersections to make a pass. A sampled mesh audit establishes the sampled visual geometry, not manufacturing safety or simultaneous whole-body collision certification.

Render matched turntables, silhouettes and close-ups using existing render scripts, then compare actual desktop/phone browser views. Apply `obpal-evidence` for frame strips and performance proof. Keep evidence ignored. Author original assets or use permissively licensed material; record provenance and licence in `src/support/open-source.json` and retain the build scripts.
