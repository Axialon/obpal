# Model standard: one family, explicit moving contracts

This is the authoring/review contract for future model waves, not a claim that current assets pass it.
F0 changes no mesh, finish, loader or Blender script. The baseline is private master
`8b3e6d0ed26afd05712b66fb5ec62c6dbb12796c`. Existing stricter executable tests take precedence;
new targets below require measured review before enforcement. Preserve [STYLE-3D](../spec/STYLE-3D.md),
[the authoring conventions](../assets/blender/README.md) and [common.py](../assets/blender/common.py).

## 1. Shape must explain the machine

Every model brief includes a dimensioned front/side drawing, black front/side/three-quarter silhouettes,
a mechanism diagram and the exact live profile it fits. Dimensions are metres; mark reference-derived values
with a source and mark invented values as simulation defaults. Keep distinct torso/limb proportions, head and
hand silhouettes for Keel, Morrow, Cairn, Rill and Hush, rather than scaling one shell uniformly.
Do not copy a recognisable commercial robot or entertainment character's skin. An openly documented joint
layout does not grant permission to copy its brand identity.

At 128-pixel thumbnail size, the tool, support footprint, moving linkage and primary direction should read
without emissive outlines. At 390-pixel phone width, fingers/feet, a gripper opening and meaningful joint gaps
must survive downsampling. Review against a neutral floor with shadows disabled as well as the actual studio:
a contact shadow cannot conceal a hovering sole. Check body/limb proportions against the profile, not a camera
perspective chosen to hide errors. Keep clear hierarchy: primary load-bearing forms, secondary guards/panels,
then small fasteners. Do not spend geometry on hidden screws while a hand remains an undifferentiated block.

A mechanism must have physical room for its motion. Render and check neutral, both limits of every independent
joint and the relevant combined poses (squat, folded elbow, overhead reach, grasp, mast tilt, suspension travel).
The existing humanoid clearance audit tests adjacent exterior shells through independent sweeps; it is not
proof of arbitrary simultaneous-pose clearance or a physical self-collision solver. Extend it where a wave adds
new combined poses. Clearance values used by authoring are construction margins, not manufacturing tolerances.

## 2. Edges and normals

The hard-surface starting idiom remains `common.py`: detail chamfer 0.5 mm, housing chamfer 2 mm, carbon seam
1.5 mm wide backed 1 mm, intentional planar facets and material batching within one rigid frame. The shared
STYLE-3D's 45-degree edge treatment, clipped corners, broad planar faces and flush ceramic insets remain valid.
Do not globally smooth every face into an inflated shell.

Use weighted corner normals only where they preserve the intended broad plane and bevel transition; split
normals across real hard edges. A modifier being present is not evidence of a correct result. Evaluate normals
after triangulation and compression: all values finite, sensible length, correct winding and no face/vertex-normal
inversion. Inspect grazing light from at least two directions. Curved elastomer, knit covers and bearing surfaces
may be smooth, but must not smear across a mechanical seam. Remove zero-area triangles and accidental duplicate
coplanar faces rather than relying on polygon offset. Thin parts need actual thickness or a deliberate audited
material policy, not a global double-sided workaround.

## 3. Material tiers and restrained lime

Material **names are a runtime contract** with [prototype.ts](../src/sim/kit/prototype.ts) and the humanoid
material code. Preserve legacy names and supply an explicit reviewed mapping for new finishes. The numbers
below are proposed authoring targets for the model waves, not an F0 runtime patch or measured material constants.

| Tier | Intended appearance | Proposed roughness / metalness | Restrictions |
| --- | --- | --- | --- |
| Obsidian shell | Near-black, readable faceted or controlled curved shell | 0.45-0.65 / 0.2-0.6 | No clearcoat by default; keep shape readable against the dark stage. |
| Graphite frame | Satin structural links and exposed joint covers | 0.5-0.7 / 0.45-0.8 | Use tonal separation from obsidian, not chrome glare. |
| Elastomer | Grips, soles, compliant sleeves | 0.8-1.0 / 0-0.05 | No clearcoat or glitter; subtle procedural microstructure only within budget. |
| Ceramic / machined metal | Existing flush panels and functional edges | Existing kit mapping; roughness generally >=0.35 | Retain original hard-surface family proportions; polish only a small functional feature. |
| Smoked cover | Face/sensor protection | Opaque dark finish preferred | No transmission/depth-sorting dependency for basic readability. |
| Lime | Functional state or tiny identifying detail | Existing family lime, sparse | No whole glowing limbs, extra status colours or decorative bloom. |

