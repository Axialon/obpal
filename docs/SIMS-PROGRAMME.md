# Sims programme: source audit and bounded migration plan

Status: **F0 pendulum proof accepted; F0-R backend implementation pending native/browser integration acceptance**, not programme completion. Audit baseline is exported private master
`8b3e6d0ed26afd05712b66fb5ec62c6dbb12796c`, mirrored by public snapshot
`1ac64107e3b884e1920696148d95c2bf674598ae`. The supplied checkpoint is not a new test run.
The H1 brief is included as an appendix to the supplied TASK, rather than as a separate H1-brief file.
Only the pendulum is migrated in this return. Hardware drivers, the wire protocol, all other sims,
model assets, the landed reveal/governor behaviour and dependency files are unchanged.

## Reading the scores

These are **provisional source-review scores**, not observed visual quality or measured physical fidelity.
No shipped GLBs, Blender runtime, browser or reference phone were available in this exported-scope environment.
Every score needs the measurements below before it becomes a release decision. In particular, a score of 1
can mean evidence is absent; it is not a claim that an unseen asset looks poor. No overall score or average is used.

| Axis | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| Design (D) | Missing inspectable authoring or no model yet | Coherent procedural construction | Authored family geometry and explicit pivots | Reviewed silhouette/clearance/LOD captures | Exceptional quality demonstrated across target views |
| Physics (P) | No dynamics or not appropriate to task | Kinematics, servos or game approximations | Bounded task-specific dynamic integration | Validated contact/actuator model | Reference-calibrated dynamics within a documented envelope |
| Smoothness (S) | Missing coverage or explicit gating | Shared protections exist; motion not measured | Instrumented motion passes locally | Desktop and phone stress cases pass | Sustained cross-device evidence and regression margin |
| Controls (C) | No playable controls/evidence | Intended mappings or model inherits a pending controller | Explicit bounded mappings and testable state | Validated task completion and source switching | Measured low-latency accessibility and broad hardware coverage |

The scored unit is the implementation, not the sophistication of the real machine. A lamp can be correct
without rigid dynamics; P=1 is not a request to add gratuitous physics. Model P/C are inherited from the
consumer, not properties of a mesh.

### Shared risk codes and evidence

**D (draw path):** [view.ts](../src/sim/view.ts), [reveal.ts](../src/sim/kit/reveal.ts),
[models.ts](../src/sim/kit/models.ts), and [prototype.ts](../src/sim/kit/prototype.ts) separate download,
decode, reveal and adaptive rendering. The landed hold/reveal code already exists: preserve it and test cold,
delayed, failed and warm downloads. This review does not conclude it is currently broken.

**M (moving model):** inspect each view's attachment points, transformed bounds, material batching and
late skin installation. Independent rigid bounds matter; disabling all frustum culling is not an acceptable
blanket fix. **F (fast motion):** test contact steps and input timing while the governor reduces drawing.
Simulation time must not silently become render time. **L (LOD):** preserve pivot state and geometry coverage
through hysteresis, delayed loads and model changes; deliberate swaps need a wave-specific allowlist and evidence.

## Every registered device

Registry: [registry.ts](../src/sim/devices/registry.ts). All 33 IDs are listed. Links point to the baseline logic's
step and each corresponding view (design/attachment evidence). Common control handling is in
[common.ts](../src/sim/devices/common.ts), [input.ts](../src/sim/devices/input.ts) and each SPEC/how/tray.
The listed follow-up is the measurement or modelling gap, not a claim that its failure was observed.

