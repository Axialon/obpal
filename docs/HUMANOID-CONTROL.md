# Humanoid control: balance, stepping, gait, get-up and BODY follow

F1b/F1c controller design, 2026-10-04, against the F1a2 candidate (`codex/f1a2-reconcile`). It adapts published controllers to our model. Nothing here is accepted until its test in section 7 passes. No existing gate changes.

## 1. Ground rules

- Control leaves only as a complete schema-1 `ActuationFrame` through `ActuationGate`: cones, 4 rad/s target slew and effort caps. No root force or torque, pelvis pin, pose projection or per-tick body write.
- **Pushes are test disturbances.** `world.push()` applies `Simulation.applyForce` to the thorax for 0.1 s and journals it. No frame can reach it.
- **Torque through targets.** The motor realises about `tau = K*err - D*w`. A wanted torque becomes the offset `tau/K` on a posture target, or `(tau + D*w_rel)/K` on the measured rotation (torque mode). Both are capped at 0.8 of the joint cap. Native results decide.
- `StanceController` keeps quiet stance unchanged, so the 30 s gate stays valid. The 24 anatomy gates stay red unless closed separately.
- Units are SI. **SD** marks an original, uncalibrated simulation default.

## 2. Model facts

All forms weigh 59.5 kg. The eight forms are three physical geometries:

| Group | Forms | COM h (m) | ω = √(g/h) (s⁻¹) | Toe / heel / lateral margin (m) | Hip height L (m) |
| --- | --- | ---: | ---: | --- | ---: |
| Keel | keel, cairn-ii, rill-ii, hush-ii | 0.908 | 3.29 | 0.213 / 0.107 / 0.240 | 0.922 |
| I | cairn-i, rill-i, hush-i | 0.873 | 3.35 | 0.205 / 0.103 / 0.259 | 0.886 |
| Morrow | morrow | 0.832 | 3.43 | 0.195 / 0.098 / 0.262 | 0.845 |

Toe-ward is −Z at spawn yaw 0; a unit test pins it.

The limits shape get-up: hip flexion is at most 100°, knee 130°, ankle dorsiflexion 25°. A flat-foot deep squat leaves the hip about 0.24 m behind the ankle, so the COM falls behind the heel. The contact lane replaces the unsuccessful toes-to-pike path with a tucked bridge, tall kneel and supported half kneel. Static force feasibility of these postures does not establish a feasible transition between them; native recovery remains unproven.

## 3. Modules (`src/sim/humanoid/physics/`)

| File | Responsibility | Source |
| --- | --- | --- |
| `targets.ts` | Joint frames, target offsets, `worldTarget`, Jacobian-transpose torques, gravity compensation | [4], [2] |
| `balance.ts` | Ankle and hip strategies; quiet stance handed to `StanceController` | [3], [4] |
| `stepping.ts` | Capture state, step trigger, swing choice, landing target (pure) | [3], [2], [5] |
| `gait.ts` | SIMBICON state machine, swing-hip feedback, torso and stance hip, heading, start/stop | [1], [2] |
| `getup.ts` | Fall response, prone/supine classification, keyframe graph with contact conditions | [6], [7] |
| `upper-body.ts` | BODY and preset targets for arms, head, spine; blend weights | [8], [9] |
| `intent.ts` | Phone `Intent` → `v_d`, yaw rate | — |
| `supervisor.ts` | Mode machine; merges leg and upper-body targets into one frame | [7] |
| `world.ts` | One `Simulation`, floor, two actors, gates, journals, pushes, spawn | — |
| `demo.ts`, `world.worker.ts` | Page entry; optional worker host | — |

`pilot.ts`, `stance.ts` and `contract.ts` stay unchanged.

**targets.ts.** A joint's frame is `parentRot ⊗ frameParent` at the parent anchor. `worldTarget(j, R) = conj(parentRot ⊗ frameParent) ⊗ R ⊗ frameChild` is exact. On a foot-rooted stance chain (ankle, knee, hip), the motor torque is `tau_j = -(p - p_j) × F`. Pelvis-rooted chains flip the sign. Gravity compensation sums `(c_i - p_j) × m_i g` over distal links. Unit tests pin every sign.

**balance.ts.** It uses `h = com.y - cop.y`, `ξ = com_xz + v_xz/ω` and the support polygon `P`.

