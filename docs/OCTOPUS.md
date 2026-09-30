# Octopus bot: continuum motion and original design

Plan approved as `d80f27a`, with the owner/coordinator decisions recorded below.
Phase 6.1 supplies the tested continuum foundation against master `a02812f`;
it does not register a playable page, ship meshes or expose a hardware panel.
Dimensions, limits, material properties and timings are simulation defaults,
not measured hardware specifications. Each implementation phase needs
coordinator review and a merge. Physical-device performance remains unverified.

## What existing robots and biology establish

An octopus arm is a muscular hydrostat, not a chain of skeletal hinges.
Longitudinal contraction supplies shortening and asymmetric bending; transverse
contraction supplies elongation, and oblique muscle arrangements enable twisting.
Approximately conserved tissue volume couples length and thickness. Laschi and
colleagues translated parts of that arrangement into an artificial arm, rather
than reproducing every muscle. We should borrow continuous taper, distributed
actuation and coordinated primitives, not animate eight rigid human arms.
[Laschi et al., 2012](https://www.tandfonline.com/doi/abs/10.1163/156855312X626343)

| Existing work | Actuation, demonstrated repertoire and status | What ob.Pal can borrow |
| --- | --- | --- |
| Harvard Octobot, 2016 | Hydrogen peroxide produces gas; a soft microfluidic oscillator supplies pneumatic arm inflation. Autonomous, untethered soft-actuation **lab proof**, not a demonstrated crawling/swimming/manipulation robot; those behaviors were future work. [Harvard's original report](https://seas.harvard.edu/news/first-autonomous-entirely-soft-robot) | Alternating soft actuator groups and a visible mantle pulse. No chemical fuel model, navigation claim or copied shell. |
| EU OCTOPUS arms and eight-arm platform | The 2012 arm uses longitudinal cables and transverse shape-memory-alloy springs for bending, shortening and elongation in water. The 2015 platform separates grasping arms from motor/crank-driven compliant locomotion arms; it demonstrates underwater walking and grasping. These are **research prototypes**, not one universal pneumatic mechanism. [Arm paper](https://www.tandfonline.com/doi/abs/10.1163/156855312X626343), [2015 author manuscript](https://www.researchgate.net/publication/272825669_Bioinspired_locomotion_and_grasping_in_water_The_soft_eight-arm_OCTOPUS_robot) | Taper, compliant supports and attach–extend–release–recover actions. Keep SMA thermal behavior and the crank's specific geometry outside the default sim. |
| Festo OctopusGripper / TentacleGripper | A silicone air chamber bends inward; textile reinforcement limits expansion. Small distal suckers are passive, larger cups use vacuum. Wrapping, holding and releasing are demonstrated bionic/commercial **prototypes**, not an eight-arm walking product. [Festo's OctopusGripper account](https://www.festo.com/PDF_Flip/trends_in_automation/2_2017/HQ/html5/files/assets/common/downloads/trends%20in%20automation.pdf), [TentacleGripper](https://www.festo.com/ae/en/e/about-festo/research-and-development/bionic-learning-network/bionic-grippers-and-soft-robots/tentaclegripper-id_33321) | Separate bending from suction, paired underside cups and a restrained reinforced sleeve. Vacuum-gripper components are established industrial technology; this exact creature is not. |
| Tendon-driven continuum arms | Base actuators tension routed cables through an elastic backbone. Rucker/Webster experimentally compare straight and curved routing under external loads, with a Cosserat rod/string model. **Established research architecture with physical prototypes**, not proof of octopus-equivalent dexterity. [Original paper](https://doi.org/10.1109/TRO.2011.2160469) | Differential cable lengths, finite stroke and compliant settling; no independent hinge animation or invented measured tension. |
| Sensorized suckers and adhesive skins | Harvard/Beihang's tapered pneumatic arm combines bending and vacuum for diverse grasping; Frey/Bartlett's glove couples pneumatic adhesive membranes with proximity sensing and switchable underwater attachment. Both are **lab demonstrations**. [Harvard](https://seas.harvard.edu/news/tentacle-bot), [Frey et al., 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9278861/) | Approach, detect a seal, attach, load-limit and deliberately release. Adhesion depends on surface/contact conditions; proximity alone must never guarantee grip. |
| Deformable jet robot | Weymouth and colleagues test a water-filled flexible hull that rapidly deflates to propel an escape maneuver: **lab propulsion demonstration**, not the Octobot or the OCTOPUS crawler. [Author paper](https://arxiv.org/abs/1409.3984) | Mantle fill/ejection timing and trailing arms in a separate swimming mode, without copying its reported speed. |

Biological reaching propagates a localized bend from base toward tip; fetching
temporarily creates a quasi-articulated structure with three bending sites.
These are useful control primitives, not permanent anatomical elbows.
[Gutfreund et al., 1996](https://pmc.ncbi.nlm.nih.gov/articles/PMC6578955/),
[Sumbre et al., 2005](https://www.nature.com/articles/433595a)
Observed crawling can change travel direction independently of body orientation
and lacks an apparent fixed limb rhythm. Use contact-driven recruitment and
push-off by elongation; do not offer a fixed cyclic walking gait.
[Levy et al., 2015](https://pubmed.ncbi.nlm.nih.gov/25891406/)

## Motion representation and integration

Start with four piecewise-constant-curvature (PCC) sections per arm. This gives
32 sections with local bend components `kx, ky` (m⁻¹), length strain `e` and
optional limited twist `tau`; profile names are `L1…L4/R1…R4`, with named
sections, tendon routes and contact sites. Keep a continuum profile separate
from the humanoid `Chain` type, which currently assumes two links and landmark
indices. Share generic integration only behind unchanged humanoid regression
tests. [Webster/Jones' PCC formulation](https://doi.org/10.1177/0278364910368147)

Local +z follows the arm tangent; +x/+y span its cross-section. Concatenate
section transforms `exp([u,v] L)` with `u=(kx,ky,tau)` and `v=(0,0,1)`;
`L=L0(1+e)`. For zero twist, bend angle is `sqrt(kx²+ky²) L`. Use a series
expansion near zero curvature and parallel-transport frames to prevent normal
flips. Four circumferential tendon routes at radius `r` have approximate length
change `dL=L0 e+L r(kx sin(a)-ky cos(a))`. Fit curvature from bounded opposing
strokes; do not command negative tendon tension. Common shortening/extension is
a separate virtual muscle channel, not achievable by arbitrary cable pushing.
Use `r=r0/sqrt(1+e)` for volume-aware visual thickness. This is a reduced model;
PCC under load does not solve real cable friction, shear or material hysteresis.

Reuse the tendon layer's spring/damper approach in actuator coordinates, then
recover curvature and deform the skin. Fixed 120 Hz simulation with 240 Hz
elastic substeps, finite stroke/rate/strain limits and no per-frame allocations
are the starting policy. Proposed envelopes: section bend ≤75°, strain
−10…+15%, twist ≤20°; all live in profile data. Contacts apply bounded elastic
impulses. Selected-arm reach uses a damped Jacobian solve capped at six
iterations; unreachable targets visibly stop at the workspace boundary.

Reach moves a curvature packet distally while straightening behind it; fetch
builds a temporary elbow and distal grip. Crawl recruits support arms by travel
direction and contact state, then anchors, extends, peels and recovers. Climbing
requires **four distinct attached arms**, a full-rank anchor arrangement and a
1.5 load margin on every seal's combined normal/shear demand. Four is our
conservative support policy, not a biological universal: it permits planning a
replacement attachment while three other arms remain, but motion pauses until
four adequate supports exist again. Count alone cannot establish stability.
When support fails, gravity/buoyancy and dissipative collisions govern the body;
never pin it in space. Full rotational body/gait integration remains phase 6.2.
The support solver approves proposed movement loads; its refused allocation
does not delete the existing cups' physical spring forces. Losing the four-arm
planning margin cancels travel while the remaining real seals can still bear
their bounded load. Losing those seals permits a fall.

The same plane, box and cylindrical contact surfaces work at arbitrary angles
in air and water. Each declares grip; glass defaults high and rough stone lower.
Seal quality includes alignment and eight rim samples, so a cup can grip a face
near an edge but cannot invent a complete seal across a sharp corner. Pressure
builds over dwell; capacity is differential pressure times remaining sealed
area. Anchors are object-local, with finite spring/damper force, stretch,
pull-off and shear limits. Peeling removes circular area from the rim, and an
arm releases distal cups before proximal ones. Seals flatten/darken; the later
visual layer consumes `flatten`, `flash`, quality and force rather than guessing
attachment from distance. Broken seals require a fresh attach request.

A single water-volume/contact system covers walking, climbing, entering the
tank, jet swimming, diving, surfacing and underwater glass/object grip. A
continuous sphere-cap submerged fraction drives buoyancy and drag; multiplying
cap fractions at tank corners is an explicit approximation. A muscle-driven
spring/damper contracts the mantle, elastic recoil refills it, and outward
siphon flow generates bounded thrust. Refilling supplies no reverse jet, so
the body glides. Transverse fluid load supplies compliant trailing-arm targets.
Slow web sculling, support transitions and siphon/depth controllers are phase
6.2 work; this foundation is not CFD or a validated hydrodynamic robot model.

Input snapshots feed fixed ticks in sequence order. Arm IDs break contact ties;
replays use a fixed seed, never wall-clock randomness. A delayed frame consumes
at most eight ticks, then pauses motion rather than accumulating a burst.
Target toleranced replay equality at 30/60/120 Hz; no cross-browser bitwise claim.

## Control and place in the family

Default to `/sim/octopus/`, a quiet manipulation/travel studio using existing
scene, seats, capture, sound, panels and icon actions. Do not add it to humanoid
sparring until continuum contact and movement are proven. Two existing seats
can cooperate on an object; classical solo play requires no camera.

| Input | Low-dimensional intention |
| --- | --- |
| Hand | Index/middle/ring/little curls drive four mirrored arm pairs; thumb pinch requests attachment. Wrist orientation steers the selected group's reach plane. A four-segment arm-group rail selects paired, left, right or pinned-arm operation. Pinch is not a hardware deadman. |
| Body | Left/right wrist displacements steer two front leader arms; elbow flexion supplies curl, torso orientation steers the mantle. Other arms follow bounded grasp/support primitives. No mapping of eight arms onto eight imaginary human limbs. |
| Gamepad, tilt, trackpad | Existing locomotion intentions steer travel/yaw; trigger/primary action selects grasp, secondary releases, shoulders cycle groups. Thumbstick/trackpad reach stays available without capture. |

Priority is Stop → held manual override → selected capture → presets → idle.
Blend source changes over 150 ms; filter/gate incoming landmarks using the
capture foundation. Lost tracking cancels reach and movement, preserves a safe
sim attachment and settles; reacquisition needs fresh intention. Hardware holds
through its independent safety lane. Reuse BODY/HAND packets unchanged and their
late/generation rules; no octopus packet or extra landmark storage.

Presets: **Reach, Grasp, Fetch, Crawl, Climb, Swim, Dive, Surface, Cloak**.
Hand pinch attaches/releases the selected pair; squeeze pulses the mantle and
wrist orientation aims the siphon, including dive pitch. Classical triggers
jet and the stick steers. Climbable studio geometry includes a wall, pillar,
overhang, step and glass pane. A deep glass tank adjoins the land area and a
dive ledge; entry, bottom-walking, climbing out and underwater attachment share
the existing contact/medium state. Use one inexpensive water surface, floor
caustics, underwater tint/fog, sparse jet bubbles and an entry ring; reduced
motion calms effects. Cloak shifts graphite/obsidian tone and glass opacity slowly, with no ink,
particles, rainbow or reduced-contrast safety indicators. One moving element
demonstrates the selected action. Keep shared centred/icon controls and worded
Stop. Cup contact gets one quiet ring, a soft seating sound and optional haptics;
release is equally legible. Reduced motion disables decorative pulsing.

## Original model and owner concepts

Three built-in imagegen explorations are in
`artifacts/octopus/concepts/index.html`: **Cove** (organic pear mantle),
**Lattice** (open glass-ribbed actuator ring), **Veil** (flattened swimming sail).
Prompts/provenance remain beside them. These images select silhouette/material
direction; generated topology and tiny details are not engineering evidence.
No source robot photos, CAD or copyrighted meshes are imported.

Cove is approved. Script a 0.38×0.30 m mantle, 0.46 m total resting height,
with four overlapping chamfered **satin, low-gloss** obsidian plates around a
smoked-glass sensor belt. Borrow Lattice's visible dorsal tendon rails, keeping
the organic Cove silhouette. Eight roots on a 0.19 m radial collar
use bilateral ±22.5/67.5/112.5/157.5° headings. Arms are 0.88 m long at rest,
taper from 55 to 11 mm radius, with a soft proximal web and two modest dorsal
tendon sheaths. Two underside cup rows contain eight sites each, graded 18→6 mm
radius. Hide hard bearings inside elastomer; two lime signals only, at a mantle
seam and the glass core. Build surfaces from smooth superellipse rings, with
named root/section/sample frames and overlapping seams; avoid stacked balls.

Use `assets/blender/common.py` and the shared material kit. Each arm has 13
skinning sample frames, at most four weights per vertex; use a small mantle
deformation for pulses. Export meshopt GLBs with clean-load/reveal and both LODs.
Proposed budgets: hero ≤30k triangles, LOD ≤12k, compressed hero ≤1 MB, arena
≤10k; robot ≤36 draws, two-actor scene ≤90 draws/75k triangles. Cups instance
128 placements per bot; deform anchors with the same arm frames. At most two
mantle morph targets, ≤2k affected vertices, zero arm morph targets and zero
texture downloads. Procedural knit uses geometry/roughness, with mobile
clearcoat fallback. Original scripts/meshes are MIT and credited in
`src/support/open-source.json` when shipped; licensed papers are citations, not
asset grants. Concept rasters stay ignored review artifacts.

## Driver contract and safety

Plan a separate `ContinuumDriver`: `connect/profile/read/send/hold/close/onLost`,
with mandatory acknowledged `hold`. Profiles declare actuator kind/units
(tendon metres/newtons, pneumatic pascals), routing, calibrated limits, slew and
acceleration caps, pressure/vacuum limits, sensor freshness, release policy and
guardian capabilities. Reads report stroke, tension/pressure, valve state,
attachment and estimated shape with timestamps and uncertainty. Commands carry
named actuator targets, sequence/session, monotonic deadlines and leases.
Curvature remains an intention; a commissioned bridge owns conversion to
actuation. JointTrajectory is not silently treated as a pressure interface.

Fake tendon and pneumatic bridges only; no real endpoints or readiness claim.
Observe first, twin follows reports, then require verified mapping, full fresh
telemetry, bounded targets, reachable Stop, clear workspace and healthy guardian.
Start with existing timing policy: renew every 20 ms, lease 100 ms, feedback
age ≤100 ms, capture age ≤150 ms, hold acknowledgement ≤50 ms and local guardian
poll ≤5 ms. Stop latches; fresh release/press and hold verification rearm it.
Watchdogs must live outside the browser as well as inside the fake bridge.

Hazards include tendon snapback, entanglement, pinching, pressure rupture,
vacuum trapping and dropped loads. Apply stroke/tension/pressure/rate caps,
sampled arm capsules, cup break limits and an exclusion workspace. Hold is
profile-specific: tension/damp or isolate/regulate pressure, with retained suction
only when the declared load policy supports it. Blindly venting everything can
drop an object; trapping pressure indefinitely can also be unsafe. Unknown
failure/release behavior refuses live. Simulation limits are never substituted
for commissioned hardware limits.

## Phased implementation and acceptance

Every test writes evidence to a temporary folder, retained under
`artifacts/octopus/phase-6.x/`; no real robot tests. Budgets below are acceptance
targets, not measurements from this planning run.

| Phase | Files and work | Tests, acceptance and e2e suites |
| --- | --- | --- |
| 6.0 — approved plan | `docs/OCTOPUS.md`; three ignored concepts and index | Review primary citations, concept divergence/provenance and scope. No runtime change. |
| 6.1 — continuum foundation | New `src/sim/continuum/{profile,kinematics,tendons,contact}.ts`; `tests/continuum-*.test.ts`. Extract generic spring integration only if necessary. | Straight/zero-curvature limit, FK continuity, handedness, route/inverse, volume, stroke saturation, anchor break/release; deterministic 30–120 Hz replay ≤1e-6 and overshoot <3%. Existing humanoid/arm tests unchanged. `check`; sims regression if shared code moves. |
| 6.2 — playable studio | `sim/octopus/index.html`, `src/sim/octopus/{main,controls,rig,presets}.ts`, scoped styles, catalogue/route registration; `scripts/e2e-octopus.mjs` in sims. Contact-driven crawl/climb, IK, fetching, siphon/sculling/depth controls and land/water transitions compose the foundation. | Synthetic BODY/HAND and fake camera: every mapping and preset, arbitration/loss, Stop, seats, mirror, reduced motion, privacy. Reach error ≤2 cm on declared reachable targets; wall/overhang gait support and floor→wall→ledge transitions; water entry/dive/surface/climb-out without pops; no drift below limits and safe falls. Phone/desktop screenshots and source-labelled motion strips/plots. e2e sims, phone, catalogue, pages. |
| 6.3 — selected model | `assets/blender/octopus.py`, arena script, GLBs/LODs, kit manifest and credits | Eight roots, all frames/weights, normals, swept covers/cups, 64 px silhouette and 4K turntables; reveal/failure/late-load tests. Five-minute two-actor run: logic p95 <2 ms, measured total frame work <16.7 ms, geometry/draw budgets above. Physical mid-phone 60 fps, heat and latency remain unverified until device testing. e2e sims, pages. |
| 6.4 — fake actuation | `src/sim/octopus/{drivers,safety,live}.ts`, `hardware/octopus/README.md`, fake adapters and `scripts/e2e-octopus-live.mjs` | Full fault matrix: stale/missing sensors, overpressure/tension, bad map, clock/lease errors, lost page/bridge, stuck valve, broken seal, absent hold ack, load-release policy and fresh rearm. Fake watchdog hold ≤110 ms; assert capped commands and refused unknown profiles. e2e sims, shared, phone. |
| 6.5 — review and polish | Selected model/UI files, this plan, `docs/DEVICE-CHECKLIST.md` | Bounded visual/motion review, matched render/live evidence, contact/motion strips and repeated device-labelled budget sample. Coordinator merges/deploys; hardware commissioning is separately authorized. e2e sims, pages, phone. |

## Open decisions for the owner

All five are decided for this build (2026-09-30):

1. **Cove**, name included, with Lattice's visible tendon rails and a satin,
   low-gloss mantle. Cove is the owner's confirmed concept.
2. **`/sim/octopus/` studio first**; arena crossover later.
3. **Crawl, manipulate, climb, swim and dive in this build**, with functional
   underwater suckers and natural-motion mechanics throughout. This supersedes
   the plan's earlier deferred swimming scope.
4. **Paired-arm Hand control by default**; Body leader arms and classical play
   remain available.
5. **Tendon fake driver first**, then pneumatic; no real hardware.

## Phase 6.1 implementation and motion evidence

This is a clean foundation boundary, before playable phase 6.2. Six isolated
modules implement named profiles, exact PCC transforms, bounded routed
elasticity, pressure/contact/peel, primitive target generation and a common
medium. No arm/humanoid code, wire packet, capture storage or driver path changes.
The additional `primitives.ts` and `medium.ts` bring the owner's expanded
requirements into the foundation rather than building separate swim physics.

Natural-motion evidence distinguishes published equations, measured constraints
and designer choices:

| Primitive | Source and what is compared | Tolerance or deliberate limitation |
| --- | --- | --- |
| Reaching | [Gutfreund 1998, Eq. 1–3 and appendix EA.6/EA.10](https://pmc.ncbi.nlm.nih.gov/articles/PMC6793066/): force, tapered moving mass and drag. Sim midpoint integration is plotted against independently reconstructed RK4. | Position difference <0.5% of reference length; speed <2% of 0.47 m/s. The paper's 26 cm/8.5 mm/25 g cone and fitted `Cd=0.313` are the reference; 0.108 N muscle effort and freshwater density are our scenario. Withdrawal at 70% is the paper's explicitly arbitrary terminal example. Material-coordinate normalization supplies Cove's wave, not measured Cove mass/drag. |
| Ahead-of-bend excitation | Same study reports onset 200–300 ms and peak 50–100 ms before bend. Plot shaded published intervals against the sim excitation. | Peak 75 ms ahead; onset near 298 ms at the explicitly chosen 1.2% threshold. Gaussian width and stiffness gain are design choices. No digitized animal EMG fit. |
| Fetching | [Sumbre 2005](https://www.nature.com/articles/433595a), [2006](https://doi.org/10.1016/j.cub.2006.02.069): temporary elbow with roughly equal load-bearing segments. | Ratio 1 in the target helper; no published numerical tolerance claimed. The literature calls these proximal/medial, with a distal grasping hand; they are the two segments either side of the requested elbow. Full fetching controller remains 6.2. |
| Crawling | [Levy 2015](https://pubmed.ncbi.nlm.nih.gov/25891406/): direction-dependent recruitment and elongation, without an apparent fixed rhythm. | Plot recruitment versus travel direction. No quantitative published gait trace is available here; contact thresholds/tie-breaking are explicit robot choices. Whole-body crawl/climb gaits remain 6.2. |
| Jet cycle | [Renda 2015](https://journals.sagepub.com/doi/10.5772/60143): 35 ml/1.6 Hz physical robot, and a model case with `Tc=0.5 s`, `T=1.5 s`. | Reference capacity/frequency match those robot numbers; normalized contraction window uses the model's 1/3 ratio. These are separate reported cases, not an adult octopus's universal cycle. 35% expulsion, nozzle, force cap and elastic gains are design choices; no published volume-ratio data fit. |
| Seal and peel | [Tramacere 2013](https://pmc.ncbi.nlm.nih.gov/articles/PMC3672162/): rim seal, pressure differential and muscular release. Plot simulated pull-off against `ΔP × area`. | 18 kPa, 120 ms seal, 90 ms peel and 40 ms pressure response are sim choices. The cited biology supplies no universal timings; do not present the glove's sub-50 ms switching as animal timing. |
| Hydrostat/medium | Constant volume; pressure-area adhesion; neutral buoyancy and passive drag. | Radius follows `1/sqrt(1+strain)` exactly. Five-minute depth test has zero drift for the declared neutrally buoyant body. Tank-corner volume is approximate; no CFD/real-hardware validation. |

The reaching curve is driven by forces, not endpoint keyframes, pose lerps or
an imposed easing density. Routing then supplies elastic give. Elasticity uses
240 Hz substeps; the scalar bend ODE uses 960 Hz to resolve its terminal force
switch, while all public simulation advances remain fixed 120 Hz. The paper's
drag convention uses **bend speed**, despite distal material moving at twice
that speed in its momentum equation. Both factors were checked against its
MathML, not inferred from the figure alone.

`scripts/continuum-proof.mjs` writes source-labelled SVG plots, raw series, a
numerical FK strip and a five-minute two-actor **CPU core workload** to a fresh
temporary folder. Evidence is retained in `artifacts/octopus/motion/` and
`artifacts/octopus/phase-6.1/`. It is not an in-sim screenshot or a rendered
GPU/phone budget measurement. The original 1996 velocity figures were inspected;
their normalized time panels lack numerical ticks, and raw velocity/EMG traces
were not obtained. Quantitative fits to biological recordings remain
**unverified**; inspecting figures does not establish a numerical animal-data fit.
4K Cove renders, studio screenshots, the rendered performance run, functional
gait transitions, camera mappings and fake drivers remain phases 6.2–6.4 work.

Measured foundation acceptance (desktop, 2026-09-30):

| Check | Result and limits of the evidence |
| --- | --- |
| Typechecks and unit regressions | All four TypeScript configurations pass; 2,384 Vitest tests pass, 14 skip, including 75 new continuum cases. Existing arm/humanoid behavior and wire implementations are unchanged. |
| Presentation independence | Reaching, activation, routed pose and jet impulse replay identically at 30, 60 and 120 Hz with fixed 120 Hz physics. Elastic overshoot stays below the tested 3% bound. |
| Published bend-equation reconstruction | Maximum position error 0.00386% of reference length; speed error 0.0747% of the declared 0.47 m/s scale. Both pass their 0.5% / 2% tolerances. This compares integrators of published equations, not measured animal traces. |
| Jet scenario | One pulse integrates to 0.017105 N·s; minimum volume fraction 0.651906, then refill to 1. Reference robot frequency/capacity are 1.6 Hz / 35 ml. Expulsion and elastic coefficients remain explicit design choices. |
| Five-minute core workload | Two actors, 64 sections, 256 cups, 208 FK frames and two support allocators; 300.008 s, 17,529 presentation iterations and 35,998 fixed ticks. CPU work p50 0.397 ms, p95 0.846 ms, p99 1.240 ms, maximum 22.071 ms. The p95 <2 ms target passes; zero long-delay frames discard accumulated time. |
| Performance qualification | The first run missed p95 at 3.974 ms; an intermediate run reached 1.734 ms, with p99 8.100 ms and 95 long-delay pauses. Both are retained. The allocator now sums its wrench matrix analytically; the final workload exercises both actors' allocators. Measurements use wall time on a shared desktop, not rendered fps or an isolated causal speedup comparison. |
| Device and full-scene work | GPU/frame work, physical phone fps, heat, capture latency, Cove mesh budgets and complete crawl/climb/swim/dive transitions are **unverified** at this foundation boundary. |

Slow-effort reaches retain the ahead-of-bend stiffness wave through the force
equation's time-scaling relation; tests cover efforts 0.02, 1 and 4. Contact
requires all eight rim probes to remain on a sealable surface: an exposed edge
is a leak, not merely a smaller grip factor. A cup can attach near an edge on
either face when its rim closes, but cannot invent suction across a sharp corner.

The requested sims/pages/catalogue results and the Desktop guard are retained
with their full logs in `artifacts/octopus/phase-6.1/`. Final validation against
merged master `a02812f` passes pages 64/64 and catalogue 134/134; sims passes
398/399. The remaining humanoid-live fake-driver watchdog check observes
`Guardian status is stale` rather than the expected lease-expiry cause. Its
focused replay passes 20/22: that failure repeats, and a second check times out
waiting for guardian arm acknowledgement. The arm/humanoid implementations and
their assertions are unchanged relative to this master base. These regressions
remain unresolved; the foundation boundary is not an all-green release claim.
Every guarded run reports 19 test-browser lines before and 19 after, **no new
sessions**.

Earlier runs remain visible too: the initial sims run had one SCARA landscape
button-load timeout. Its isolated rerun passed SCARA but failed the unchanged
arm's phone re-anchor at 1.04 cm against a <1 cm bound and a kart button-load
timeout. Validation against `f9f5374` subsequently passed those checks but failed
sorting button centring. The final `a02812f` run passes those earlier failures;
no assertion was weakened. Phase 6.1 is complete as a dormant, tested continuum
foundation. Phases 6.2–6.4 and the inherited humanoid-live failures remain work
for their respective lanes.