| Device | D/P/S/C | What the source implements | Risks | File-level evidence | Required follow-up |
| --- | --- | --- | --- | --- | --- |
| jib | 3/2/2/3 | Levelled camera at a parameter-driven yaw/boom; counterbalance is not a solved mass system. | D, M | [logic](../src/sim/devices/jib.ts#L40); [view](../src/sim/devices/jib.view.ts#L1) | Counterweight torque and camera load; keep levelling and range stops. |
| slider | 3/2/2/3 | Authored keyframes follow an endpoint-smooth trajectory; camera motion is kinematic. | D, M | [logic](../src/sim/devices/slider.ts#L35); [view](../src/sim/devices/slider.view.ts#L1) | Jerk and pose continuity at keyframe edit, reverse and restart. |
| trebuchet | 2/2/2/3 | Launch speed comes from a weight formula; the projectile is ballistic, not a coupled sling/counterweight mechanism. | D, F | [logic](../src/sim/devices/trebuchet.ts#L27); [view](../src/sim/devices/trebuchet.view.ts#L1) | Release angle and energy accounting; do not market the toy formula as engineering prediction. |
| pendulum | 2/3/2/3 | Nonlinear gravity and damping, bounded substeps, angular/speed stops; no general contact solver. F0 changes only this sim. | D, F | [logic](../src/sim/devices/pendulum.ts#L28); [view](../src/sim/devices/pendulum.view.ts#L1) | Energy, period, timestep partition, sleep/wake, history and replicated guest state. |
| telescope | 2/1/2/3 | Aiming at a curated sky with bounded pan/tilt; not ephemerides or optical ray tracing. | D | [logic](../src/sim/devices/telescope.ts#L41); [view](../src/sim/devices/telescope.view.ts#L1) | Axis stops, wrap and simultaneous touch/pose ownership. |
| planetary | 3/3/2/3 | Low-gravity vertical motion, sampled ground, kinematic sampler and finite rock collection. | D, M, F | [logic](../src/sim/devices/planetary.ts#L40); [view](../src/sim/devices/planetary.view.ts#L1) | Wheel support and touchdown energy; sampler payload feedback. |
| marblerun | 2/3/2/3 | Bounded substepped planar marble motion constrained by authored track channels. | D, F | [logic](../src/sim/devices/marblerun.ts#L45); [view](../src/sim/devices/marblerun.view.ts#L1) | High-speed corner contacts and track-edit reset; rolling inertia remains absent. |
| football | 2/3/2/3 | Ball and rod/player interactions use a planar game model, not motorised rods and volumetric contact. | D, F | [logic](../src/sim/devices/football.ts#L40); [view](../src/sim/devices/football.view.ts#L1) | Fast ball tunnelling, moving-rod momentum and serve fairness. |
| rover | 3/3/2/3 | Steering response, drive integration, ground sampling, fence/cone contacts; not independent tyre-load dynamics. | D, M, F | [logic](../src/sim/devices/rover.ts#L195); [view](../src/sim/devices/rover.view.ts#L1) | Suspension support and off-road steering; preserve wheel/gamepad/point-to-drive mappings. |
| drone | 3/2/2/3 | Stabilised velocity/height response and bounded collisions; not a full thrust-and-torque airframe. | D, M, F | [logic](../src/sim/devices/drone.ts#L230); [view](../src/sim/devices/drone.view.ts#L1) | Motor lag, tilt/thrust coupling and collision recovery without losing approachable controls. |
| maze | 2/3/2/3 | Seeded maze, tilt-driven marble and wall impulses; game-scale planar mechanics. | D, F | [logic](../src/sim/devices/maze.ts#L244); [view](../src/sim/devices/maze.view.ts#L1) | Thin-wall collision, holes and replay seed stability. |
| ptz | 3/2/2/3 | Bounded pan/tilt/zoom aims a camera; view target is not a torque-driven head. | D, M | [logic](../src/sim/devices/ptz.ts#L192); [view](../src/sim/devices/ptz.view.ts#L1) | Pan seam, lens range and target continuity at source changes. |
| lamp | 2/1/2/3 | Colour, brightness and power state with parsing and multiple input styles; rigid physics is unnecessary. | D | [logic](../src/sim/devices/lamp.ts#L145); [view](../src/sim/devices/lamp.view.ts#L1) | Colour/power changes without false flash alarms; input intent and accessible status. |
| claw | 2/2/2/3 | Drop/close/lift/carry/open state machine with geometric grasp conditions, not force/friction closure. | D, F | [logic](../src/sim/devices/claw.ts#L156); [view](../src/sim/devices/claw.view.ts#L1) | Payload slips, jaw contact and release; avoid arbitrary attachment as the final physics model. |
| studio | 3/1/2/3 | Instrument events and damped visual envelopes; audio scheduling lives outside the frame loop. | D, M | [logic](../src/sim/devices/studio.ts#L46); [view](../src/sim/devices/studio.view.ts#L1) | Audio-to-motion phase and changing note geometry; do not force an irrelevant rigid solver. |
| boat | 3/2/2/3 | Steering/throttle response and bounded harbour travel; rendered attitude is not submerged-volume buoyancy. | D, M, F | [logic](../src/sim/devices/boat.ts#L55); [view](../src/sim/devices/boat.view.ts#L1) | Heave/roll, thrust at an offset and drag; water surface is not a contact plane. |
| spotlights | 2/2/2/3 | Moving-head pan/tilt approach mechanical targets within stops. | D | [logic](../src/sim/devices/spotlights.ts#L40); [view](../src/sim/devices/spotlights.view.ts#L1) | Angular wrap, beam clipping and intended brightness transitions. |
| vacuum | 3/2/2/3 | Furniture/dust/docking logic with a moving footprint; no independently loaded drive wheels. | D, M | [logic](../src/sim/devices/vacuum.ts#L90); [view](../src/sim/devices/vacuum.view.ts#L1) | Thin obstacles, dock path and user override of automation. |
| tank | 3/2/2/3 | Independent turret and gravity-driven practice balls; hull travel does not solve track contact patches. | D, M, F | [logic](../src/sim/devices/tank.ts#L77); [view](../src/sim/devices/tank.view.ts#L1) | Skid steering, obstacle traction and recoil impulse boundaries. |
| excavator | 3/2/2/3 | Articulated boom/stick/bucket coordinates and bounded sand transfer; not hydraulic or granular dynamics. | D, M | [logic](../src/sim/devices/excavator.ts#L107); [view](../src/sim/devices/excavator.view.ts#L1) | Cylinder linkage, payload torque, tipping and bucket/ground contact. |
| forklift | 3/2/2/3 | Vehicle/fork pose and conditional pallet handling; lacks load-dependent support forces. | D, M | [logic](../src/sim/devices/forklift.ts#L74); [view](../src/sim/devices/forklift.view.ts#L1) | Mast loading, pallet slip and stability with a raised load. |
| painter | 2/1/2/3 | Held movement writes a bounded light-stroke history; no rigid dynamics is required. | D | [logic](../src/sim/devices/painter.ts#L66); [view](../src/sim/devices/painter.view.ts#L1) | Stroke breaks, bounded geometry growth and phone pose recentering. |
| gimbal | 3/2/2/3 | Camera-orientation control with constrained rig geometry; stabilisation is not motor/load dynamics. | D, M | [logic](../src/sim/devices/gimbal.ts#L50); [view](../src/sim/devices/gimbal.view.ts#L1) | Heading seam, motor range and camera inertia without Euler flips. |
| plane | 3/2/2/3 | Power builds speed, bank turns and low speed loses height; a forgiving trainer approximation. | D, M, F | [logic](../src/sim/devices/plane.ts#L70); [view](../src/sim/devices/plane.view.ts#L1) | Lift/drag curves, stall recovery and consistent ground contact. |
| slotcars | 3/3/2/3 | Track-parametric cars release when lateral acceleration is excessive; free-flight motion then decays. | D, M, F | [logic](../src/sim/devices/slotcars.ts#L66); [view](../src/sim/devices/slotcars.view.ts#L1) | Constraint release/re-entry, lap crossing and derail continuity. |
| dog | 3/2/2/3 | Procedural gait and leg placement/IK; not an articulated torque-controlled quadruped. | D, M | [logic](../src/sim/devices/dog.ts#L81); [view](../src/sim/devices/dog.view.ts#L1) | Stance contacts, support polygon and body response to uneven ground. |
| sorting | 2/2/2/3 | Independent cells route finite parts through a controlled sorting sequence. | D | [logic](../src/sim/devices/sorting.ts#L71); [view](../src/sim/devices/sorting.view.ts#L1) | Contact-driven conveyor/pusher only where it improves the task; keep counts and isolation. |
| kart | 3/2/2/3 | Free-steering planar travel and ordered forward lap gates; no suspension/tyre load transfer. | D, M, F | [logic](../src/sim/devices/kart.ts#L43); [view](../src/sim/devices/kart.view.ts#L1) | Lateral grip, braking distance and simultaneous car contact. |
| helicopter | 3/2/2/3 | Stabilised collective/cyclic response with velocity and arena clamps; no rotor-disc force model. | D, M, F | [logic](../src/sim/devices/helicopter.ts#L50); [view](../src/sim/devices/helicopter.view.ts#L1) | Rotor thrust/lag, yaw torque and safe bounded landing. |
| submarine | 3/2/2/3 | Ballast, water-drag response and bounded depth with sonar pulses; not coupled six-axis hydrodynamics. | D, M, F | [logic](../src/sim/devices/submarine.ts#L48); [view](../src/sim/devices/submarine.view.ts#L1) | Neutral trim, centre-of-buoyancy offset and drag sign. |
| smarthome | 2/1/2/3 | Four claimed appliance states and explicit shared scenes; physics would not make the core task more truthful. | D | [logic](../src/sim/devices/smarthome.ts#L58); [view](../src/sim/devices/smarthome.view.ts#L1) | Seat isolation and intentional scene transitions without false visibility failures. |
| airhockey | 2/3/2/3 | Planar puck/mallet collisions with play-area restrictions; not full rigid spin/contact mechanics. | D, F | [logic](../src/sim/devices/airhockey.ts#L41); [view](../src/sim/devices/airhockey.view.ts#L1) | Moving mallet energy, high-speed goal crossing and ownership. |
| pinball | 2/3/2/3 | Bounded table-plane substeps, rails and moving flippers; lacks full rolling/spin mechanics. | D, F | [logic](../src/sim/devices/pinball.ts#L91); [view](../src/sim/devices/pinball.view.ts#L1) | Flipper momentum, tunnelling and stable resting contacts. |

## Arms, humanoids, arena and continuum

Arm control evidence includes [kin.ts](../src/sim/arm/kin.ts), [grasp.ts](../src/sim/arm/grasp.ts),
[kinds.ts](../src/sim/arm/kinds.ts) and each kind below. Kinematic grasp/contact bookkeeping is not an
articulated frictional grasp solver. Do not change the real-driver paths to make the simulation dynamic.

| Sim/model family | D/P/S/C | Source finding and risk | File evidence and measurement |
| --- | --- | --- | --- |
| arm/arm5 | 3/2/2/3 | Five-axis serial chain, forward/inverse geometry and constrained gripper; add motor/load tests, not a new skin first. D, M. | [arm5](../src/sim/arm/kind/arm5.ts#L1); authored source in the model inventory. |
| arm/so101 | 3/2/2/3 | SO-101 joint layout is explicit; retain existing offsets, calibration and twin/real separation. Compare sim torque limits to cited actuator data, never write hardware settings. D, M. | [so101](../src/sim/arm/kind/so101.ts#L1); authored source in the model inventory. |
| arm/six | 3/2/2/3 | Six-axis chain with a spherical wrist; test IK branch continuity and joint-space motor limits near singularities. D, M. | [six](../src/sim/arm/kind/six.ts#L1); authored source in the model inventory. |
| arm/scara | 3/2/2/3 | Planar two-link reach, vertical quill and tool orientation; test prismatic force limits and payload contact. D, M. | [scara](../src/sim/arm/kind/scara.ts#L1); authored source in the model inventory. |
| arm/delta | 3/2/2/3 | Parallel linkage geometry; a serial-chain approximation would lose the loop closure. Measure constraint error before adoption. D, M. | [delta](../src/sim/arm/kind/delta.ts#L1); authored source in the model inventory. |
| arm/desk | 3/2/2/3 | Four-axis/parallelogram geometry; preserve level tool motion and test loop closure under load. D, M. | [desk](../src/sim/arm/kind/desk.ts#L1); authored source in the model inventory. |
| Humanoid: Keel | 3/1/2/3 | Joint transforms/retarget, not a gravity/contact-supported actor; D, M, L. | [profile](../src/sim/humanoid/profile.ts), [rig](../src/sim/humanoid/rig.ts), [retarget](../src/sim/humanoid/retarget.ts), [models](../src/sim/humanoid/models.ts). Measure sole gaps, root heading and part coverage. |
| Humanoid: Morrow | 3/1/2/3 | Same dynamic gap with its own profile; model swapping must preserve identity and joints. | Same profile/rig/model paths; test Morrow independently, not only Keel. |
| Humanoid: Cairn I / II | 3/1/1/2 | Soft forms are preview-gated; no acceptance inferred from authoring complexity. | [preview](../src/sim/humanoid/preview.ts), [soft authoring](../assets/blender/humanoids_soft.py), profile/rig. Both forms and LODs need motion proofs. |
| Humanoid: Rill I / II | 3/1/1/2 | Same gate; independently inspect rounded covers, folded-limb coverage and finish. | Same soft authoring and profile/rig; both forms need their own coverage records. |
| Humanoid: Hush I / II | 3/1/1/2 | Same gate; technical-knit details and hand/foot silhouette need actual captures. | Same soft authoring and profile/rig; inspect close-up and distant transitions. |
| Faction arena | 2/3/2/3 | Planar puck velocity/contact and falling presentation; four insignias load separately. D, M, F. | [arena.ts](../src/sim/arena.ts), especially FACTIONS/loader and update loop. Test all four occupied seats, not an empty ring. |
| Octopus (Cove), Stage A | 2/1/2/2 | `/sim/octopus/` is a device-registry sim (coordinator decision, 2026-10-03): one seat, a dry studio, yaw-only body. Planted arms are placed by a bounded damped least-squares solve over the PCC sections and step by contact and reach, never fewer than four planted; free arms follow the routed tendon elasticity. Kinematic placement with elastic smoothing, not rod dynamics or contact forces; the model is procedural, not a Blender rig. | [logic](../src/sim/devices/octopus.ts), [solver](../src/sim/continuum/solve.ts), [view](../src/sim/devices/octopus.view.ts), [OCTOPUS](OCTOPUS.md), `tests/octopus.test.ts`, `OBPAL_E2E_SIMS_ONLY=octopus`. Water, climbing, a second seat, capture mappings and the Blender rig remain deferred; never call the hydrostatic parameterisation a validated rod solver. |

The owner's reported humanoid hovering/spinning/disappearing is recorded in the task. The source supports
investigating kinematic root placement and Euler-axis limits. It does **not** prove whether a particular live
spin was caused by a pelvis mirror flip, yaw wrap or a stale bound; F1 must capture and isolate that cause.

## Every registered mesh and other loaded model

[Prototype](../src/sim/kit/models.ts) declares 41 GLB names. The arena separately names four CVC insignias:
45 model paths in total. The `public/models/README.md` in this export documents camera ML assets, not these GLBs.
No GLB bytes are included; byte counts, actual triangles, materials and rendered silhouette are **not verified**.
Each model is individually listed, including low-detail variants. Procedural-only models are covered by their
device/arena view rows above. Shared primitives are code, not additional shipped GLB assets.

| GLB stem (under public/models) | D/P/S/C | Authoring/consumer evidence | Distinct review requirement |
| --- | --- | --- | --- |
| drone | 3/2/2/3 | [drone.py](../assets/blender/drone.py#L1); [consumer](../src/sim/devices/drone.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| so101 | 3/2/2/3 | [so101.py](../assets/blender/so101.py#L1); [consumer](../src/sim/arm/kind/so101.ts#L1) | Named moving pivots, actuator sleeve/rod travel and grip clearance; no geometry-derived mass assumption. |
| rover | 3/3/2/3 | [rover.py](../assets/blender/rover.py#L1); [consumer](../src/sim/devices/rover.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| arm5 | 3/2/2/3 | [arms.py](../assets/blender/arms.py#L1); [consumer](../src/sim/arm/kind/arm5.ts#L1) | Named moving pivots, actuator sleeve/rod travel and grip clearance; no geometry-derived mass assumption. |
| six | 3/2/2/3 | [arms.py](../assets/blender/arms.py#L1); [consumer](../src/sim/arm/kind/six.ts#L1) | Named moving pivots, actuator sleeve/rod travel and grip clearance; no geometry-derived mass assumption. |
| scara | 3/2/2/3 | [arms.py](../assets/blender/arms.py#L1); [consumer](../src/sim/arm/kind/scara.ts#L1) | Named moving pivots, actuator sleeve/rod travel and grip clearance; no geometry-derived mass assumption. |
| delta | 3/2/2/3 | [arms.py](../assets/blender/arms.py#L1); [consumer](../src/sim/arm/kind/delta.ts#L1) | Named moving pivots, actuator sleeve/rod travel and grip clearance; no geometry-derived mass assumption. |
| desk | 3/2/2/3 | [arms.py](../assets/blender/arms.py#L1); [consumer](../src/sim/arm/kind/desk.ts#L1) | Named moving pivots, actuator sleeve/rod travel and grip clearance; no geometry-derived mass assumption. |
| helicopter | 3/2/2/3 | [flyers.py](../assets/blender/flyers.py#L1); [consumer](../src/sim/devices/helicopter.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| plane | 3/2/2/3 | [flyers.py](../assets/blender/flyers.py#L1); [consumer](../src/sim/devices/plane.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| kart | 3/2/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/kart.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| boat | 3/2/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/boat.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| tank | 3/2/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/tank.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| forklift | 3/2/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/forklift.view.ts#L1) | D, M; moving-part bounds and material batches. |
| excavator | 3/2/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/excavator.view.ts#L1) | D, M; moving-part bounds and material batches. |
| slotcars | 3/3/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/slotcars.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| planetary | 3/3/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/planetary.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| submarine | 3/2/2/3 | [vehicles.py](../assets/blender/vehicles.py#L1); [consumer](../src/sim/devices/submarine.view.ts#L1) | D, M, F; moving-part bounds and material batches. |
| vacuum | 3/2/2/3 | [cameras.py](../assets/blender/cameras.py#L1); [consumer](../src/sim/devices/vacuum.view.ts#L1) | D, M; moving-part bounds and material batches. |
| film-camera | 3/2/2/3 | [cameras.py](../assets/blender/cameras.py#L1); [consumer](../src/sim/devices/jib.view.ts#L1) | Shared by jib and slider; verify both mount frames and lens/camera alignment. |
| gimbal | 3/2/2/3 | [cameras.py](../assets/blender/cameras.py#L1); [consumer](../src/sim/devices/gimbal.view.ts#L1) | D, M; moving-part bounds and material batches. |
| ptz | 3/2/2/3 | [cameras.py](../assets/blender/cameras.py#L1); [consumer](../src/sim/devices/ptz.view.ts#L1) | D, M; moving-part bounds and material batches. |
| dog | 3/2/2/3 | [dog.py](../assets/blender/dog.py#L1); [consumer](../src/sim/devices/dog.view.ts#L1) | D, M; moving-part bounds and material batches. |
| studio | 3/1/2/3 | [studio.py](../assets/blender/studio.py#L1); [consumer](../src/sim/devices/studio.view.ts#L1) | D, M; moving-part bounds and material batches. |
| keel | 3/1/2/3 | [humanoids.py](../assets/blender/humanoids.py#L1); [consumer](../src/sim/humanoid/models.ts#L1) | Profile hierarchy, shoulder/hip sleeve clearance and hero silhouette and independent-axis sweep; simultaneous poses still need checking. |
| morrow | 3/1/2/3 | [humanoids.py](../assets/blender/humanoids.py#L1); [consumer](../src/sim/humanoid/models.ts#L1) | Profile hierarchy, shoulder/hip sleeve clearance and hero silhouette and independent-axis sweep; simultaneous poses still need checking. |
| keel-lod | 3/1/2/3 | [humanoids.py](../assets/blender/humanoids.py#L1); [consumer](../src/sim/humanoid/models.ts#L1) | Profile hierarchy, shoulder/hip sleeve clearance and 10k distant LOD; preserve all joint and finger frames. |
| morrow-lod | 3/1/2/3 | [humanoids.py](../assets/blender/humanoids.py#L1); [consumer](../src/sim/humanoid/models.ts#L1) | Profile hierarchy, shoulder/hip sleeve clearance and 10k distant LOD; preserve all joint and finger frames. |
| humanoid-arena | 3/1/2/2 | [humanoid_arena.py](../assets/blender/humanoid_arena.py#L1); [consumer](../src/sim/humanoid/models.ts#L1) | Static arena geometry is not a collider; preserve fins/alpha order and measured two-actor scene budget. |
| cairn-i | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; cairn-i must retain folded-limb/finger coverage at hero detail; validate finish and proportions from captures. |
| cairn-ii | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; cairn-ii must retain folded-limb/finger coverage at hero detail; validate finish and proportions from captures. |
| rill-i | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; rill-i must retain folded-limb/finger coverage at hero detail; validate finish and proportions from captures. |
| rill-ii | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; rill-ii must retain folded-limb/finger coverage at hero detail; validate finish and proportions from captures. |
| hush-i | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; hush-i must retain folded-limb/finger coverage at hero detail; validate finish and proportions from captures. |
| hush-ii | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; hush-ii must retain folded-limb/finger coverage at hero detail; validate finish and proportions from captures. |
| cairn-i-lod | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; cairn-i must retain folded-limb/finger coverage at distant LOD. |
| cairn-ii-lod | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; cairn-ii must retain folded-limb/finger coverage at distant LOD. |
| rill-i-lod | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; rill-i must retain folded-limb/finger coverage at distant LOD. |
| rill-ii-lod | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; rill-ii must retain folded-limb/finger coverage at distant LOD. |
| hush-i-lod | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; hush-i must retain folded-limb/finger coverage at distant LOD. |
| hush-ii-lod | 3/1/1/2 | [humanoids_soft.py](../assets/blender/humanoids_soft.py#L1); [consumer](../src/sim/humanoid/preview.ts#L1) | Preview only; hush-ii must retain folded-limb/finger coverage at distant LOD. |
| cvc/CVC_insignia | 1/3/2/3 | [FACTIONS + loader](../src/sim/arena.ts#L103) | Authoring/asset bytes not exported; inspect credits, normalised scale, late arrival and occupied-seat reveal. Design evidence is missing, not a negative visual verdict. |
| cvc/CC_insignia | 1/3/2/3 | [FACTIONS + loader](../src/sim/arena.ts#L103) | Authoring/asset bytes not exported; inspect credits, normalised scale, late arrival and occupied-seat reveal. Design evidence is missing, not a negative visual verdict. |
| cvc/K9C_insignia | 1/3/2/3 | [FACTIONS + loader](../src/sim/arena.ts#L103) | Authoring/asset bytes not exported; inspect credits, normalised scale, late arrival and occupied-seat reveal. Design evidence is missing, not a negative visual verdict. |
| cvc/MMC_insignia | 1/3/2/3 | [FACTIONS + loader](../src/sim/arena.ts#L103) | Authoring/asset bytes not exported; inspect credits, normalised scale, late arrival and occupied-seat reveal. Design evidence is missing, not a negative visual verdict. |

### Measurement order and falsification

First run the existing mandatory suites; retain failures such as the supplied load-sensitive humanoid watchdog
result as failures. Then run the report-only catalogue at desktop 960x640 DPR 1 and phone 390x844 DPR 3, recording
browser, GPU, viewport, device power state and test machine. The new catalogue visits 42 entry configurations:
33 devices, six arm kinds, arena, normal humanoid and soft preview. It is **not** 42 validated physics sims.

For each device: capture cold start, warm start, 10-second controlled motion and orbit, Home, quiet/disconnect,
late/failed model decode and a simultaneous-seat case. Report p50/p95/p99 draw intervals, longest gap, render
fraction, render calls/triangles, GPU/CPU when measurable, asset bytes/decoded memory, part visibility and intended
geometry changes. The initial helper currently records RAF percentiles rather than GPU time and only has a
pendulum physics probe; do not infer unsupported values. Migrate each wave's real motion and physics probes before
enforcing that wave. Empty seats or a stationary humanoid are not motion evidence.

For every GLB: run authoring/decoded-asset tests and the existing proof scripts, capture front/side/back/three-quarter
silhouettes and close mechanism views, sweep every joint and combined poses, cross LOD boundaries repeatedly and
exercise slow/failing loads. For each of six soft forms, explicitly select it; merely visiting `?preview=soft` does
not cover all of them. For the four arena insignias, occupy all seats. Continuum requires a separate numeric proof,
not an invented page test. All captures/logs belong in temporary output or ignored artifacts, never commits.

## Roadmap and dependencies

Size is a planning category for reviewable deltas, **not a promised delivery time**: S = one narrow proof/mesh,
M = one sim and its tests, L = several coupled behaviours that must be split into independently reviewed sub-stages.
Each accepted stage needs a new pinned request and actual regression evidence. One shared engine dependency is a
programme allowance, not permission for each wave to add a different engine.

| Stage / wave | Scope and dependencies | Acceptance boundary | Risk / size | References |
| --- | --- | --- | --- | --- |
| F0-R: backend closure | Three adapters, one provisional selection, shared real fixtures and automatic Node/browser comparison now implemented; see PHYSICS-BACKENDS. No further migration. | Native compilation/fixtures, both-profile measured selection, canonical regressions and unchanged pendulum gate remain integration gates. Missing evidence is not acceptance. | High / L; runtime, proof and docs patches | R1, R8, R9, R17 |
| F1: humanoid pilot | Only after F0-R acceptance. Active ragdoll, anatomical limits, contact-supported locomotion, phone BODY source selection; existing models. | Stance, push/recovery/fall/get-up, no hover >5 mm at rest, meaningful two-actor motion and phone seat tests. | High / L; F1a/b/c below | R2, R3, R4, R5 |
| H2: humanoid models | After F1 freezes model/physics binding, independent of arm migration. Keel/Morrow first, then each preview family in separate asset packets. | Silhouette, materials, all pivots/LODs, combined-pose clearance and moving coverage; no physics or driver changes. | High / L with S/M mesh packets | R2-R5 for functional anatomy, original shells |
| A1: first arm dynamics | After F0-R; one five-axis simulated arm and its blocks/gripper. | Servo tracking and limited forces, payload contact/slip, deterministic resets and no hardware changes. | High / M | R6, R7 |
| A2-A4: other manipulators | A1 contracts; SO-101/six, SCARA/desk, then delta loop closure. Jib/slider/gimbal/PTZ/claw in individual packets. | Per-kind kinematics equivalence, singularity/loop closure, torque and grasp regressions. | High / M per packet | R6, R7, R8 |
| C1-C3: ground vehicles | F0-R vehicle backend. Rover/kart first, then slotcars/tank, then forklift/excavator/planetary. | Load-bearing suspension, braking/grip; track/derail; mast/bucket loads with no false hydraulic precision. | High / M per sim | R8; R10 for mobile robots |
| D1-D3: flight and water | F0-R rigid + force/buoyancy backend. Drone, then plane/helicopter, then boat/submarine. | Thrust/drag signs, trim, power-off landing/sinking, bounded collision and replay. | High / M per airframe or hull | R9, R11 |
| E1-E4: games/devices | Adopt foundation only where it improves fidelity. Ball games first; then dog/vacuum/sorting. Keep painter/lamp/smarthome/studio signal-driven. Telescope remains an aiming task. | Contact energy/tunnelling, fair controls, gait/drive support; otherwise smoothness and task correctness without gratuitous physics. | Medium / S-M per sim | R1, R8, R10, R12 |
| B1-B3: continuum/octopus | Preserve the existing continuum contract; after rigid/water interfaces and F1 load lessons. Numeric rod/contact proof, original rig/studio, then suckers/water coupling. | Volume/strain constraints, bounded energy/contact, calibrated-or-labelled parameters, stable attachment/release. Never advertise biological/hardware validation without evidence. | Very high / L, three proofs before rollout | R11-R14 and OCTOPUS.md |
| Model waves M-A/M-C/M-D/M-E | After the relevant rig schema freezes; use MODEL-STANDARD. One family/LOD pair per packet. | Registered pivots byte-compatible, measured budget and no motion pop; original or explicitly permitted files with credits. | Medium-high / S-M per asset | OPEN-REFERENCES licensing ledger |

Challenge to the suggested order: defer the full octopus studio until rigid contacts and water interfaces have
been exercised. It combines the least mature numeric and rendering work. Move H2 directly behind the F1 contract,
rather than postponing visible humanoid improvements until every vehicle migrates. No wave is a prerequisite for
rewriting every sim; opt-in is maintained throughout.

## Ready brief 1: F1 humanoid pilot (refined H1 appendix)

**Release gate:** the F0-R return alone does not release this brief. Require real Rapier/PhysX browser
measurements, a both-profile selected engine, canonical green tests and retained pendulum evidence. The F0-R
25 mm contact / 0.03 rad compliant-cone comparison floors are not F1's 5 mm anatomical/contact acceptance;
F1a must tighten and prove those limits in the actual humanoid. Unsupported compound colliders, nonzero initial
PhysX link velocities or CCD need an explicit bounded extension before relying on them, not a silent fallback.

**Start only after F0-R is accepted.** Preserve the owner's whole-body/phone-camera goal; do not reduce this to
placing feet on a plane or adding cosmetic sway. Scope is simulated humanoids plus their BODY input/source UI,
profile, retarget, physics binding and proof tests. No new models in F1. Expand the request to include the exact
phone/camera files and their tests; do not infer unexported files. Preserve real drivers/safety/live/fake-driver
behaviour, packet schemas, local camera processing and permissions.

Use F0's accepted engine; evaluate no second framework. Use R2's articulated parameter structure, R3/R4's openly
documented transmission/layout facts and R5's stance/recovery architecture as references, with original ob.Pal
geometry. Excluded CAD licences remain excluded. Every mass/inertia, limit and motor constant needs its units,
source or explicit simulation-default label. Do not rescale real actuator torque silently to make a robot stand.

Split implementation into F1a (one-actor contact stance and swing/twist limits), F1b (balance, gait, two-actor
contact, recovery), F1c (BODY sources and clean rendering). These are separately pinned packets under the same
acceptance contract, not three independently shippable claims of completed humanoid physics.

The physics body owns root translation/orientation and segment transforms. Retarget/tendons output motor targets;
rendered interpolation never writes authoritative physics. Express anatomical axes/cones in joint frames;
shoulder overhead reach, two or three spine segments, neck/head, hip squat/kick, knee/ankle/wrist limits must survive
profile differences. Body heading uses a calibrated pelvis frame, signed continuity and filtering, not mirrored
Euler yaw. Capture the actual spin fault before selecting its fix. Heading must not accumulate an unbounded turn
when a person crosses a camera seam.

Balance uses measured contacts and centre of mass/support polygon, with bounded ankle/hip/step strategies. Feet
plant and push off; the root cannot be pinned to an animation height. Out-of-envelope pushes cause a bounded fall,
then a get-up sequence when support is available. Self/inter-actor/arena collision filters and energy caps must be
explicit. Do not equate a scripted recovery pose with successful contact-supported recovery.

Expose phone camera beside this computer's camera, with a per-seat selected source/status. Verify BODY through a
fake connected phone camera into practice, seat 1 and seat 2. On source loss, quiet/reset rules apply without
cross-driving the other seat; switching sources cannot jump the root or continue stale tracking. Existing classical
controls remain usable. Retain software-hold wording and existing safety/overclaims copy.

### Acceptance

- Unit tests: swing/twist extrema and continuity at quaternion sign changes; mass/inertia validation; fixed-tick
  replay; stable stance for 30 simulated seconds; bounded push recovery versus an explicitly too-large push/fall;
  get-up with real support; no sole penetration or resting hover above 5 mm, and planted-foot slip recorded in mm.
  Test each profile; Keel/Morrow first, then all gated forms without silently lifting their gate.
- Pose/sweep sheets: T, squat, lunge, overhead reach, high kick, twist and crouch guard, each model/LOD; no flips or
  exterior crossings. Preserve the existing independent-axis audit and add simultaneous-pose checks.
- Two actors: target 60 fps on a named reference machine; report p95/p99 frame time, physics ms/tick, substep
  overruns, render calls/triangles and phone BODY receive-to-visible delay. Target p95 <=16.7 ms and p99 <=25 ms
  for the full desktop scene; keep measured misses red rather than lowering quality invisibly.
- Ten seconds of actual motion plus orbit: tracked part set, no unintended geometry/LOD switches, no missing
  submissions, pixel/coverage evidence for moving or skinned parts, cold/slow/failed loads. Intentional LOD changes
  require hysteresis/dwell and a measured stable or cross-faded transition, not a blanket allowlist.
- Desktop/phone strips and before/after: walk, squat, reach, jab with momentum transfer, stumble/recover,
  fall/get-up and phone camera control. Keep independent phone-source tests for practice and both seats.
- Coordinator executes private scan, overclaims, `pnpm run check` and the guarded sims, phone, pages, catalogue
  and camera validation available in the new pack; no Desktop input tests. State exactly which suites ran.

### Out of scope

Real hardware dynamics/calibration/firmware or safety changes; wire schema changes; new humanoid meshes; a second
engine/framework; octopus or device migration; automatic deployment; a claim of reliable biological balance or
hardware performance from simulation alone.

## Ready brief 2: H2 humanoid model quality

After the F1 model/physics binding is frozen, author original meshes through `assets/blender/common.py` and the
existing humanoid scripts. Ship Keel/Morrow as the first bounded pair; then Cairn I/II, Rill I/II and Hush I/II as
separate review packets. Use the existing profile heights/pivots, the new MODEL-STANDARD and R2-R5 for functional
joint-space reasoning only. Preserve each family's silhouette rather than copying an existing robot/character.
Keep soft preview opt-in until its own acceptance evidence is reviewed. The request must include actual before
GLBs, profiles, material/LOD code and model proof tests; source scripts alone cannot certify byte/triangle parity.

### Acceptance

- All profiles and every named pivot remain compatible at both LODs (position/parent/quaternion/scale tolerance
  no weaker than the existing test); any unavoidable contract change requires a separate F1-approved migration.
- Four body views plus head/hand/foot details and black silhouettes per form at desktop and phone size. Review
  low-gloss obsidian/graphite/elastomer separation, sparse functional lime and visible articulation clearances.
- Existing decoded GLB budgets and stricter MODEL-STANDARD targets pass. Independent-axis and simultaneous-pose
  clearance, all finger frames and folded-limb coverage pass at both LODs. No naming/scale/normal regressions.
- Ten-second motion/orbit and repeated distance/model switches retain part coverage with no unintended pop.
  Compression is validated after decode, not only in Blender. Record calls, triangles, asset bytes and cold decode.
- New original/reused asset provenance is recorded in open-source.json; run model tests, check and relevant
  guarded sims/pages/catalogue proofs. Evidence remains outside commits; no render claims without captures.

### Out of scope

Changing physics, drivers, wire protocols, body input behaviour or live rollout; copied character/brand styling;
NC/ND/share-alike/unlicensed assets; bulk replacement of all families in one unverifiable archive.

## Ready brief 3: A1 five-axis simulated arm pilot

After F0-R, migrate only `arm5` simulation, its block scene and gripper contact to the accepted articulated backend.
Use R6/R7's documented revolute-joint/frame/actuator conventions as references, not a wholesale imported arm skin.
The existing `arm5` geometric layout remains authoritative; preserve the other five arm kinds and all real-driver
paths byte-for-byte. Scope includes simulated FK-to-joint target binding, limited servo torque, block contacts,
render interpolation and arm5-specific smoothness/physics tests. No USB/serial connection or native host access.

### Acceptance

- Same zero pose, axis signs and reachable targets as existing kinematics; unreachable/singular targets remain
  bounded. Track step/settle and overshoot under no load and a labelled payload; enforce joint position/velocity/
  torque limits without teleporting the links to target poses.
- Gripper contact can lift a supported block, slip when friction/force is insufficient and release without an
  attachment teleport or energy spike. Test self/ground/block collision masks and deterministic tick replay.
- Ten-second pickup/place/orbit at desktop/phone includes every moving shell, sleeve and gripper; no missing parts
  or visual pose lag beyond documented interpolation. Report p95/p99 and physics timing, including five idle kinds
  proving that the backend is not eagerly loaded into unmigrated pages.
- Existing arm, grasp, SO-101 and safety tests remain green. Coordinator runs private scan, overclaims, check and
  guarded sims/pages/catalogue/shared suites. Preserve hardware watchdog/deadman behaviour with no live hardware run.

### Out of scope

Other arm kinds, new meshes, new engine dependencies, full hydraulic actuators, changes to hardware/control packet
contracts, automatic approval/merge/deploy, or claims of industrial safety from browser simulation.


## Parked brief N1: Newton reference motion (not implemented)

Purpose: obtain independent, reproducible reference trajectories for humanoid gait, arm settling and the
pendulum, then compare browser motion without treating a second simulation as measured biological truth.
Requires accepted F0-R, and F1's body/joint mapping for the gait comparison. No Newton runtime reaches a browser
or phone; no policy training or asset import is authorised by this brief alone. References: R18, R2/R7/R19.

**Execution environment.** Plan a dedicated Linux x86-64 NVIDIA-GPU machine. Newton 1.3.0's documented floor is
Python 3.10 (3.11+ recommended), compute capability 5.0+, driver 545+ with CUDA 12 (550+/CUDA 12.4 recommended);
Warp supplies its CUDA runtime. This is an upstream minimum, not a promise that every humanoid workload fits.
Record actual GPU model/VRAM, driver, OS, Python, Newton/Warp versions and package lock. Pin versions and solver
configuration before comparing; do not silently mix CUDA/solver defaults. CPU-only Newton exists but is not the
selected GPU reference profile. [Requirements](https://newton-physics.github.io/newton/1.3.0/guide/installation.html).

**Work.** Use original or separately cleared articulated descriptions with named frames, SI masses/inertias,
collision layers, joint cones and bounded motor law matched to the browser. Do not copy branded geometry to
make the numerical comparison. Run repeated fixed-seed, fixed-tick trials: passive pendulum release and damping;
one arm target step with payload and settle; one contact-supported gait with a scheduled bounded push. Separate
retarget/policy differences from integration differences. Sample both engines at common timestamps, using
shortest-arc quaternion interpolation only for comparison, not rewriting authoritative trajectories.

**Files returned.** `REFERENCE.json` records source/content hashes, licences, coordinate transform, parameter
provenance, seeds, solver/substep settings, units and machine versions. `models/*.json` contains the cleared
numeric description; `trajectories/{pendulum,arm,gait}.jsonl` contains tick/time, body IDs, world pose/velocities,
joint coordinates/targets, contact points/normal impulses and energy. `inputs/*.jsonl` records commanded events.
`metrics.json` and a human report give repeatability, trajectory RMSE/max error, settling, contact penetration,
foot slip and energy drift with explicit unsupported fields. Include checksums and short synchronised videos;
no raw camera capture, account paths or proprietary CAD. Bundle only files within the new request's scope.

**Acceptance.** Re-running the pinned recipe reproduces recorded tolerances on that same environment. Browser
physics gates read the exact reference files and report each metric and unit, rejecting missing data and frame
mismatches. Do not choose tolerances after seeing a desired pass: predeclare per-fixture tolerances in the N1
request and report deviations. A mismatch prompts parameter/coordinate/solver diagnosis, not a blind retune.
Both simulations may be wrong relative to hardware; claims stay simulation-to-simulation. No hardware drivers,
wire changes, deployment or new browser physics dependency.

## Parked brief N2: phone to Isaac Sim through ROS 2 (not implemented)

Owner choice: **ROS 2 first, full control in simulation**. Implement a local, explicitly selected simulation
bridge that translates existing ob.Pal control intent into ROS 2 commands for an allowlisted Isaac articulation.
Do not alter PAD/POSE/HAND/BODY packets, permissions, driver contracts or physical-device command paths.
Simulation joint coverage may include legs/base where the selected sim supports them; it does not lift the
existing hardware driver's upper-joint restriction. Keep that simulation-only branch unmistakable in UI/status.

**Proposed graph and topics.** Namespace each robot under `/obpal/isaac/<robot>`; these names are this design,
not claimed pre-existing ob.Pal endpoints. Remap Isaac's `joint_states` publisher and `joint_command` subscriber
to that namespace, using `sensor_msgs/msg/JointState` names/positions/velocities with validated frame/units maps.
Select one command mode per joint, never simultaneous conflicting position and velocity goals. For mobile bases,
remap `cmd_vel` (`geometry_msgs/msg/Twist`) into the simulated differential-drive controller and observe
`nav_msgs/msg/Odometry`; return `/clock` and required TF/state for display and timestamps. Isaac's documented
joint-control graph connects Joint State publication/subscription to an Articulation Controller; the bridge must
verify the selected articulation root and joint inventory, not guess from mesh names.
[Joint control](https://docs.isaacsim.omniverse.nvidia.com/6.0.0/ros2_tutorials/tutorial_ros2_manipulation.html).

**Ownership and limits.** Reuse the existing session/profile-key/sequence/deadline/lease/hold semantics at the
local translation boundary; do not invent a bypass that publishes directly from an unclaimed phone. Mirror
`src/sim/humanoid/drivers.ts::TIMING`: measured feedback <=100 ms old, captured input <=150 ms, 100 ms lease,
20 ms renewal, 5 ms guardian cadence, 50 ms acknowledgement budget, 200 ms stable interval and at most 30 Hz
goals. Time limits use monotonic wall time, not `/clock`: a paused simulation must not keep a stale command live.
Mirror `safety.ts` finite measured radians, exact profile/joint inventory, exclusive ownership, no fault,
required guardian/robot-watchdog proof, and limits inside the selected rig. Joint motion obeys the stricter
profile cap or 0.5 rad/s and 1 rad/s2, with braking distance to limits and dt in (0, 0.05] s. These are existing
conservative driver envelopes to preserve, **not a hardware certification**. For the simulated mobile base,
propose a new explicit conservative profile cap of 0.25 m/s and 0.5 rad/s yaw (design defaults, not existing
driver constants); bound acceleration in that profile and reject a bridge with no declared limits.

A local bridge must acknowledge software hold: zero base velocity and measured-position hold or the selected
controlled-damping strategy for joints. Deadman release, source switch/loss, stale state, sequence replay,
map mismatch, missed lease/acknowledgement, ROS disconnect, stopped `/clock` or ownership loss all request hold
and disarm. No reconnect auto-resume or replay of queued goals. Enforce latest-only delivery and expiry at the
application layer even with a QoS history of one; DDS delivery success is not evidence of executed hold. Configure
explicit compatible ROS 2 QoS with the chosen Isaac release and prove disconnection/stale-command cases. Use a
simulation-only ROS domain and robot allowlist; no shared hardware ROS graph or auto-discovered endpoint.

**Demonstration and returned evidence.** Start with the cleared Panda arm and TurtleBot3 base references from
R19, no copied assets in this F0-R packet. A claimed phone moves multiple arm joints/gripper and drives/turns the
simulated base while state/ownership and software-hold reasons are visible. Then show the full simulated joint
set for the selected humanoid without enabling the hardware lane. Record session-sequenced intent, ROS commands,
measured state, wall/sim timestamps, receive-to-visible latency and hold acknowledgement latency; export a
redacted ROS bag or JSONL traces, graph/topic/QoS map, version/asset-licence manifest and a concise video.

**Acceptance.** Automated fake-bridge cases plus real Isaac/ROS 2 demonstration prove all limits, duplicate/out-of-order
rejection, source/seat isolation, pause/disconnect/deadman holds and explicit re-arm. Goals at stale feedback,
wrong maps, missing ownership or failed watchdog proof never reach the robot topic. Inject stalled ROS and
paused simulation separately; verify the wall-time guardian still expires. Full simulation control must not
change any hardware safety test or packet bytes. Require a new pinned request, the selected Isaac-compatible
ROS 2 distribution, available GPU resources and coordinator-assigned endpoints before implementation. No
physical robot, deployment, registry or Desktop input work.