- **Quiet stance** applies inside `P` shrunk by 0.02 m, with `|v| < 0.05 m/s` and `ξ` within 0.03 m of the centroid: `StanceController` acts.
- **Ankle.** From `ξ' = ω(ξ - r_cmp)`, set `r_cmp = ξ + k_ξ(ξ - ξ_ref)` toward the polygon centroid. Clip to the hull of the loaded feet's sink-safe diamonds. Apply `F = m ω²(com - r_cop)` by Jacobian transpose per stance leg, weighted by load share. Clip each foot's implied COP to its own diamond too. A foot with fewer than three hull points, or turning faster than 1 rad/s, receives a zero-moment target with damping compensation (GBWC).
- **Hip.** The residual `e = r_cmp - r_cop` sets a trunk moment `m g e`, at most 60 N m, while trunk pitch is within 0.35 rad. Stance hips realise it SIMBICON-style; a torso PD returns upright. Sign test: a toe-ward excess pitches the trunk forward.

On first entry or after an observation gap, Balance retains the measured leg
posture if both feet are loaded and their heading-local separation or stagger
differs from the authored stance by more than 30 mm. Static support moments and
3 s⁻¹ virtual COM damping then act around that posture. These are simulation
defaults; unchanged initial standing geometry follows the original path.
This prevents a walking stop from straightening staggered legs abruptly.

**stepping.ts**

- **Trigger:** `ξ` more than 0.03 m outside the shrunk polygon for two ticks, or `|v| > 0.35 m/s` (GBWC rule).
- **Swing:** the less-loaded foot. On a lateral exit, the exit-side foot once its load share is ≤ 0.6 (balance unloads it by ankle roll). Never a crossing step.
- **Landing:** `ξ_T = r_cop + (ξ - r_cop)e^(ω T_s)`, `T_s = 0.32 s`, plus 0.03 m along the exit. Length is capped at 0.6 L (GBWC); lateral width from the stance ankle is at least 0.20 m. A capped step recomputes at touchdown, giving N-step recovery.

The contact model predicts centred sink `δ = F_n/(4 m_eff ω_c²)`, with
`ω_c² = 1.425e5 s⁻²`, calibrated on the native loaded-foot fixture. The foot-frame
diamond is `|x|/b + |z|/a ≤ ρ`, where `ρ = min(0.85, 4 mm/δ − 1)` bounded below
by zero. Measured depth above 3.5 mm trims the region at up to 4 s⁻¹; it restores
at 0.05 s⁻¹. These are simulation defaults, not changes to the 5 mm acceptance
gate. First loaded contact requests zero ankle moment until flat, then blends
over 60 ms into measured-COP damping with gain 0.5. An unflat foot remains in
conform after the nominal 80 ms window.

**gait.ts** retains alternating lift and strike, with ALIP landing placement [10]
and SIMBICON swing feedback. Angular momentum about the measured stance COP
includes orbital momentum and each body's rotated declared inertia. Its
equivalent velocity is `(-L_z, L_x)/(m h)`. Hyperbolic pendulum prediction over
the measured remaining swing time selects the next support position to reach
the requested terminal velocity; the existing reach and non-crossing limits
still apply. This assumes fixed COP and constant COM height during prediction.

Horizontal swing and both vertical halves use quintic interpolation. The
landing plan freezes at 75% of its 0.60 s reference horizon or below 15 mm sole
clearance in strike; it ends 3 mm below the undeformed sole plane. Requested
unloaded hip, knee and ankle targets are limited to 3 rad/s before the unchanged
4 rad/s gate. While turning, the ankle anticipates the planned shin direction.
Loaded ankles use conform and sink-safe clipping before coupled hip prediction.
There is no toe segment: propulsion uses the hip and knee with a flat sole.

Walking defaults interpolate by measured hip-to-ankle chain length, bounded by
the calibrated 0.77–0.84 m interval. No profile identifier selects the values;
the remaining forms receive the same rule without individual tuning.

| Chain length | Lift / strike | Lateral reference | Terminal sagittal velocity factor |
| --- | --- | --- | --- |
| 0.84 m | 0.27 / 0.36 s | 0.20 m | 1.00 |
| 0.77 m | 0.30 / 0.40 s | 0.15 m | 1.30 |

Compact-leg turns blend separate simulation defaults by
`min(1, abs(yaw rate)/(1 rad/s))` and the same clamped chain-length fraction
`(0.84 m - L)/(0.84 m - 0.77 m)`. Zero yaw and the 0.84 m endpoint retain the
straight branch exactly. The full compact-turn defaults are:

| Quantity | Simulation default |
| --- | --- |
| Lift / strike | 0.2777240484976537 / 0.39321100291349714 s |
| Clearance / capture horizon | 0.0323046330044233 m / 0.5077943432166341 s |
| Lateral reference / periodic momentum width | 0.15134754691180272 / 0.19112127827846948 m |
| ALIP momentum retention / velocity-force gain | 0.05206005451921607 / 70.38883424635598 N s/m |

