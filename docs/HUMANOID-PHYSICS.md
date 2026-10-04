# F1a humanoid dynamics: implementation and acceptance contract

Status: measured F1a2 candidate, **not accepted**; isolated from production practice/seats.
The 2026-10-03 F1a2 stance gates pass; anatomy and authored-rendering gates remain red.
Section 5 retains the historical 2026-10-02 F1a failures; section 7 records F1a2.
F1b/F1c are continuation work, not completed features. The 2026-10-01 F1 TASK releases Rapier development after the coordinator's
F0-R selection; older gated/provisional paragraphs elsewhere are historical records.
No existing engine-selection measurement is claimed as this pilot's acceptance.
Sections 1-6 describe the original F1a implementation and its recorded follow-ups.
Section 7 supersedes their motor-prediction, stance-control and acceptance status
for the current F1a2 candidate; geometry, frames, effort caps and gates are retained.

## 1. Geometry, mass and collision model

`src/sim/humanoid/physics/model.ts` version `humanoid-f1a-v1` builds Keel, Morrow and
Cairn I/II, Rill I/II, Hush I/II from their existing original profiles. It does not
change `robotRoster` gating. Each actor has 16 dynamic uniform-box collision bodies
and 15 spherical impulse joints. The pelvis is free in translation and orientation.
The floor is static. A second actor is not implemented by creating two separate
pilots: F1b requires both actors and one arena in the **same** native world.

| Body, per occurrence | Count | Original simulation mass (kg) |
| --- | ---: | ---: |
| Pelvis | 1 | 10 |
| Lumbar, at the existing spine metal skin | 1 | 3 |
| Thorax | 1 | 12 |
| Head | 1 | 3.5 |
| Upper arm / forearm / hand | 2 each | 2.5 / 1.5 / 0.7 |
| Thigh / shin / foot | 2 each | 6 / 3.5 / 1.3 |

Total robot mass is 59.5 kg for each form. Dimensions/skin offsets and independent
axis limits come from the existing ob.Pal profile; masses are **not** G1, Berkeley,
ToddlerBot or hardware measurements. No density or torque is silently rescaled to
make a different form stand. Half-extents a,b,c in metres imply the uniform-box
local diagonal inertia `m/3 * (b*b+c*c, a*a+c*c, a*a+b*b)` in kg m². Shape masses are
also passed to Rapier, whose native inertia is computed from that shape. The source
records its analytic diagonal in `model.parts`; it is not measured native inertia.
The generic servo utility also has `2*m*r*r/5` for a uniform sphere; F1a robot links
are boxes, not spheres. Fixed fixture parents contribute zero inverse inertia.

The first existing non-axle shell/trim/metal primitive at a link supplies the box;
this is a collision approximation, **not** a tight union of every authored surface.
No new mesh/GLB, simplified replacement skin, CAD, texture or font is shipped.
The complete original skins and both authored LODs are reused by the renderer.
An exterior-clearance or authored-mesh contact claim still needs the actual model
proof: the 5 mm angular surface-error proxy below does not provide it.

Connected parent/child pairs alone have native contact disabled because their
bearing envelopes meet. Other self-pairs and floor contacts remain enabled. There
are no all-self-collision exclusions, pelvis pins, animated height writes, CCD,
compound colliders or invented support samples. Box-only collision, compliant
angular stops and maximal-coordinate joints are explicit limitations. Existing
F0 world position/force/velocity bounds still apply. These bounds prevent runaway
state but do not establish a two-actor energy budget or recovery behaviour.

Initial placement composes each joint's commanded clear-arm pose recursively so
its two anchors coincide. Both arms abduct 20 degrees to separate neutral hands
from the wider hip boxes. The entire robot is released with its lowest sole 2 mm
above the floor **once at initialisation**. This is not a resting-height constraint.
Initial velocity is zero; gravity uses the F0 default (0,-9.81,0) m/s². The extra
lower spine anchor is 0.035*(profile height/1.8) metres above the authored pelvis
pivot; the 1.8 m value is the original profile's scale reference. The lumbar box
uses the existing `spine.yaw` metal skin rather than a newly invented visual body.

## 2. Frames, target cones and effort

World is metres, +Y up. Quaternion order is x,y,z,w. Body translations denote box
centres of mass. Anchors are body-local metres. Both joint-frame quaternions are
explicit. The common cone's twist axis is +X: an anatomical +Y twist uses a +pi/2
rotation about Z; negative-X knees use a pi rotation about Y. The profile's signed
left/right axes are applied before mapping into this frame. Elbow/knee endpoints
remain one-sided. The additional `swingYMin`/`swingZMin` are negative radii, absent
for existing symmetric fixtures. Each independent positive/negative endpoint is
retained; simultaneous swing is constrained to the signed ellipse, a conservative
choice rather than the profile's independent-axis rectangular product.

Two physical spine joints each receive half the source spine rotation vector and
half the independent axis limits. Head/neck, shoulder, elbow, wrist, hip, knee and
ankle retain explicit links and limits. This distribution is an original simulation
model, not a physiological spine or a particular robot transmission model.
Nominally locked swing components use +/-0.001 rad for the existing compliant
cone's nonzero-radius requirement. They are not hard native hinge constraints.

| Joint group | Maximum torque (N m) | Stiffness (N m/rad) | Damping (N m s/rad) |
| --- | ---: | ---: | ---: |
| Each spine joint | 200 | 1,200 | 50 |
| Neck/head | 20 | 120 | 8 |
| Shoulder | 70 | 300 | 18 |
| Elbow | 45 | 220 | 14 |
| Wrist | 12 | 60 | 4 |
| Hip | 120 | 800 | 40 |
| Knee | 160 | 1,000 | 45 |
| Ankle | 90 | 800 | 30 |

Every number in this table is an **original uncalibrated simulation default**.
The module documents no manufacturer rating or hardware torque permission. All
links use restitution 0, coefficient of friction 0.8 and linear/angular damping
0.02 s⁻¹. Floor friction is 0.8 and restitution 0. Existing geometric-mean friction
combination and minimum restitution rules are unchanged.

F1a opts into `integration: 'inertia-damped'`. The legacy F0 bounded controller is
unchanged when this field is absent. Per world axis, this option approximates an
implicit free-body PD step:

`torque = (K*error - (D+K*dt)*relativeVelocity) / (1+inverseInertia*(D*dt+K*dt*dt))`.

That per-axis expression describes Astra's initial implementation. The measured
return corrects it to a full tensor solve: `A` is the sum of the two rotated inverse
uniform-body inertia tensors, with fixed bodies contributing zero, and
`torque = (I + A*(D*dt + K*dt*dt))^-1 * (K*error - (D + K*dt)*relativeVelocity)`.
The discarded off-diagonal terms made the old response depend on world orientation;
a regression rotates an anisotropic link and its entire command together.

Motor and active stop now share that implicit step and one final effort cap. The
stop retains 1,200 N m/rad and 30 N m s/rad: its correction axis `n` adds rank-one
stiffness `1200*n*n^T` and outward-only damping `30*n*n^T`. Cholesky plus a
Sherman-Morrison update solves the combined three-axis step. Previously, independently
solving and adding motor and stop torques spent the same inertia twice; a tiny-link
regression reproduces the resulting damping reversal. The corrected native Morrow
twist trial completes all 480 ticks instead of faulting at tick 147.
The directional update is `I + (d*I + c*n*n^T)*A`, with `d=D*dt+K*dt*dt`
and `c=stopDamping*dt+1200*dt*dt`: the stop acts on the resulting angular velocity.
The inverse-inertia and directional matrices do not commute for anisotropic links.
A regression checks the combined motor/stop force balance after the implied free-body
velocity step, independently of the matrix solve.