Use the family's existing lime (`#C6FF34` in STYLE-3D) through its established colour-management path, not a
second nearly matching green. Default target: lime occupies at most 2% of projected body area in a neutral
three-quarter view; label that as a design target, not a current measured ratio. Player/faction colours,
scientific traces and intentional instrument feedback retain their separate semantic roles.

The current hard-surface spec calls for roughly 65% metal, 20% ceramic and the remainder functional carbon/
other finishes. The humanoid scripts already have profile-specific finish families. Preserve those distinctions:
a low-gloss evolution is not permission to paint every sim black or silently supersede the whole material spec.
[humanoid_surfaces.py](../assets/blender/humanoid_surfaces.py) currently gives obsidian lower roughness and a
clearcoat lobe; reducing that is future H2 work with before/after captures. F0 does not claim it is already fixed.

No downloaded HDR environment, baked brand labels or uncredited texture. The texture-free procedural lighting
and finishes remain the default. Any texture exception requires explicit byte/memory measurement and provenance.

## 4. Pivots, axes and dynamics binding

The source profile owns coordinates and IDs. Author in metres, Y up, in the existing local frame; the current
Blender export deliberately disables automatic axis conversion. Never add an unreviewed root rotation or scale
correction to make one camera view look right. Existing local forward/POV conventions stay unchanged.

Each moving rigid link has one named empty/pivot, neutral translation, joint frame and parent. Preserve exact
existing names and hierarchy, including auxiliary sleeve/rod and finger frames. Humanoid anatomical IDs with
dots are mapped to underscores by [pivotName/modelPivots](../src/sim/humanoid/models.ts); use that mapping rather
than an ad hoc normalisation. Avoid duplicate names and implicit Blender numeric suffixes. Both LODs contain the
same complete moving frame graph, even when some geometry is simplified.

A continuous soft covering may instead be one skinned mesh at the asset root whose glTF skin joints are the
existing pivot nodes themselves. No bone, renamed node or extra transform enters the frame graph. The inverse bind
matrices are the pivots' rest translations, each vertex keeps at most four weights on the pivots it rides, and the
runtime rebinds the skin to the live pivots ([bindSuit](../src/sim/humanoid/models.ts)). The clearance audit blends
it at every audited pose as the GPU does, so it is not a merge across joints. The soft humanoids' knit suit (D2) is
the first; their heads, hands and shoes stay rigid on their pivots.

For a new model, give structural links stable IDs such as `forearm_shell` under the existing pivot. Do not rename
an existing consumer contract to match this example. Model schema version, profile ID, authoring source and unit
scale belong in a small reproducible manifest/metadata record added by the model wave. Keep transforms finite;
neutral scale is one and quaternion is identity where the existing validator requires it. Humanoid pivot tests
currently use 1e-5-scale tolerances: never loosen them merely to make a new mesh pass.

Physics mass/inertia and collision shapes belong to explicit profile/body data, not inferred decorative mesh
volume. A visible shell is not a collision mesh. Use bounded primitive/convex colliders for dynamics; document
centre of mass and inertia units, frame and provenance. A model swap rebinds visuals to the same body IDs and
never recreates physics or loses velocity/contact state. Motor targets, simulation poses, presentation snapshots
and hardware-reported joint positions remain different concepts. Render interpolation is read-only.

## 5. LOD and budgets

These are per-instance ceilings or targets, not sums silently multiplied by the actor count. Count actual
submitted triangles and calls for the whole frame, including shadows, outline/alpha passes and shared scenery.
Record compressed bytes and decoded memory separately. A cheap GLB download can still expand into a large draw.