The periodic width specifies terminal angular momentum; the physical landing
minimum remains 0.20 m. These values came from deterministic CMA-ES [11] with seed
2026100420, population 10 and initial normalized sigma 0.15. The search stopped
after four complete turn generations and six candidates of the next, following
seven earlier walking generations. The retained candidate passed the nominal
Morrow turn and all five prescribed perturbed starts, with 3.944–4.038 rad in
10 s and 3.577–3.590 mm peak penetration. Straight walking and Keel use their
previous defaults; the fixed-tick regression hashes protect those branches.

These are measured simulation defaults, not a claim of universal dynamic
similarity. Start shifts the COM toward support. Within 5% foot-load imbalance,
a turn chooses the outer swing foot. Pelvis-heading lead remains limited to
0.05 rad. Release retains the ALIP landing instead of replacing it with adjacent
standing spacing. A stopped swing must unload and then show two flat supported
observations, or 40 ms loaded, before Balance takes over. The handoff still
requires speed below 0.1 m/s. Recovery uses a 0.25–0.45 s bounded swing.

If the geometry's midline gravitational hip-roll demand exceeds 80% of its hip
effort cap, release first recenters over the measured ankle supports for two
seconds. The target pelvis height stays within both authored leg chains' reach
with a 0.4 rad minimum knee bend. Two distinct loaded observations and both feet
flat within 0.5 degrees qualify the handoff. These are simulation defaults; the
three-second stop deadline and ten-second stance hold remain unchanged. Balance
preserves the measured hip/knee support. Only when a newly retained ankle lies
more than 0.01 rad outside its unchanged cone does it gradually correct the ankle
references toward world-flat, at 1 rad/s after conform. This correction advances
once per observed tick and resets when a new support posture is retained.

Walking still has its timed strike exit; the proposed explicit double-support
transfer has not passed native regression. Horizontal interpolation also retains
the lift/strike change in phase-normalized clock rate: a continuous elapsed-time
probe missed the 0.3 m/s speed floor on three of five Morrow starts. The 86 N m stance-hip roll request
budget is also unresolved: unchanged motor caps bound actuation, but requested
moments can exceed that design margin. The optimizer penalizes the raw outer-loop
roll request, which is distinct from both the quasistatic non-stance gravity
moment about the hip and the applied capped motor torque. Its value proves
neither physical quantity meets 86 N m. These limitations are not relaxed gates.

The world registers standing `recover` ahead of walking and balance. Its ankle
capacity is `m omega max(0, margin - 0.02 m)` along the measured escape direction
inside the sink-safe hull. After a 50 ms hip response, or an estimated capture
moment above 86 N m, it requests a bounded 0.25–0.45 s capture step through the
same gate and swing controller. A 100 ms supported interval returns to balance.
These timing and reserve values are simulation defaults. Effective walking
intent does not initiate standing recovery; stick deadzones and `stand` use the
same mapping as walking. Recovery also waits for a retained walk to finish its
release before it can enter.

Native thorax pushes through `world.push` pass class A on both pilots (8/8,
maximum penetration 2.626/2.635 mm), class B 6/8 and class C 1/8. Both class B
lateral rows fall, at 1.521/1.350 s and 5.077/3.753 mm. The passing nominal class C
Morrow diagonal row reaches 3.366 mm and uses no step; two of its five perturbed
starts fall at 1.963-1.979 s with peaks of 4.875-4.894 mm. The final native push
suite has 39 ordinary passing assertions and 10 expected failures. This is
evidence for bounded standing response, not demonstrated stepping recovery.

Ordinary active Balance still retains its original nominal-posture ankle law
after sink-safe moment clipping. Extending full conform/COP feedback to that
path made both walking stops fall. A narrower zero-moment override preserved
walking stops and class A but regressed the nominal Morrow class-C diagonal
push. Advancing its contact history through quiet ticks restored that nominal
pass, while one previously passing 5 mm perturbed start still fell at 1.517 s
and 4.730 mm penetration. Those extensions were rejected. Retained support
postures and gait use the conform/feedback path; ordinary Balance remains a
documented gap.

The in-place fallback retains every `IN_PLACE_CONTROL` literal. Its shared
contact response holds a loaded landing in zero-moment ankle conform after
40 ms; three non-collinear support points and at most 0.5° tilt permit transfer.
The coupled hip-reaction estimate includes those conform ankle targets. During
transfer, the receiving-foot reference moves from 50% toward 85% load. Measured
load-share error adjusts only the pelvis IK reference: 0.6 m per unit share,
bounded to 40 mm and 20 mm/s. These are simulation defaults, not body writes.
Release resets that reference correction and reanchors both ankle IK goals to
their measured joint-frame positions before recentering.