**This is still free-body inertia, not coupled articulated/contact effective mass
or stable balance.** Contact constraints may change effective inertia substantially;
native results, not the formula, decide acceptance. All original masses, shapes,
limits, gains, stop constants and effort caps remain as declared. The opt-in's
diagnostics report total motor/stop effort. Existing default controller behaviour remains
unchanged. PhysX's native-drive adapter rejects this option; it does not silently
pretend to implement it. This candidate selects no alternative engine.

## 3. Native contacts and observations

F1a explicitly requests 16 solver iterations, 0.0002 m allowed linear error and
0.001 m prediction distance. These are original simulation tuning defaults; not a
claim that actual penetration is 0.2 mm. The schema accepts iterations 1..32,
allowed error 0.00001..0.005 m and prediction distance 0.00001..0.01 m. Unsupported
backends reject the request before allocation instead of ignoring it.

The wrapper copies each unordered Rapier collider pair once. It handles the native
`flipped` flag, transforms both local contact points to world, and returns the
normal acting on B from A, separation in metres and impulse in N s. No native
manifold/view escapes its synchronous callback. Every sample is validated and
owned. The 256-sample budget rejects overflow rather than inventing a truncated
support polygon. Inputs outside existing world bounds fault the session.
Rapier's nullable local-point getter means the requested native contact point is
unavailable; it does not mean the body origin, a zero-force contact, or separation
from the floor. Empty manifolds contribute no samples. A missing point for an index
inside `numContacts()` faults the observation rather than fabricating or omitting
support. This resolves the original two typecheck errors without assertions.

Observation foot height comes from **all four rotated bottom box corners**, not
body-centre height. Support comes only from native foot/floor manifolds with an
upward normal component >=0.5 (60-degree observation envelope) and separation
within the configured prediction distance. A foot must have positive net upward
normal impulse. Its zero-pressure native manifold points still bound the footprint;
an entirely unloaded foot contributes nothing. The world-XZ convex hull and signed
COM margin are calculated from those copied contact points. Fewer than three hull
points gives a null margin, not false support. A 1e-8 m duplicate-point tolerance
is numerical bookkeeping, not a floor/foot threshold. No ankle/hip/step balance
controller is implemented by this observation calculation.