| Asset class | Hero / far triangle target | Material batches | Compressed bytes | Existing contract to preserve |
| --- | --- | --- | --- | --- |
| New small device/arm skin | <=20k / <=8k | <=24 / <=12 | Target <=400 kB hero | Stricter per-asset tests and total scene budget win. Add LOD only when it actually helps. |
| Keel/Morrow | Existing tests require <25k / <10k | <50 | Existing ceiling <1.5 MB per file | Do not report a pass without decoded assets; target lower bytes where safe. |
| Soft humanoid forms | Preserve their own executable budgets; target <=25k / <10k | Target <=50 | Target <=1.5 MB | Do not weaken the soft-model tests; their actual thresholds govern. |
| Humanoid arena | Existing <15k | <10 | Existing <750 kB | Static arena has no automatic need for another LOD. |
| Complete scene | Target <=250k submitted triangles | Target <=150 calls | Only scene-required lazy loads | Measure two actors and phone path, not an isolated hero mesh. |

Humanoid numeric ceilings above are read from [humanoid-models.test.ts](../tests/humanoid-models.test.ts).
General scene/asset targets derive from STYLE-3D or are explicit new conservative review targets. They are not
fresh measurements. No textures is the default. An approved exceptional texture should normally be <=1024 square,
no more than one colour and one packed data image per asset, with a <=4 MiB combined decoded budget and a <=256 kB
compressed target. Larger formats need a stage-specific justification, not an automatic allowance.

LOD selection must be separate from simulation. Preserve existing humanoid 5.5/6.5 m hysteresis unless a measured
change is reviewed; add dwell/stable-frame switching only where absent and needed. New proposed policy: at least
0.5 seconds dwell plus a stable switch opportunity; use a measured cross-fade when silhouette change remains
visible. No surprise swap during a folded pose. Matching pivots alone is insufficient: hand/foot silhouettes,
closed joint sleeves and cover bounds must match. Test repeated threshold crossings, camera teleport, resize,
load failure and disposal. Preserve the landed hold/reveal behaviour while assets decode and shaders warm.

## 6. Authoring, compression and provenance

Use the existing headless Blender commands from the authoring README (its pinned Blender version is a repository
requirement, not independently installed here). Start with an empty scene and deterministic construction. Reuse
`common.py` rather than adding a second kit. Name every object before material merging, merge only within one
rigid frame and finish, and preserve moving empty objects. Do not merge across joints to reduce draw calls; a
skinned covering (section 4) is weighted to its joints, not merged across them.

Write intermediate exports/caches into ignored artifacts; compress with the existing `compress.mjs`, then decode
and run the actual asset tests. The current scripts use meshoptimizer and preserve more position precision for
machined humanoid details: do not lower precision globally to meet a byte target. Test normal/winding, bounds,
pivot identity, closed covers, byte and triangle counts after compression. Generated binary output must have a
reproducible source revision and command. Tests write to a temporary directory, never source folders.

Reuse rules follow [OPEN-REFERENCES](OPEN-REFERENCES.md). Physical facts/layouts may inform an original design
with citation. Copied/adapted files require an exact compatible licence, original attribution/NOTICE and a record
in `src/support/open-source.json`. NC, ND, conflicting share-alike and missing licences are excluded. A repository's
root licence does not clear all submodels, textures or linked CAD. Brand marks and character styling are not
licensed merely because surrounding code is open. F0 imports no external geometry or code and adds no credits.

## 7. A model is ready only with evidence

The review bundle includes source/pivot/provenance manifests; decoded asset tests; silhouette and detail sheets;
independent and combined-pose clearance; cold/slow/failed load behaviour; ten-second motion/orbit with per-part
coverage; repeated LOD/model switches; desktop and phone budgets; and unchanged controller/driver tests.
Use actual renders, not generated concept art, to prove production geometry. The existing humanoid proof/audit
scripts remain useful. The initial F0 rigid-submission helper is not a pixel-visibility proof for skinned or
instanced geometry; each model wave must close that coverage gap. Never promote `incomplete` to `pass`.