Changing from stepping to turning first completes this recenter, then applies
ordinary Balance over the existing two-second preparation interval before a
fresh turn. It retains the original standing-height reference. Release cancels
the pending turn; a changed yaw sign uses the latest command. Initial pure turns
keep their original timing. This pauses the mixed sequence without changing any
`IN_PLACE_CONTROL` literal or writing body state.

When midline gravitational hip-roll demand exceeds 80% of the hip effort cap,
transfer also leans the trunk toward the receiving foot. The simulation default
is 0.12 rad total world roll, split equally across the two spine joints. It
follows the existing cosine transfer clock and fades to zero over the existing
release clock. This geometry rule leaves Keel's targets unchanged. It lowers
Morrow's measured receiving-hip gravity moment, but the loaded p95 remains
107.294/107.813 N m in place/turning, above the unresolved 86 N m design target.

On the v3 contact candidate, Keel completes both 30 s fallback rows and both
release stops at 3.670/3.776 mm peak penetration. Each foot completes two genuine
unload/clear/reload cycles, and release reaches stance in 2.008 s, held for 10 s.
Morrow now completes both fallback rows at 3.518/3.077 mm, turns 0.343 rad,
and reaches stance after release in 2.008/2.350 s. Five perturbed starts for
each release trial also pass the full motion and hold protocol, with peaks
3.071–3.236 mm and stance by 2.355 s. These are fallback measurements, not
W1–W3 walking acceptance.

The retained world sequence uses 10 s forward stick, 20 s yaw and 6 s released.
Before the settled turn transition, five Morrow starts fell at 30.933–32.442 s,
with 6.118–6.545 mm penetration before falling. Keel also fell at 26.558 s when
starting after 359 settle ticks, with 6.559 mm over the run; starting one tick
later passed. That failure reproduced the browser trace exactly.

With the settled transition, five Keel timing starts complete at 3.617–3.727 mm
and five Morrow timing starts complete at 3.735–3.745 mm. All remain finite,
without falls or guard faults, and finish in Balance with both feet loaded.
The independent nominal Morrow repeat has an identical native-state hash.
Signed turning is only 0.052–0.095 rad over this mixed interval: above
the page's 0.05 rad gate, below the separate pure-turn target of 0.3 rad. The
native regression covers the failing Keel start and nominal Morrow start.
These timing starts do not establish arbitrary command or spawn robustness.
The final-source hardware browser retry passes all 12 checks. Both mixed traces
remain finite without falls or worker faults, then finish in Balance with both
feet loaded: Keel peaks at 3.646 mm and Morrow at 3.735 mm. Their signed turns
are 0.063 and 0.052 rad; neither discards simulation time or leaves queued time.
On the RTX 4090, single-actor standing with synthetic BODY records 1.2/1.3 ms
work at p95/p99 over 120 s after 60 s warm-up. A short two-actor standing/BODY
attempt also passes, with no
actor reduction and 1.5/1.6 ms work over 30 s after 15 s warm-up. This is not
the full two-actor walking frame-budget proof. The isolated runner's helper
guard records 19 lines before and after, with no new sessions.

**getup.ts**

- **Fall:** a non-foot floor impulse, or `up.y < 0.8` or COM below 0.65 h₀ with no step possible. Protective arms (Faloutsos): shoulders 1.2 rad toward the fall, elbows 0.3, knees 0.4.
- **Settle:** `|v_com| < 0.05 m/s` and every `|ω| < 0.3 rad/s` for 0.5 s.
- **Classify** by thorax forward axis: `f·ŷ < -0.5` is prone, `> 0.5` supine, else roll to prone.
- **Supine** rolls to prone first, as Faloutsos's stuntman does (S1, 2.0 s): head 0.6 and spine yaw 0.3 toward the roll, far arm across (pitch 1.2, roll −0.2), far leg crossing (hip pitch 0.8, roll −0.3). One retry, on the other side.
- **Prone** adapts Behnke's phases. Each phase eases to its keyframe (cosine plus gate slew) and advances only on its post-condition:

| Phase | Key targets (rad) | Post-condition | Timeout |
| --- | --- | --- | ---: |
| P1 Hands under | shoulder pitch −1.2 then −0.95; elbow 1.9; hip 0.2 and knee 2.15 tuck | knees tucked and both folded hands planted | 1.0 s |
| P2 Tucked bridge | shoulders 1.17/1.16, elbows 0, hips 1.39/1.40, knees 2.15/2.20, head 0.5 (Keel/Morrow) | hands and shins loaded; pelvis ≥ 0.35 m; root up Y ≥ 0.2 | 1.5 s |
| P3 Tall kneel | hips 0/0.15, knees 1.85/1.90, ankles −0.6 (Keel/Morrow) | shins loaded; hand load ≤ 30% of weight; up Y ≥ 0.95; COM inside shin/foot hull | 2.0 s |
| P4 Half kneel | front foot flat; rear knee supports | front foot and rear shin loaded; COM in the front foot's sink-safe region; up Y ≥ 0.9 | 2.0 s |
| P5 Rise | knee/hip → 0.05/0 over 1.2 s; ankle law on | `up.y ≥ 0.95`; pelvis ≥ 0.85 h₀ | 2.0 s |
| P6 Settle | nominal; `StanceController` | 0.98 / 90% held 1 s | 2.0 s |

Keyframes are SD starting points; post-conditions are the contract. After two failures the actor is `down` (limp hold, not quiet).

The v3 contact candidate checks support postures offline with nonnegative contact
forces, friction cones and the unchanged effort caps. Tall-kneel static effort
ratios are 0.069/0.063 for Keel/Morrow; half-kneel ratios are 0.229/0.256. Predicted
deepest support sink is 1.66/1.79 mm and 3.37/2.27 mm respectively. These are
feasibility estimates. Native lean-fall recovery still measures 0/16 recoveries,
with all 16 finite-state and effort safety rows passing. World prone/supine
fixtures also remain explicit expected failures; get-up is not registered as a
successful automatic world behaviour.

**upper-body.ts** maps `Retargeted.q` to arm, head and spine-yaw targets through `targetsFromAngles`. BODY spine pitch and roll, clamped to ±0.15 rad, are added to the torso target, so the stance hips carry them. Presets use the same path. Legs ignore BODY.

**supervisor.ts.** Behaviours export `canEnter`, `step` and `done` (Faloutsos pre/post-conditions). Priority: getup > fall > recover > walk > balance > stance. Upper-body targets are slerped onto the leg frame. The frame's source is `body` when BODY weight is ≥ 0.5, else `classical`. A future signature policy returns the same frame (`source: 'policy'`) from the observation plus `Intent`, so the journal stores `{observation, intent, action, disturbances}`.

**world.ts.** One floor and actors `seat1`/`seat2`; their ids are already disjoint.

- **Spawn and fixtures.** Spawn `{x, z, yaw}` and the test-only `posture: upright | prone | supine` are rigid transforms applied once at initialisation, released 2 mm up.
- **Reset** rebuilds the arena and increments both generations; there is no per-actor teleport.
- **Observation** gains additive `floorContacts` and `actorContacts`.
- **Coupled solve and cost.** The coupled servo solves per articulation island. The maths is identical because the response is block-diagonal, but the dense cost drops to a fraction. One contact copy per tick feeds the servo and both observations. Two actors fill the 32-body workspace exactly.

## 4. Gains and constants

| Quantity | Value | Source |
| --- | --- | --- |
| Joint K, D, caps; slew; 240 Hz | unchanged | F1a SD |
| Quiet-stance support margin | 0.02 m | HUMANOID.md 2 cm |
| Active COP region; depth budget; trim start | diamond ρ ≤ 0.85; 4.0 mm; 3.5 mm | SD, native contact calibration |
| Retained support posture; damping | 30 mm geometry departure; 3 s⁻¹ | SD, walking-stop measurements |
| `k_ξ`; hip cap; trunk limit | 1.0; 60 N m; 0.35 rad | SD |
| Step trigger; `T_s`; overshoot; min width | 0.03 m or 0.35 m/s; 0.32 s; 0.03 m; 0.20 m | SD (GBWC form) |
| Maximum step | 0.6 L | GBWC |
| Walking lift / strike; clearance; target rate | 0.27–0.30 / 0.36–0.40 s; 0.035 m; 3 rad/s | SD, geometry-derived; gate unchanged |
| `c_d`, `c_v` | 0.5 rad/m, 0.2 rad s/m | SIMBICON 3D walk |
| Torso K/D | 300 N m/rad, 30 N m s/rad | SIMBICON |
| `k_V` | 60 N s/m | SD |
| Speeds fwd/back/side; yaw rate | 0.5/0.25/0.25 m/s; 1.0 rad/s | SD (GBWC −0.6…1.7 m/s, 2 rad/s) |
| BODY ramps; spine clamp | 0.15/0.25 s; 0.15 rad | HUMANOID.md; SD |
| Get-up kneel easing; support hold | 1.2 s; 0.1 s | SD |
| Push duration | 0.1 s | SIMBICON protocol |