API references for these choices are the official
[World contact callbacks](https://rapier.rs/javascript3d/classes/World.html),
[TempContactManifold](https://rapier.rs/javascript3d/classes/TempContactManifold.html)
and [IntegrationParameters](https://rapier.rs/javascript3d/classes/IntegrationParameters.html),
read on 2026-10-01. The pinned compat package and actual `version()` printed by the
verifier take precedence over a moving documentation URL. References and licence
boundaries remain in [OPEN-REFERENCES.md](OPEN-REFERENCES.md); no reference parameter
or code file is vendored here.

## 4. Proofs the coordinator runs

The Node table kind is `humanoid-f1a-native`, one row/report per all eight forms.
The separate `humanoid-f1a-contact-probe` checks native normal orientation, floor
points, positive load, owned copies and disposal. No native test is skipped.

- **Stance:** all 7,200 fixed ticks / 30 seconds; every sole corner's penetration
  and hover <=5 mm throughout. Record foot-centre XZ slip in mm after 2 seconds,
  all 6,720 settled support margins, anchors, actual cone violation/torque and
  root uprightness. Original stance classifiers require pelvis >=90% of initial
  height and up-axis Y>=0.98; these do not classify get-up or recovery. Slip is
  reported without inventing a programme slip threshold. Max anchor error and
  angular surface-travel proxy must each be <=5 mm, cone overshoot <=0.01 rad,
  effort <=declared cap, with no dropped time or invalid frame.
- **Anatomy:** seven simultaneous whole-humanoid zero-gravity pose trials with
  free pelvis, plus six signed endpoints for each of 15 native joints. Endpoint
  trials use the same two link shapes/masses/frames/limits, fixing only their
  fixture parent to isolate mechanical range from obstruction by other limbs.
  These are **not** 90 fully posed standing humanoids. Every trial runs 480 ticks
  / 2 seconds. Report actual twist/swing minima/maxima, anchor drift, cap usage
  and measured final tracking error. The original 0.08 rad tracking threshold
  is not an allowed cone overshoot; <=0.01 rad and <=5 mm still apply separately.
  Seven target names are T, squat, lunge, overhead, highKick, twist and crouchGuard;
  the exact original degree tables live in `canonicalPoses`, converted to radians.
  Zero gravity is expressly not evidence of supported squat/kick or recovery.
- **Replay:** 480 completed ticks, same model and engine, with saved accepted
  actions delivered under 60/30/120 Hz render partitions. Compare position,
  quaternion, linear and angular velocity errors against 1e-6 in their SI units.
  The <=1e-8 effort-ratio epsilon and action 1e-10 rad slew epsilon are numerical
  comparison tolerances, not extra motor permission. Quaternion normalisation
  and vector limits retain the foundation's numerical guards.

Wall time per tick includes observation, actuation and journal work; it is **not**
process CPU time. JSON emits errors/incomplete counts before assertions. A failed
stance still allows anatomy/replay to report, rather than losing all evidence.
No proxy proves authored exterior crossings, collision mesh fidelity, reach under
load, phone BODY latency, recovery, two-actor physics or real-device performance.

The `humanoid-physics` browser group builds a verifier-only in-memory entry with
existing Vite and serves it through Playwright interception on the guarded local
origin. It starts no extra port, writes no product route and blocks nonlocal
requests. Only existing model GLBs may pass to the local stand-in. It runs eight
forms in 1280x800 desktop and 412x915 narrow emulation at 4x CPU throttling; this is
not a physical phone. Keel adds explicit 5,000 ms slow loads and 503 failed loads.
Each row is bounded to 180 seconds; model readiness has a 25-second budget and
400 ms settling window. These are evidence budgets, not product timeout changes.

Each row measures ten real seconds of native arm motion plus orbit, actual joint-relative movement (not whole-root rotation),
16 body-bearing pivot submissions, UUID/geometry stability, full-frame alpha
coverage/hashes, calls/triangles, p95/p99 frame and tick wall time and dropped time.
The existing authored LOD is kept inside its near-orbit interval; this does **not**
certify transitions or add a blanket transition allowlist. It uses antialiasing,
pixel ratio 1 and preserveDrawingBuffer, with a full-frame pixel snapshot every
30 frames. Each snapshot is queued into its own WebGL2 pixel-pack buffer, polled
with a zero-timeout fence, copied and hashed. Animation never awaits evidence;
all captures are verified after the ten-second window. Queue/copy/alpha-count
work still affects actual animation intervals. Fence/copy and native hash wait
latencies are reported separately from frame stages and physics advance work;
neither is labelled CPU time. Frame stages record callback dispatch lag,
observation, rig preparation, rendering and submission audit. A separate physics
update trace records every actual timestamp/interval, target and advance work,
step/tick counts and cumulative dropped time.
Unavailable buffers/fences, context loss, missing captures or capture errors fail
the ordinary harness. The fence has a bounded five-second evidence budget; no
physics clock limit changes. The WebGL2 contracts are documented in
[clientWaitSync](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/clientWaitSync)
and [getBufferSubData](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/getBufferSubData).
Full-scene p95<=16.7 ms/p99<=25 ms are still
F1b/F1c release gates, not waived by this one-actor report.

Desktop cold runs render the seven dynamic zero-gravity poses at each existing
LOD at the same camera scale. Full-size PNGs stay in TEMP until verified distillation;
numerical JSON, keyframes and eight 1120x240 contact sheets stay in ignored review
evidence. The contact sheets also travel automatically as base64 PNG/hash fields
in `humanoid-f1a-browser` JSON (maximum 200,000 encoded characters per sheet).
They are model evidence generated by the verifier, not new authored assets. A
nonempty image or all part submissions is **not** a no-crossing/per-part pixel
proof. The independent-axis clearance audit remains unchanged. Simultaneous
exterior checking, actual sweep sheets and intentional LOD transition proof must
be completed before full F1 release.

Keel, Morrow and Cairn-I additionally run the complete 7,200-tick gravity stance.
Seven actual states per form include release, 1 and 2 seconds, penetration,
maximum corner height, maximum displacement and 30 seconds. Three 1680x240 strips
use a fixed world camera, floor grid and measured lower-face corner guides; these
are verifier guides, not replacement skins. The run has 133 raw PNGs in TEMP
(112 pose/LOD frames plus 21 stance frames) and retains all three strips, exact
extremum witnesses and a verified persisted JSON report after distillation.

## 5. Measured F1a return and pending-acceptance follow-up

The first return on 2026-10-02 merged master `1c4d0ee` once, first, as its brief explicitly required.
The model remains `humanoid-f1a-v1`; Rapier compat/native both report 0.21.0. These
are Windows x64 Node 22.23.1 measurements, not hardware robot or physical-phone
measurements. Browser proof uses Playwright Chromium 152.0.7977.8, DPR 1, 1280x800
desktop and 412x915 narrow emulation at 4x CPU. Native check overlapped resumed
browser suites; the final isolated humanoid browser group ran afterwards. Wall-time
figures are diagnostic, not isolated CPU benchmarks.
The pending-gate follow-up re-measured all eight forms after merging master
`fd025b3`: physical extrema below are unchanged, and native wall-time columns now
use that complete green check. Workstation load was not controlled.

**All eight forms fail physical F1a acceptance.** Every stance completes exactly
7,200 ticks / 30 simulated seconds, every anatomy trial completes 480 ticks, and every replay completes
480 ticks under 60/30/120 Hz partitions. Stance penetration/hover include every
sole corner throughout 30 seconds; slip starts after two seconds. No acceptance
tolerance, effort cap, clock budget, collision exclusion or production mode changed.

| Form | Ticks | Sole penetration / hover mm | Slip mm | Supported / settled | Anchor mm | Cone rad | Surface mm | Min pelvis m / up Y | Anatomy pass / 97 | Replay |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- |
| keel-v1 | 7200 | 5.852 / 335.465 | 464.006 | 0 / 6720 | 0.107 | 1.01871 | 316.594 | 0.104 / -0.001 | 80 | pass |
| morrow-v1 | 7200 | 5.585 / 306.691 | 464.443 | 0 / 6720 | 0.061 | 1.01371 | 254.754 | 0.096 / -0.001 | 86 | pass |
| cairn-i-v1 | 7200 | 5.834 / 322.925 | 484.179 | 0 / 6720 | 0.057 | 1.01559 | 284.922 | 0.101 / -0.011 | 82 | pass |
| cairn-ii-v1 | 7200 | 5.852 / 335.465 | 464.006 | 0 / 6720 | 0.107 | 1.01871 | 316.594 | 0.104 / -0.001 | 80 | pass |
| rill-i-v1 | 7200 | 5.834 / 322.925 | 484.179 | 0 / 6720 | 0.057 | 1.01559 | 284.922 | 0.101 / -0.011 | 82 | pass |
| rill-ii-v1 | 7200 | 5.852 / 335.465 | 464.006 | 0 / 6720 | 0.107 | 1.01871 | 316.594 | 0.104 / -0.001 | 80 | pass |
| hush-i-v1 | 7200 | 5.834 / 322.925 | 484.179 | 0 / 6720 | 0.057 | 1.01559 | 284.922 | 0.101 / -0.011 | 82 | pass |
| hush-ii-v1 | 7200 | 5.852 / 335.465 | 464.006 | 0 / 6720 | 0.107 | 1.01871 | 316.594 | 0.104 / -0.001 | 80 | pass |

Anatomy ranges below aggregate **measured** extrema across all 97 trials and all
sampled joints; they are not a particular joint's limits. Per-joint signed extrema
and each trial's failures remain in native JSON. The quaternion column is maximum
physical shortest-arc travel per fixed tick over stance/anatomy, not raw signed
component subtraction. At 120 Hz replay also negates every accepted target quaternion;
positions/velocities match exactly and rotation error is below 1e-15 rad. All native
frames remain finite; dropped time and invalid frame counts are zero. Maximum effort
ratios are <=1+1e-8. Every form retains all 6,720 settled support margins, including nulls.

| Form | Actual twist min / max rad | Swing Y min / max rad | Swing Z min / max rad | Anatomy cone rad / surface mm | Final error rad | Max quaternion step rad | Tick p95 / p99 ms |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| keel-v1 | -1.571 / 2.444 | -2.445 / 1.398 | -1.992 / 1.992 | 0.30035 / 86.660 | 0.18617 | 0.12986 | 1.333 / 2.196 |
| morrow-v1 | -1.571 / 2.276 | -2.370 / 1.398 | -1.985 / 1.985 | 0.29756 / 78.699 | 0.21785 | 0.09748 | 0.670 / 0.883 |
| cairn-i-v1 | -1.571 / 2.444 | -2.445 / 1.398 | -1.990 / 1.990 | 0.29427 / 81.603 | 0.19298 | 0.12355 | 0.660 / 0.834 |
| cairn-ii-v1 | -1.571 / 2.444 | -2.445 / 1.398 | -1.992 / 1.992 | 0.30035 / 86.660 | 0.18617 | 0.12986 | 0.546 / 0.825 |
| rill-i-v1 | -1.571 / 2.444 | -2.445 / 1.398 | -1.990 / 1.990 | 0.29427 / 81.603 | 0.19298 | 0.12355 | 0.543 / 0.791 |
| rill-ii-v1 | -1.571 / 2.444 | -2.445 / 1.398 | -1.992 / 1.992 | 0.30035 / 86.660 | 0.18617 | 0.12986 | 0.536 / 0.801 |
| hush-i-v1 | -1.571 / 2.444 | -2.445 / 1.398 | -1.990 / 1.990 | 0.29427 / 81.603 | 0.19298 | 0.12355 | 0.591 / 0.810 |
| hush-ii-v1 | -1.571 / 2.444 | -2.445 / 1.398 | -1.992 / 1.992 | 0.30035 / 86.660 | 0.18617 | 0.12986 | 0.643 / 0.826 |

Two native defects were corrected before these measurements. A nullable Rapier
contact point means unavailable native contact data, not a point at the body origin
or a zero-force contact. An unavailable point inside the reported contact count now
faults observation explicitly; empty manifolds still produce no samples. The servo
now retains the full rotated inverse-inertia tensor and solves motor and directional
stop together. The earlier diagonal approximation depended on world orientation;
separate motor/stop solves spent the same inertia twice and could reverse damping
on small links. Covariance, tiny-link damping and independent implicit force-balance
regressions pass. The declared gains, stop stiffness/damping and effort caps remain
unchanged. This remains a free-body approximation, not an articulated/contact solver.

The stance failure is physical: pelvis height collapses and neither sole stays
within 5 mm. A linear upright diagnostic gives total effective ankle pitch
stiffness 87.25/95.40/102.77 N m/rad for Morrow/I/II-height forms, versus rigid-lean
gravity slopes 441.88/463.30/482.05 N m/rad. This is an inference about the weak
free-inertia servo response, not a coupled contact stability proof. Increasing
solver iterations cannot supply missing restoring control. F1b must reconcile
articulation/contact effective inertia, measured support and bounded ankle/hip
targets, and retain the same 30-second/5 mm gate. Anatomy additionally needs a
stop/constraint and collision-model reconciliation: completing a pose is insufficient
when its measured cone/surface errors are above 0.01 rad/5 mm. No balance controller,
model shrinkage or root correction was added in this return.

Browser root causes and retained failures:

- The verifier-only build needed master's existing `markupBuild` plugin for the
  transitive `virtual:obpal-templates` import. It now uses the real plugin.
- Submissions are attributed to their actual physics body via `model.frames`;
  missing body IDs and individual motion failure reasons are reported explicitly.
  The original authored GLBs have **empty `spine_yaw` nodes** at both LODs. Only
  15 bodies have authored skin submissions, while the procedural fallback has 16.
  The lumbar requirement remains red; it was not removed from the audit or satisfied
  by counting a descendant thorax as a lumbar skin. Reconcile this binding with the
  existing authored skin in F1c's clean-rendering work before claiming 16-body proof.
- Full alpha readback remains instrumented; SHA-256 now uses native Web Crypto
  instead of hashing every RGBA value in JavaScript. Narrow clock loss remains a
  failure; neither the fixed-step cap nor the dropped-time assertion changed.
- Evidence now uses the repository's TEMP raw-run/distillation contract, retaining
  eight pose/LOD sheets, numerical JSON, frame hashes and selected keyframes in the
  ignored review folder. Nonempty pixels still do not prove absence of crossings.

The first return's final isolated `OBPAL_E2E_SIMS_ONLY=humanoid-physics` run completes both checks
with **1/2 passing**. All 18 browser rows execute, all loading checks pass, and all
112 pose/LOD captures complete 480 ticks; eight sheets are retained. There are no
browser exceptions. Only the failed-load procedural fallback passes its complete
row (**1/18**); every authored row reports missing `seat1_lumbar` submissions.
Keel and Morrow additionally lose narrow clock time. Cold-row timing is below;
raw sample counts, median, maximum and coverage hashes remain in browser JSON.

| Form | Desktop frame p95 / p99 ms | Narrow frame p95 / p99 ms | Desktop tick p95 / p99 ms | Narrow tick p95 / p99 ms | Clock drop desktop / narrow s |
| --- | --- | --- | --- | --- | --- |
| keel-v1 | 16.800 / 16.900 | 83.500 / 116.700 | 1.362 / 2.225 | 6.367 / 7.958 | 0.000000 / 1.919100 |
| morrow-v1 | 16.900 / 16.900 | 50.000 / 66.700 | 1.500 / 2.400 | 4.313 / 5.308 | 0.000000 / 0.151300 |
| cairn-i-v1 | 16.900 / 16.900 | 16.900 / 17.000 | 1.650 / 2.500 | 2.600 / 3.125 | 0.000000 / 0.000000 |
| cairn-ii-v1 | 16.900 / 16.900 | 16.900 / 17.000 | 1.600 / 2.300 | 2.125 / 2.300 | 0.000000 / 0.000000 |
| rill-i-v1 | 16.900 / 17.000 | 16.900 / 17.000 | 1.820 / 2.500 | 2.300 / 2.633 | 0.000000 / 0.000000 |
| rill-ii-v1 | 16.900 / 17.000 | 16.900 / 16.900 | 1.750 / 2.400 | 2.325 / 2.750 | 0.000000 / 0.000000 |
| hush-i-v1 | 16.900 / 16.900 | 16.900 / 17.000 | 1.980 / 2.525 | 3.300 / 3.600 | 0.000000 / 0.000000 |
| hush-ii-v1 | 16.900 / 16.900 | 16.900 / 17.000 | 0.975 / 1.675 | 2.350 / 2.700 | 0.000000 / 0.000000 |

That first-return complete sims run also reports clock loss on some other rows. Both reports
are retained; timing variability does not waive the zero-dropped-time assertion.
The first-return validation used the original mixed launch defaults with
`OBPAL_E2E_GPU` unset; an unset flag does not prove every browser used software
rendering. A launch that inherited a different GPU flag was stopped
and excluded before interpreting results. The pending-acceptance follow-up uses
the newly merged master's GPU lease/probe/fallback contract; neither run claims
physical-phone performance.

The earlier catalogue 31/31 exit was a separate `phone()` connection wait timing
out after the drone checks, before later devices ran; it was not a reporter error
or the F1a script (catalogue does not import that script). The merged-master return
passes catalogue **134/134 with exit 0** and phone **189/189**, including all three
previously failing Pixel 7 checks and their iPhone 13 counterparts in emulation.

The first return's `pnpm run suites -- master` selected all twelve suites below. The service interruption
occurred after code/embed/home completed; the remaining nine suites were resumed.
The final physical implementation is `1e17bca`; no source changed after its check
and final browser measurements. Master advanced afterwards without a merge conflict,
so it was not merged again. The brief's merge-first order overrides the lane's usual
merge-immediately-before-validation order; no acceptance gate was overridden.

| First-return validation (before pending-gate follow-up) | Passing / executed | Result |
| --- | --- | --- |
| `pnpm run check`: four TypeScript configurations | 4 / 4 | pass |
| `pnpm run check`: Vitest | 3412 / 3420; 14 skipped | eight native F1a acceptance failures |
| code | 19 / 19 | pass |
| embed | 19 / 19 | pass |
| home | 35 / 36 | 4x CPU frame p95 33.4 ms exceeds 20 ms |
| phone | 189 / 189 | pass |
| sims | 504 / 506 | F1a browser proof and pendulum frame-gap failures |
| shared | 31 / 32 | demotion 1034 ms exceeds 300 ms |
| extension | 29 / 29 | pass |
| camera | 20 / 20 | pass |
| catalogue | 134 / 134 | pass |
| contact | 41 / 41 | pass |
| orientation | 146 / 146 | pass |
| pages | 137 / 137 | pass |
| final isolated humanoid physics group | 1 / 2 | authored lumbar skin and narrow clock failures |
| isolated home viewport group | 9 / 10 | frame p95 49.9 ms still exceeds 20 ms |
| isolated pendulum smoothness group | 2 / 2 | max gap 24.8 ms; original 322.8 ms exceeds 250 ms |
| isolated shared suite | 32 / 32 | demotion 73 ms; original failure retained |

Each separate suspected timing flake received one isolated rerun in the same
environment. Home remains red; shared/pendulum pass only their recorded reruns.
Every completed guarded run reports **19 test-browser lines before, 19 after;
no new sessions**. Extension also confirms no session reached installed Desktop.
Evidence is indexed in `artifacts/f1a-measure/after/README.md`, with baseline in
`artifacts/f1a-measure/before/`, final native JSON in `after/native-summary.json`
and final browser JSON/sheets in `after/humanoid-final/sims/humanoid-physics/`.
Raw pose frames were deleted only after verified distillation; image classification
remains unclassified. Production practice and seats still use their existing path;
F1b and F1c remain unimplemented.

### Sole and displacement sanity check

The 306-335 mm value is real **maximum sole-corner height during the fall**, not
a flat stance-foot air gap. `soleCorners` measures the four corners of the actual
foot box's lower face, local `(+-half.x, -half.y, +-half.z)`, transformed by the
foot body's quaternion and origin into world space. The floor is world Y=0.
The sole centre is 55.000 mm below the foot origin for Keel/II forms, 52.861 mm
for I forms and 50.417 mm for Morrow. Initial origin heights include that offset
plus the declared 2 mm release gap. Both feet are measured at every tick; no swing
foot is selected and there is no commanded step in this stance.

An independent 7,200-tick trace reproduces the first-return maxima exactly. Keel's
left foot penetrates 5.852 mm at **1.779167 s**, while its pelvis is still 864.344 mm
high and up Y=0.989856. Its **335.465 mm** maximum corner height occurs later,
at **2.812500 s**, with pelvis height **121.649 mm**, up Y=0.241623, and the same
sole's minimum corner **18.373 mm**. Morrow peaks at **306.691 mm at 2.595833 s**,
with its lowest corner 14.585 mm and pelvis height 114.437 mm. These are different
frames, after the actor has toppled and both feet have tipped almost vertical;
they are not simultaneous descriptions of one flat contact.

The quantity historically called `slipMm` is **foot-body origin XZ displacement**
from each foot's position at tick 481 (2.004167 s), irrespective of contact.
It includes falling/rolling motion and must not be interpreted as contact-only
sliding. Keel's 464.006 mm maximum occurs at **3.137500 s**, pelvis height
105.226 mm and up Y=0.001999; its left foot origin moves mainly forward in Z.
Morrow's 464.443 mm maximum is at 2.900000 s, pelvis height 96.199 mm. Thus the
large displacement describes the **fall**, not a successful stance sliding half
a metre. No metric or 5 mm threshold was changed. Native JSON now records the
extremum's foot ID, tick, sole corners, root pose and support, sparse full-body
samples, local sole offset and displacement reference. Browser stance strips use
these actual dynamic states, a fixed world camera and floor/corner guides.

### Recorded pending acceptance

The follow-up keeps physical `report.pass` false and makes the candidate mergeable
without claiming F1a completion. Ordinary tests require all eight real measurements,
finite/complete trials and a written, read-back JSON table in TEMP. Each currently
unmet native gate has its own `it.fails` test, named with its threshold and a comment
with current measured values. A harness fault fails normally; an unexpected gate
pass also fails the build and must be converted to ordinary acceptance. Passing
anchor/effort, completed-tick, quaternion/replay and clock-input gates stay ordinary.
The browser group applies the same explicit pending rule to authored skin acceptance
while requiring a complete, persisted measurement report. After the master merge,
the GPU run recorded zero dropped clock time in all 18 rows. Its pending clock
check failed on this unexpected pass as designed, and was converted to an ordinary
zero-loss gate without changing the threshold. The initial 3/4 check result is
retained as evidence of the conversion; it is not a physical-clock failure.
The subsequent confirmation recorded one narrow Cairn-II scheduling stall:
0.399900 s lost, with a 299.9 ms maximum frame interval but only 2.325 ms maximum
tick work. The largest gap followed periodic pixel readback; that correlation
does not establish its cause. Its one allowed isolated same-environment rerun
passes **4/4**, with exactly zero loss in all 18 rows. Both results and raw timing
arrays are retained; no clock cap or threshold was changed. A later full-sims
attempt reproduced loss on narrow Rill-I: **0.666700 s**, maximum frame interval
283.3 ms, maximum tick work 2.640 ms. Five of its six large gaps did not follow
the periodic capture, so neither readback nor an OS/GC/GPU cause is established
for every gap. That attempt was stopped after recording the complete F1a table.

The verifier did serialize synchronous GPU readback and awaited hashing before
requesting the next animation frame. The correction uses owned asynchronous
pixel snapshots as described above and records frame stages; it does not ignore
long intervals, reset the measured clock, reduce quality or increase catch-up.
The corrected isolated group passes **4/4**, with all 18 rows at exactly zero
dropped time and maximum frame interval **33.5 ms**. It verifies all **383**
periodic/final pixel snapshots. Maximum measured frame work is 20.1 ms, advance
work 18.3 ms and capture queue work 0.6 ms; capture fence/copy latency reaches
30.2 ms and native hash wait 5.1 ms without serializing motion. These are wall-time
diagnostics, not a proof of the cause of earlier gaps or controlled CPU/GPU timings.
Its full-sims confirmation subsequently lost **0.616600 s** on desktop Rill-II,
maximum interval 166.7 ms. All six large gaps followed frames doing only
1.8-4.6 ms of work, with no capture queued on those frames. The async readback
correction therefore did not resolve presentation scheduling stalls by itself.

The final private proof drives physics with a **60 Hz wall timer independently
of animation callbacks**. It passes every actual monotonic timer interval into
the unchanged fixed clock; a timer stall still drops time and fails the zero-loss
gate. Raw animation intervals remain reported, so slow presentation is not hidden
by physics continuing. No product timer, worker, controller or production route
changes. Each row also measures a labelled controlled overload probe: a 150 ms
input must produce **12 ticks and 100 ms dropped**, then motion starts from an
explicit reset. The ordinary harness verifies the complete ten-second physics
timestamp trace, elapsed-time sum and tick/drop accounting. This distinguishes
the physical clock from presentation scheduling without changing either limit.
The final isolated timer group passes **4/4**, with all 18 rows at zero physics
clock loss and all 18 controlled overload probes confirming those limits. The
F1a portion of full sims also passes; its maximum real physics update interval
is 45.5 ms, below the unchanged 50 ms cap. Both timing traces are retained.
Harness success is not physical acceptance. No production mode or threshold changes.

The follow-up uses Windows x64, Node 22.23.1 and Playwright Chromium 152.0.7977.8
(installed build 1237), with `OBPAL_E2E_GPU=1`. The hardware probe and each row
report ANGLE/NVIDIA GeForce RTX 4090, Direct3D11; no software fallback occurred.
The isolated run has 18 complete rows, 112 complete pose/LOD captures, eight pose
sheets and three actual gravity-stance strips. All three browser stances exactly
match native physical scalars and extremum ticks. The authored-skin gate remains
pending at 15/16 bodies; the failed-load procedural fallback submits all 16.
There are no browser exceptions or missing frames. All 133 raw PNGs were deleted
only after verified distillation; image classification remains unclassified.
Timing below is the final full-sims F1a portion, with the same viewports/DPR/4x CPU
emulation as above; it is not an isolated CPU or physical-phone benchmark.

| Form | Desktop frame p95 / p99 ms | Narrow frame p95 / p99 ms | Desktop tick p95 / p99 ms | Narrow tick p95 / p99 ms | Clock drop desktop / narrow s |
| --- | --- | --- | --- | --- | --- |
| keel-v1 | 16.800 / 16.900 | 16.900 / 16.900 | 0.975 / 1.167 | 1.917 / 2.133 | 0.000000 / 0.000000 |
| morrow-v1 | 16.900 / 16.900 | 16.800 / 16.900 | 1.125 / 1.350 | 1.967 / 2.350 | 0.000000 / 0.000000 |
| cairn-i-v1 | 16.800 / 16.900 | 16.800 / 16.900 | 1.200 / 1.375 | 1.967 / 2.250 | 0.000000 / 0.000000 |
| cairn-ii-v1 | 16.800 / 16.900 | 16.800 / 16.900 | 1.100 / 1.325 | 1.933 / 2.175 | 0.000000 / 0.000000 |
| rill-i-v1 | 16.900 / 17.000 | 16.800 / 16.900 | 1.050 / 1.250 | 1.975 / 2.233 | 0.000000 / 0.000000 |
| rill-ii-v1 | 16.900 / 16.900 | 16.800 / 16.900 | 1.120 / 1.225 | 1.900 / 2.133 | 0.000000 / 0.000000 |
| hush-i-v1 | 16.900 / 16.900 | 16.900 / 16.900 | 1.060 / 1.275 | 2.000 / 2.275 | 0.000000 / 0.000000 |
| hush-ii-v1 | 16.800 / 16.900 | 16.800 / 16.900 | 1.125 / 1.350 | 1.925 / 2.100 | 0.000000 / 0.000000 |

### Final follow-up validation

The follow-up merged master `fd025b3aec80f2c727eff3594a36e2649ba11ff6` once.
The final measured implementation is `b0d617b`; later changes only record these
tables. Current master `327c939` merges without conflicts, so it was not merged
again. `pnpm run suites -- master` still selects all twelve suites below.

| Check / suite | Passing / executed | Result |
| --- | --- | --- |
| TypeScript | 4/4 configurations | pass |
| Vitest | 3455 ordinary + 80 expected failures; 14 skipped | pass; physical F1a pending |
| Humanoid physics group | 4/4 | pass; authored skin pending |
| code | 19/19 | pass |
| embed | 19/19 | pass |
| home | 36/36 | pass |
| phone | 189/189 | pass |
| sims | 508/508 | pass |
| shared | 32/32 | pass |
| extension | 29/29 | pass |
| camera | 20/20 | pass |
| catalogue | 134/134 | pass on its one isolated rerun |
| contact | 41/41 | pass |
| orientation | 146/146 | pass |
| pages | 137/137 | pass |
| Desktop guard | 19 before / 19 after | no new sessions |

The initial follow-up selection passed ten suites. Catalogue's portrait
drag-close timed out at 133/134; its one same-environment isolated rerun passed.
Full sims first exceeded its 45-minute runner budget, with a dog startup showing
local models-chunk `ERR_NO_BUFFER_SPACE`. Its one isolated buttons rerun passed
138/138, and the final full run passes that scenario at all three viewports.
These original failures remain in evidence; the resource error's cause is not
established. The corrected full sims run completes in **45.3 minutes**, with
508/508 and final CSP verification. It uses an explicit **60-minute outer runner
budget**, leaving the 180-second row budget, fixed clock and physical thresholds
unchanged. The selected run's other production suites remain valid: subsequent
source fixes are confined to the private verifier. Phone confirms the three
original Pixel 7 regressions after the master merge.

Native JSON, timing traces, suite/source tables, original failures and verified
fall strips are indexed in `artifacts/f1a-followup/after/README.md`, with baseline
traces in `artifacts/f1a-followup/before/`. The final full and isolated F1a runs
each verify 133/133 raw frames, zero missing, unclassified, before raw deletion
from TEMP. All three final full-run strips were inspected at readable scale.
No production practice/seat switch, F1b control or F1c skin/BODY implementation
was made; all eight physical F1a reports remain false. Maintainer decisions: none.

## 6. Continuation, without changing the acceptance bar

### What F1b must change

- **Inertia:** reconcile the free-body servo approximation with articulated and
  contact effective inertia; preserve rotated coupling and the shared implicit solve.
- **Support control:** use measured foot load, support polygon and COM to choose
  bounded ankle/hip targets. Prove the unchanged 30-second/5 mm stance gate before gait.
  Distinguish loaded-foot slip from displacement during a fall.
- **Stops:** reconcile motor/stop effort under simultaneous swing and twist,
  preserving 0.01 rad cone and 5 mm surface bounds and declared effort caps.
- **Constraints:** examine joint frames/anchors and coupled solver response;
  retain anchor error <=5 mm and do not pin the pelvis or project observed poses.
- **Collision:** reconcile collider approximations and simultaneous limb/contact
  interference; independent endpoint fixtures do not prove whole-pose clearance.
- **F1c lumbar skin:** reconcile the empty authored `spine_yaw` binding with the
  16-body physics model at both LODs before claiming complete skin submissions.

**First, reconcile F1a native/browser results** on the same model version. Preserve
red measurements, version and parameter tables. Investigate solver/frames/geometry
or controller defects with a reproducing test; never pin the pelvis, overwrite
rendered feet, shrink skins or lower the 5 mm requirement to get a green result.
Review the authored collision approximation and simultaneous pose/sweep crossings.
No green result from `humanoid-physics-selfcheck.mjs` releases native acceptance.

**F1b:** add `physics/world.ts` (one selected Simulation, shared arena, disjoint actor
IDs) and `physics/balance.ts`/`recovery.ts` (simulation-only bounded contact/COM
ankle/hip/step targets), reusing the schema-1 gate/observations without adding root
actuation. Define and record per-profile small and explicitly too-large push
impulses (N s), energy budget (J), fall bounds, support availability and timeouts.
Tests must prove both expected recovery and bounded failure, then contact-supported
get-up, gait push-off/plant, jab momentum transfer and two-actor isolation/contact.
A successful scripted pose alone is not a get-up. Add all-profile Node JSON before
assertion and named-machine two-actor browser timing/strips; do not enable default
practice/seats until these and F1c are accepted.

**F1c:** reproduce the actual BODY heading-spin fault with a recorded synthetic
landmark trace first. Work in `retarget.ts`, `calibration.ts`, `controls.ts`,
`main.ts` and the exact existing `src/ui/body-capture.ts` / controller camera flow;
do not guess packet semantics or touch drivers/safety/live. Map the calibrated,
signed continuous pelvis frame to bounded motor targets, with explicit per-seat
source owners and generation invalidation. Existing `source: 'body'` is only a
label, not an implemented camera connection. Independently verify a fake connected
phone camera into practice, seat1 and seat2, loss/switch quiet behaviour and no
cross-driving. Add receive-to-visible latency, full-scene desktop <=16.7/25 ms
p95/p99 gates, all required motion strips and simultaneous pose/sweep/per-part
pixel/LOD dwell evidence, preserving the independent-axis audit. Keep software-hold
wording and permission/local-processing boundaries intact. Existing classical
controls must remain usable. Learning, storage UI, leagues and new meshes remain
out of scope. Repack a fresh pinned request after coordinator integration.

## 7. F1a2 candidate after the recorded follow-up

The `f1bc-humanoid-balance` return proposes `humanoid-f1a2-v2`: opt-in constrained
motor/stop response, explicit bounded stance targets from native load/COM, and
separate loaded sliding and all-state displacement. See
[HUMANOID-F1A2.md](HUMANOID-F1A2.md) for equations, units, limitations and verifier
outputs. Sections 5-6 above remain historical evidence and the continuation scope.

The held return and reconciliation execute all eight forms on native Rapier 0.21.0.
Each stance completes 7,200 ticks; each anatomy set completes 97 trials of 480 ticks
(46,560 anatomy ticks per form), without errors or missing rows. The anatomy
assertions take 0-3 ms because `beforeAll` has already collected the native report;
those timings are not simulation durations. All 90 isolated joint endpoint trials
pass on every form. The simultaneous poses produce the real failures below.

| Form | Penetration / hover mm | Fall displacement / loaded slip mm | Stance cone rad / surface mm | Anatomy pass / 97 | Anatomy cone rad / surface mm | Final target error rad |
| --- | --- | --- | --- | ---: | --- | ---: |
| keel-v1 | 3.102 / 1.910 | 1.173 / 0.634 | 0.001152 / 0.415 | 93 | 0.119307 / 27.436 | 0.102778 |
| morrow-v1 | 3.127 / 1.910 | 1.429 / 0.719 | 0.001463 / 0.541 | 93 | 0.179426 / 44.379 | 0.369275 |
| cairn-i-v1 | 3.112 / 1.910 | 1.221 / 0.664 | 0.001108 / 0.430 | 92 | 0.156251 / 40.520 | 0.301034 |
| cairn-ii-v1 | 3.102 / 1.910 | 1.173 / 0.634 | 0.001152 / 0.415 | 93 | 0.119307 / 27.436 | 0.102778 |
| rill-i-v1 | 3.112 / 1.910 | 1.221 / 0.664 | 0.001108 / 0.430 | 92 | 0.156251 / 40.520 | 0.301034 |
| rill-ii-v1 | 3.102 / 1.910 | 1.173 / 0.634 | 0.001152 / 0.415 | 93 | 0.119307 / 27.436 | 0.102778 |
| hush-i-v1 | 3.112 / 1.910 | 1.221 / 0.664 | 0.001108 / 0.430 | 92 | 0.156251 / 40.520 | 0.301034 |
| hush-ii-v1 | 3.102 / 1.910 | 1.173 / 0.634 | 0.001152 / 0.415 | 93 | 0.119307 / 27.436 | 0.102778 |

All eight stance reports pass the unchanged penetration/hover <=5 mm, cone <=0.01 rad,
surface/anchor <=5 mm, pelvis >=90% initial height, up Y >=0.98, declared effort
caps, zero dropped time and zero invalid frames. All 6,720 settled samples have
native support. Minimum pelvis heights for II/Keel, I and Morrow are respectively
0.917418, 0.881637 and 0.840745 m; minimum up Y is at least 0.999992. Maximum stance
anchor error is 0.058674 mm and effort ratio is 0.197699. Replay passes at
60/30/120 Hz, including negative quaternion signs. Displacement and loaded sliding
remain diagnostics without an invented slip threshold.

The stance tests are ordinary passing assertions (already promoted in the candidate).
Only the three anatomy gates per form remain `it.fails`, with their unchanged
0.01 rad cone, 5 mm surface and 0.08 rad final-target thresholds. The ordinary
completion test still fails missing/error/nonfinite rows; expected failures cannot
substitute for executing the trials. `physicalAcceptance` remains false on all eight
forms even when the test runner is green. Squat, lunge, high kick and twist fail on
every form; I-height forms also miss the T-pose cone gate (0.010173 rad). Only squat
misses final target tracking. Full per-trial values and signed extrema are emitted
before assertions, with completed and failing trials in the compact table.

Contact diagnostics reproduce the held per-pose maxima. Squat retains positive
forearm/thigh and hand/thigh native impulses through tick 480; its worst cone is
forearm swing and final target miss is a hand, without saturation. Dynamic/dynamic
contacts remain active in Rapier but are deliberately absent from the local torque
predictor. Lunge's worst cone occurs at ticks 20-31 during floor impulses and
actuator saturation (23/22/13 saturated joint-ticks for Keel/I/Morrow). Twist and
I-height T-pose errors are floor-contact transients; Keel/II high kick includes
thigh/lumbar self-contact. The compliant stops do not guarantee hard cone bounds
under collision impulses omitted from the predictor or after torque saturation.
Diagnostic floor removal lowers the floor-related cone errors below 0.01 rad,
while squat and Keel high kick remain red. This supports the contact-transition
cause; the acceptance fixture and its floor remain unchanged. F1b must investigate
contact-aware feasible trajectories, unilateral contact response and saturation
coupling rather than treating independent endpoints as whole-pose clearance.

The guarded `humanoid-physics` group runs separately in the verifier, with its own
acceptance log. Master's full sims dispatcher also includes it in the first timing
partition. Both retain unchanged clocks, thresholds and physical gates. The previous
coordinator-authorized SwiftShader runs remain historical evidence: sims reached its
45- and 90-minute limits before focused completion, and software clock/frame-time
results did not grant GPU acceptance. The hardware integration below supersedes
those browser results without changing the native measurements above.

### Hardware integration after master 9ea1cab

The integration preserves master's shared GPU slots and exclusive timing
reservations. Validation uses `OBPAL_E2E_GPU=1`, pinned Playwright Chromium build
1237, and the measured ANGLE NVIDIA GeForce RTX 4090 Direct3D11 renderer. All ten
full-sims partitions finish within their unchanged 45-minute budgets: 50.8 minutes
of suite work, plus 8.1 minutes of queue waits. The explicit integration brief selects
sims, phone, shared, camera, catalogue, code and pages, plus isolated humanoid
physics, rather than the twelve suites printed by the changed-path selector.
An initial shared wait expired into SwiftShader and was canceled without acceptance.
The replacement extends only the shared queue wait to 60 minutes to retain hardware
validation; assertion thresholds and default suite execution budgets are unchanged.

The fresh required check passes all four TypeScript configurations and 3,599 ordinary
Vitest tests, with 24 measured anatomy expected failures and 14 skips (3,637 total).
Each of the eight native physical reports exactly matches the recorded F1a2 values.
No anatomy threshold or expected-failure assertion changes during integration.

| Hardware browser validation | Ordinary checks passed / total |
| --- | ---: |
| isolated humanoid physics | 4 / 5 |
| full sims, all ten partitions | 517 / 518 |
| phone | 189 / 189 |
| shared | 32 / 32 |
| camera | 20 / 20 |
| catalogue | 134 / 134 |
| code | 19 / 19 |
| pages | 140 / 140 |

The six non-sims suites complete all 534 checks on hardware, including each final
CSP gate. Their suite work takes 49.4 minutes, with 30.9 minutes of GPU queue waits.
Code's brand timing and pages' policy checks pass with the inherited master fixes;
the Cloudflare automatic-beacon note is not a failed assertion. Camera processing
uses the PC fixture; phone layouts use browser emulation, not physical-phone proof.

Isolated humanoid physics passes 4/5 ordinary checks; full sims passes 517/518.
Every partition uses the hardware renderer and the guard reports `no new sessions`.
All 18 humanoid browser rows, 112 pose captures and three 7,200-tick stance strips
complete. Keel browser penetration/displacement/loaded slip are 3.099/0.869/0.630 mm;
Morrow and Cairn-I match the rounded native table above. These browser measurements
remain separate from the eight-form native table. Authored lumbar submissions stay
an explicit pending diagnostic, not a newly failing ordinary assertion.

The sole ordinary sims failure is the unchanged zero-dropped-time gate. All ten
desktop motion rows lose zero time. The eight narrow rows under 4x CPU throttling
lose 4.0731-6.3839 s in the isolated run and 3.3299-4.7353 s in the full-sims prefix.
Each loss equals the sum of update intervals beyond the unchanged 50 ms clock cap;
the full-sims mean physics advance costs 5.956-7.485 ms per 240 Hz tick. These
measurements describe the clock mechanism; paired master measurements distinguish
pre-existing loss from the added candidate cost.

Pinned master 9ea1cab reproduces the aggregate clock failure (3/4 ordinary checks),
using the same RTX 4090 exclusive reservation, 18 selectors, viewports, CPU throttle,
scene and clock detector. Its audited source archive is distinguished from the
parent repository SHA reported by the runner. All 18 motion windows complete, and
all ten desktop keys lose exactly zero time in master and both candidate captures.

| Narrow form, 4x CPU | Master loss s | Candidate isolated s | Candidate full sims s | Full candidate extra s |
| --- | ---: | ---: | ---: | ---: |
| keel-v1 | 0.1733 | 6.0366 | 3.3784 | 3.2051 |
| morrow-v1 | 0.0000 | 6.2888 | 3.3699 | 3.3699 |
| cairn-i-v1 | 0.0000 | 5.7258 | 3.3753 | 3.3753 |
| cairn-ii-v1 | 0.0000 | 4.0731 | 3.3299 | 3.3299 |
| rill-i-v1 | 0.0000 | 5.7458 | 3.5543 | 3.5543 |
| rill-ii-v1 | 0.0099 | 5.7359 | 3.8962 | 3.8863 |
| hush-i-v1 | 0.2242 | 6.3839 | 4.7353 | 4.5111 |
| hush-ii-v1 | 0.0000 | 6.0619 | 4.4012 | 4.4012 |

Only Keel, Rill II and Hush I are red in this master witness. The other five forms
are newly red in both candidate captures, and all eight lose substantially more
time. Extra loss is 3.2051-4.5111 s in full sims and 4.0731-6.2888 s in isolation.
Master narrow p95 physics tick cost is 3.100-4.075 ms, versus 6.650-12.917 ms in
full candidate sims. This is a measured CPU timing regression relative to the paired
master capture. The pre-existing aggregate failure does not waive the unchanged
zero-drop gate or make the extra loss unrelated. Timing remains unaccepted.

All 137 button gates and 68 local-control checks pass, with every expected button
name attempted exactly once. All eleven logged full-sims CSP checks pass in their
fresh partition page sets. The five-minute two-hero PC sample passes: 17,691 frames,
logic p95 0.600 ms, submission p95 0.700 ms and GPU p95 4.617216 ms, totaling
5.917216 ms against the unchanged 16.7 ms work gate. Scheduling interval p95 is
16.9 ms and is a separate measurement. Draw calls are 102, triangles 55,597 and DPR
1, within the unchanged 120/65,000/1.5 bounds. The existing harness deletes its TEMP
arrays before retention; the passing log retains these exact component summaries.
This synthetic PC landmark sample does not establish physical-phone performance,
camera contention or the shared-native-world two-actor F1b requirements.

Production practice and seats remain unchanged. F1b must still reconcile simultaneous
pose stops/contact interference, shared-world two-actor motion, pushes, gait,
recovery and contact-supported get-up, with physics advance fitting the clock budget.
F1c retains authored lumbar, BODY routing,
latency, clock/frame timing, mesh-crossing and LOD transition acceptance.

## 8. Contact-inertia candidate (humanoid-f1a2-v3)

The feet retain their box dimensions, friction, 1.3 kg mass and joint contracts.
Their declared principal moments are three times those of a uniform box: the
physical upper bound obtained by putting that mass at the eight corners. The
same rule applies to all eight forms, scenes and tests. Rapier, the custom
backend and the coupled torque predictor use the declared moments. Bodies
without an override retain their existing mass-property construction.

Declared inertia overrides are supported only by the custom and Rapier
backends. The PhysX adapter still uses uniform-shape inertia; do not pass an
override to a generic PhysX scene. Humanoid scenes already fail its unsupported
contact-settings and torque-integration checks.

**Replay:** v2 journals do not replay against v3. Record and replay with the same
model version, backend and fixed tick. No committed journal pins a v2 hash.

The native fixture carries a 59.5 kg total load with its payload 0.8 m above the
sole. At COP 0.8 times the half-length, the selected inertia gives peak deepest
corner sink of 4.146 mm (Keel) and 4.155 mm (Morrow), without toppling. The unchanged
inertia topples there. A 2 by 2 tiling preserves the outer sole, mass and inertia
but both tiled candidates topple at that offset on both sizes; it was rejected.
These fixture measurements establish the plant choice, not walking acceptance.
`physics-contact-sink.test.ts` pins the mass/inertia/COP grid to 0.25 mm and checks
the spring law only at three times uniform inertia.

The npm binding 0.21.0 wraps Rust Rapier 0.36.0. Its exposed
`contact_natural_frequency` updates dynamic-contact softness; contacts against a
fixed floor use separate 60 Hz static-contact softness with no exposed setter.
Allowed error, prediction distance and length unit are genuine native setters,
but leave the measured loaded-floor fixture trajectories identical. This is not
a claim that they are globally inert. The application's `predictionDistance`
remains the distance threshold for loaded-contact observations and prediction.
See the [binding implementation](https://github.com/dimforge/rapier/blob/v0.36.0/bindings/typescript/src/dynamics/integration_parameters.rs)
and [integration defaults](https://github.com/dimforge/rapier/blob/v0.36.0/src/dynamics/integration_parameters.rs).

The prior native contact research rejected 32 solver iterations, two internal
PGS iterations and 480 Hz stepping: less than 1% sink improvement, at up to twice
the work. Its multibody spherical ankle still sank 3.8 mm and would require an
adapter and coupled-servo rewrite. CCD did not improve these slow-foot contacts.
Contact skin only offsets the floor: the research measured 4.66 to 1.65 mm with
3 mm skin. Skin, foot/shin mass changes and hand mass-property changes are
report-only alternatives; none is applied by this candidate.

Walking's two reaction corrections reuse the target-independent constraint
response within one synchronous scope. Each target map still runs the coupled
servo solve. Input snapshots invalidate reuse after scene, state or contact
changes, and returned matrices own their arrays. The native Keel and Morrow
W1, W2 and W3 trials retain identical per-tick state hashes; this optimization
does not change contact parameters or integration order.

The final native comparison at `d10e4f6` against master `70a5bdbd` passes the
unchanged 10% p95 regression gate in all seven scenarios. Four repetitions
alternate master/lane order; each table entry is the median of the four
per-repetition p95 values, measured on the same Node 22.23.1 / i9-13900KF machine
with no concurrent lane native workers or agents. Other lanes' browser jobs
remained on the shared machine. Independent warmups and a fresh
two-second settle precede timing. Stance and in-place windows are 10 s; walking
uses the common pre-fall windows of 6 s for Keel and 3 s for Morrow. Master
Morrow falls at 3.508333 active seconds and reaches its guard fault at 3.904167 s,
so later falling work is excluded from this walking comparison.

| Native scenario | Master p95, ms | Candidate p95, ms | Change |
| --- | ---: | ---: | ---: |
| Keel stance | 3.43670 | 3.42890 | -0.23% |
| Morrow stance | 3.46980 | 3.25475 | -6.20% |
| Cairn I stance | 3.42025 | 3.38850 | -0.93% |
| Keel in place | 4.58895 | 3.67325 | -19.95% |
| Morrow in place | 4.32770 | 4.03690 | -6.72% |
| Keel walking | 6.41365 | 5.14435 | -19.79% |
| Morrow walking | 5.78690 | 5.21210 | -9.93% |

An earlier run failed Morrow stance at +11.648%. Indexed traversal of the
constraint projection basis resolved that measured failure while preserving
arithmetic order and all 10 protected native snapshot hashes. Its first passing
comparison peaked at +3.102846%, for Cairn I stance. After the mixed step-to-turn
fix, the fresh seven-scenario comparison above has a largest ratio of 0.997730,
for Keel stance. These native wall-time measurements
do not establish browser frame pacing or a real-time guarantee.

The final source check passes all four TypeScript configurations and 4,337
ordinary tests, with 54 expected failures and 14 skips (4,405 total). The 24
anatomy expected failures remain. All 14 nominal gait rows, 32 BODY rows, 25
balance assertions and 45 contact-sink assertions pass; all 24 R1 native-state
clock comparisons match across eight forms. Native get-up safety passes 16/16
and world safety 4/4, but neither set recovers: these safety checks establish
finite state and bounded effort, not the penetration or no-fall gates.

Six additional final-source journal replays reproduce every native snapshot
and the concatenated stream hash exactly: both pilots at 720 push ticks, 1,920
walking ticks and 8,999/9,000 mixed step-turn-release ticks. These one-actor runs
use the world's default first-seat spawn at x = -1 m. The mixed runs export a
capacity-one journal each tick; the production 7,200-record limit is unchanged.
All 23,279 recorded ticks match their replay. Action-target representations
first differ at tick 6 through quaternion rounding, so the exact-hash claim is
for native state, not byte-identical journal actions. These replay cases do not
replace the separately measured physical acceptance trials at the origin.