## 5. Phone controls

| Input | Effect |
| --- | --- |
| Stick or trackpad (`classical()`, deadzone 0.05) | `v_d = R(ψ)(x, z)` × maximum speeds; soft wall at ±3.3 m |
| Yaw axis or twist | `ψ_d` rate up to 1.0 rad/s |
| Existing tray presets | Unchanged, upper body only |
| Tray `push` | Class C toe-ward push on your own actor |
| Tray `getup` | Starts get-up once settled (automatic after 1.5 s) |
| Tray `stand` | Cancels gait and presets; balance |
| Host keys | P, Shift+P, O: push B, C, D; G get up; Space stand; R reset arena |

New buttons append to `layout.tray`; pads use the next free `padPressed` bits. On input loss, intent rests and BODY weight goes to 0, but balance keeps running. Only an explicit Stop calls `quiet()`, which would drop the actor.

## 6. BODY follow

The upper body tracks while the legs balance. Per joint, BODY targets are slerped over controller targets by `w = w_track · w_mode · w_margin`:

- `w_track`: 0→1 over 150 ms on acquisition; on loss, hold, then 0 over 250 ms.
- `w_mode`: 1.0 standing, 0.8 walking, 0.3 recovering, 0 falling or getting up.
- `w_margin`: shoulder pitch and roll scale down to 0.5 as the `ξ` margin falls from 0.04 m to 0.

BODY never commands the root, so the F1c heading-spin fault cannot reach this actor; it remains kinematic-page work. Arm momentum appears in the COM that balance already uses (Zordan–Hodgins: track the upper body, balance the lower).

## 7. Acceptance tests

Node native suites (`tests/humanoid-control-*.test.ts`) run all eight forms, print JSON before asserting and fail on missing trials. Pure unit tests cover signs, the state machine, capture maths and weights.

The contact-v3 native checkpoint passes the unchanged W1, W2 and W3 gates on
both pilots. Penetration below is the maximum over every dynamic collider and
every measured tick, including settle. Each row also passes five perturbed
starts; the figures in this table describe the nominal start.

| Pilot | W1: distance / time / last-3-m speed / penetration | W2: return / penetration | W3: turn / penetration |
| --- | --- | --- | --- |
| Keel | 5.000 m / 16.529 s / 0.369 m/s / 3.517 mm | 1.071 s / 3.624 mm | 4.272 rad / 3.566 mm |
| Morrow | 5.001 m / 17.988 s / 0.327 m/s / 3.562 mm | 2.883 s / 4.172 mm | 4.006 rad / 3.586 mm |

Both W2 rows hold stance for ten seconds; W3 lasts ten seconds. These results
do not establish sustained walking after an interrupted stop. Keel's 30-second
in-place and turn-in-place fallbacks pass at 3.670 and 3.776 mm. Morrow's same
30-second rows pass at 3.518 and 3.077 mm after the compact-geometry spine
transfer change. Both pilots also pass both release stops. Get-up recovery
remains 0/16. Its finite-state, effort and completion checks do not imply a
penetration pass: the Keel world-prone fixture reaches 7.151 mm including its
initial hold. The native push checkpoint passes A 8/8, B 6/8 and nominal C 1/8; the C
success fails two of five perturbed starts. A shared friction-based yaw request
cap was rejected because it broke a previously passing perturbed Morrow stop.
The relative tick-time gate and final integrated validation remain separate
requirements; these physical results alone do not establish lane acceptance.

**Push table** (N s, 0.1 s at the thorax, relative to facing). Class C exceeds the ankle-only capacity `m ω(margin - 0.02)` toe- and heel-ward:

| Class | Toe | Heel | Lateral | Diagonal | Pass |
| --- | ---: | ---: | ---: | ---: | --- |
| A | 10 | 5 | 10 | 5 | Every tick: up Y ≥ 0.98, pelvis ≥ 90% h₀, penetration ≤ 5 mm, effort ≤ cap; no foot unloaded > 0.1 s |
| B | 18 | 9 | 18 | 9 | No fall (no non-foot floor impulse, pelvis ≥ 80%); within 2 s, up Y ≥ 0.98, pelvis ≥ 90% and both feet loaded, held 2 s |
| C | 40 | 20 | 30 | 20 | As B; ≤ 3 steps; within 4 s |
| D | 150 | 150 | 150 | 150 | Bounded fall: no fault or non-finite state; settles ≤ 3 s; then G3 |

**Walking.**
- W1: stick 1.0 covers 5.0 m in ≤ 20 s with no fall, penetration ≤ 5 mm and effort ≤ cap; mean speed over the last 3 m is 0.3–0.6 m/s.
- W2: release returns to stance within 3 s, held 10 s.
- W3: forward 0.6 with yaw 1.0 turns ≥ 3 rad in 10 s.
- W4: 1 m backward and 1 m sideways, each ≤ 10 s.
- W5: ten 20 N s pushes at 5 s intervals while walking, with no fall.

**Get-up.**
- G1 (prone) and G2 (supine) start from posture fixtures after a 2 s hold. Each must hold the stance envelope for 2 s within 10 s (prone) or 14 s (supine), with effort ≤ cap.
- G3: a class D push, the fall, then stance within 20 s.

**Two actors.**
- I1: with `seat2` pushed (class C) 2 m away, `seat1` matches a one-actor run within 1e-6 SI at every tick.
- I2: wrong-actor frames are rejected. One seat's loss, quiet or new generation leaves the other's generation, targets and journal untouched.
- I3: a jab at 0.7 m transfers a positive impulse; reported, not thresholded.
- R1: the journal, including disturbances, replays 480 ticks at 60/30/120 Hz within 1e-6.

**BODY.** Synthetic traces drive `seat1`, then `seat2`. While standing, upper-body error has median ≤ 0.15 rad and p95 ≤ 0.35 rad (SD), and the stance envelope holds throughout. On loss the weight reaches 0 in 250 ms. The other seat stays unchanged.

**Frame budget.** Browser, named GPU desktop, 1280×800, DPR 1. Two actors walk while BODY drives `seat1`. After a 60 s warm-up, 120 s (5 min in the final run) must show main-thread work per frame at p95 ≤ 16.7 ms and p99 ≤ 25 ms, with zero dropped time. With the worker host, worker utilisation must stay ≤ 80%. Gate work time, not interval: a 60 Hz interval reads 16.8–16.9 ms.

## 8. Lanes

**Step 0, coordinator, T0 to T+1 h.** Merge `codex/f1a2-reconcile`, keeping its stance gates and 24 `it.fails`. Commit `targets.ts` with tests, the `Behaviour` and `Intent` types and this document. If F1a2 is held, put Step 0 on `hc-base` from it and start lanes with `--base hc-base`.

All four lanes start at T+1 h, before F1a2 or any lane merges into master. Round 1 needs only `HumanoidPilot` and Step 0.

| Lane | Round 1 (T+1 to T+4 h) | Round 2 (T+4.5 to T+9.5 h) | Owns |
| --- | --- | --- | --- |
| A `hc-world` | World, observation fields, per-island solve and contact cache (rerun F1a2 stance), pushes and fixtures, journal, supervisor registry; I1, I2, R1; world-tick probe | Demo page, route, phone and BODY wiring; worker host if world tick p95 > 1.2 ms; browser group; frame budget | `world.ts`, `supervisor.ts`, `observation.ts`, `demo.ts`, `world.worker.ts`, `src/sim/physics/{coupled-servo,constraint-response,forces}.ts`, page HTML, `vite.config.ts`, `scripts/e2e-humanoid-physics.mjs` |
| B `hc-balance` | Balance and stepping; capture and Jacobian-transpose unit tests; native quiet stance | Push table on the world; balance and recover behaviours | `balance.ts`, `stepping.ts`, tests |
| C `hc-gait` | Gait and intent; native W1–W3 for Keel and Morrow on the pilot | All forms; W4, W5; stop to balance; two actors walking | `gait.ts`, `intent.ts`, tests |
| D `hc-getup-body` | Get-up from lean-induced falls on the pilot (holding lean targets topples it); upper body; BODY unit tests | G1–G3 on world fixtures; upper body under gait and pushes | `getup.ts`, `upper-body.ts`, tests |

Merges go in order A, B, C, D at T+4 and T+9.5 h. Round 3 (T+10 to T+12 h) fixes red rows only and records the rehearsal take. Only lane A runs browser suites, so the GPU lock stays free.

## 9. Demo page

`/sim/humanoid/physics/` (new HTML → `demo.ts`) takes the same `'wasm-unsafe-eval'` allowance, an early-page entry and the Vite input `simHumanoidPhysics`.

`/sim/humanoid/` stays the default kinematic practice, unchanged except for a "Physics preview" link; the new page links back. The new page reuses:

- `Seats` and claims (seat N drives `seatN`) and `LocalControls`;
- `Retargeter` and calibration;
- `Rig`, skins and LOD via `poseWorld(renderFrames())`;
- the arena, lighting, sound bus (footfalls from load onsets) and panels.

It drops `ActorControl`, `FootBalance` and tendons. The status strip shows each actor's mode, source and gates, with anatomy shown red.

The presentation page keeps balance as its default. Its opt-in **Walk (experimental)** toggle is limited to stepping and turning in place. The left stick requests stepping and yaw through `intent.ts`; release finishes the step before returning to balance. BODY is paused while gait owns the legs. The HUD reports the live gait state and peak measured foot penetration. The v3 native walking and separate fallback acceptance rows pass; the retained mixed command sequence has narrower measured coverage described above. Reset rebuilds the arena after a fall or a recoverable worker error.

Fallbacks, in order:

1. Rapier or WASM failure: the page says so and links to practice, with no substitution.
2. Over budget: DPR 1.0, then shadows off, then worker host, then pause actor 2 with a notice. Tick rate and gates never change.
3. Two failed get-ups: the actor shows Down, with Reset arena.
4. Replay take: a deterministic replay of a recorded journal (`source: 'replay'`, labelled). It is real physics, not video.
5. Without BODY, stick and presets keep working.

## 10. Risks and cut order

Most likely to slip, in order:

1. Get-up P3–P4 contact transitions under the slew and caps.
2. The two-actor frame budget.
3. Lateral gait balance and foot-box self-contact.
4. Class C heel and lateral pushes.
5. BODY wiring into both seats.
6. The new route's effect on the pages, catalogue and CSP suites.

Cut first to last:

1. Anatomy closure (stays red).
2. Gravity compensation and velocity tuning.
3. W5.
4. W4.
5. Supine roll (demo pushes from behind give prone falls).
6. I3.
7. The six non-default forms (tests stay, red allowed).
8. Live two-actor physics on stage, replaced by the replay take.

Never cut: gate invariants, the free pelvis, the push table, I1/I2 and honest red reporting.

## Sources

1. Yin, Loken, van de Panne, "SIMBICON", SIGGRAPH 2007 (state machine, swing-hip feedback, torso/stance-hip, Table 1, gains, push protocol). [PDF](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf)
2. Coros, Beaudoin, van de Panne, "Generalized Biped Walking Control", SIGGRAPH 2010. [PDF](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/paper.pdf)
3. Pratt, Carff, Drakunov, Goswami, "Capture Point", Humanoids 2006 ([record](https://cs.utexas.edu/~shivaram/readings/b2hd-PrattCDG2006.html)); dynamics as restated in [arXiv:1612.08034](https://arxiv.org/abs/1612.08034), eqs. 3–8.
4. Pratt et al., "Virtual Model Control", IJRR 20(2), 2001. [PDF](https://www.ftp.ai.mit.edu/people/jpratt/virt_mod.pdf)
5. Raibert, *Legged Robots That Balance*, 1986: `x_f = ẋT_s/2 + k(ẋ - ẋ_d)`, as restated in [arXiv:2005.11134](https://arxiv.org/abs/2005.11134).
6. Stückler, Schwenk, Behnke, "Getting Back on Two Feet", IAS-9 2006. [PDF](https://www.ais.uni-bonn.de/behnke/papers/IAS9.pdf)
7. Faloutsos, van de Panne, Terzopoulos, "Composable Controllers", SIGGRAPH 2001. [PDF](https://www.cs.ubc.ca/~van/papers/2001-siggraph-composable.pdf)
8. Zordan, Hodgins, "Motion Capture-Driven Simulations that Hit and React", SCA 2002. [Record](https://www.ri.cmu.edu/publications/motion-capture-driven-simulations-that-hit-and-react)
9. Peng et al., "DeepMimic", SIGGRAPH 2018 (actions as PD targets). [arXiv](https://arxiv.org/abs/1804.02717)
10. Gong and Grizzle, "Zero Dynamics, Pendulum Models, and Angular Momentum in Feedback Control of Bipedal Locomotion" (ALIP prediction and terminal-velocity placement; concepts only). [arXiv](https://arxiv.org/abs/2105.08170)
11. Hansen, "The CMA Evolution Strategy: A Tutorial" (deterministic native parameter search; concepts only). [arXiv](https://arxiv.org/abs/1604.00772)

Only algorithms are adapted; no third-party code, parameters or assets are copied. Any implementation a lane reads must be MIT, Apache-2.0 or BSD and credited in `src/support/open-source.json`.
