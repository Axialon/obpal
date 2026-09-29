# Humanoid: full-body capture and robot following

Approved Phase 0 plan, researched 2026-09-30 against master `be50c71`. Phase 1 and 2 implementation and measured evidence are recorded below; all other numbers remain proposed targets, not hardware safety ratings. Each phase ends with coordinator review, merge and deployment.

## Capture and transport

Extend the branded camera with Body, advertised through an additive `camera.body` capability. Reuse its permission, download, progress, privacy and close/background lifecycle. Keep POSE for the device's existing tracking source; BODY describes a person.

[Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) produces 33 landmarks, image coordinates, hip-centred world coordinates and optional segmentation. Start with Lite, one person, VIDEO mode, segmentation disabled. The [synchronous web API](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js) runs in a shared phone/host worker service: one inference in flight, close bitmaps, discard superseded frames. GPU failure falls back to CPU with reduced cadence/resolution.

| Capture location | Framing, latency and CPU trade-off |
|---|---|
| Propped phone, facing the user | Front preview guides head-to-feet framing around 2–3 m. Inference heats the phone; authenticated WebRTC adds jitter but leaves the Viewer free. Start at 640×480/30 fps; 60 is optional. |
| Computer webcam, Viewer or sim | Direct local input, without pairing/network hop; works offline after model caching. Desktop framing often crops feet: offer upper-body mode. Inference competes with rendering. |

Camera → landmarks/confidence → one-euro filter → BODY or local adapter → seat → retargeting → control arbitration → constrained joints → sim. A separately armed driver receives only validated targets. Local webcam input does not masquerade as a remote connection.

Privacy: “Camera frames stay on this device. Phone mode sends body landmarks to your paired screen.” Host capture stays local. Cache same-origin models/WASM, never frames/landmarks. Record model revision, SHA-256 and credits in `public/models/README.md` and `src/support/open-source.json`. The [runtime](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) and [BlazePose model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf) specify Apache-2.0. The card excludes metrically accurate depth and life-critical decisions; safety must remain independent of vision.

### BODY v1

Reserve unused `0x17` on unreliable `st`; older receivers ignore it. Preserve existing layouts and authentication/attention gates; send only to advertising peers. Exactly 276 bytes, little-endian, complete snapshots:

| Byte offset | Bytes/type | Meaning |
|---|---|---|
| 0 | 1/u8 | Version 1, type 7 (`0x17`) |
| 1 | 1/u8 | Bit 0: torso tracked; other bits zero |
| 2–3 | 2/u16 | Independent BODY sequence, continuous across generations |
| 4–7 | 4/u32 | Capture microseconds on device session clock, wrapping |
| 8 | 1/u8 | Tracking generation, wrapping |
| 9 | 1/u8 | Landmark count, exactly 33 |
| 10–11 | 2/u16 | Reserved, zero |
| `12+8i` | 6/i16×3 | Landmark `i` x/y/z, metres ×2000 |
| `18+8i` | 1/u8 | Visibility ×255 |
| `19+8i` | 1/u8 | Presence ×255; `i=0…32` |

Keep MediaPipe ordering. Axes match HAND: x camera-right, y up, z toward camera; negate MediaPipe y/z. Origin is the hip midpoint, not arena position. In Body mode, BODY and optional HAND use the same unmirrored source; existing Hand mode stays unchanged. Preview mirroring is presentation only.

Resolution is 0.5 mm, range −16.384…16.3835 m, rounding error ≤0.25 mm/axis; optical accuracy is poorer. Reject non-finite/out-of-range inputs, wrong lengths/counts and reserved bits. Missing/out-of-image points have zero confidence; missing coordinates are finite zeros.

| BODY cadence | BODY payload | With 2,000 B/s control reserve |
|---|---|---|
| 30 fps | 8,280 B/s; 66.24 kbit/s | 10,280 B/s |
| 60 fps | 16,560 B/s; 132.48 kbit/s | 18,560 B/s |

Transport overhead is additional. Share the existing 18,000 B/s camera bucket: BODY30 + HAND30 costs 12,600 B/s; BODY60 + HAND10 costs 18,000 B/s. Cap bursts at two BODY-sized packets, drop queued work on backpressure, and send a final untracked snapshot even at the budget boundary. Never run independent full-rate buckets.

`Frame.body` is nullable: `{tracked, gen, t, receivedAt, landmarks, visibility, presence}`. Match [HAND](../spec/PROTOCOL.md#hand-packet-type-6-a-camera-tracked-hand): sequence-first rejection, 250 ms expiry, retained sequence after expiry, monotonically increasing host generation on acquisition, wire-generation change or reset. Late/duplicate packets cannot refresh freshness. Unwrap BODY time independently; reset anchors/filters on loss/source change. Local input shares these rules. Estimate capture age through stream clock offsets; uncertain age disallows hardware following.

HAND supplies one hand's curls/orientation at BODY's wrist. Add optional capture `t` to `Frame.hand`; fusion requires it, matching source/side and ≤50 ms skew. Clear pairing on generation changes. No alternating sides for bilateral tracking. Missing fingers relax visually, hold on hardware. Body mode suppresses Hand-mode Viewer gestures. Phase 1 ships BODY only by default; its optional Fingers toggle is off each session. The pinned JS API lacks per-point presence, so the [implemented protocol](PROTOCOL.md) specifies conservative effective presence from visibility and image bounds.

## Retargeting

Reference rig: 31 rotational DoF plus visual finger curls. Table angles are degrees; solver/driver values are radians. Rest: upright, arms down, knees straight. Profiles store ordered axes, rest transforms, sign/zero mappings and limits; paired abduction is outward-positive.

| Chain | Landmark anchors | DoF and proposed sim limits |
|---|---|---|
| Pelvis/spine | Hips 23/24, shoulders 11/12 | Spine yaw ±35, pitch −20…30, roll ±20 (3) |
| Head | Nose 0, ears 7/8 | Yaw ±60, pitch −35…45 (2) |
| Each arm | Shoulder 11/12, elbow 13/14, wrist 15/16 | Shoulder pitch −80…140, roll −15…110, yaw ±70; elbow 0…140; wrist roll ±90, pitch ±45, yaw ±35 (7×2) |
| Each leg | Hip 23/24, knee 25/26, ankle 27/28; heel 29/30, toe 31/32 | Hip pitch −35…100, roll −25…45, yaw ±35; knee 0…130; ankle pitch −35…25, roll ±20 (6×2) |

Hardware profiles replace these artistic limits with verified manufacturer/controller limits and smaller working envelopes; unsupported axes remain uncommanded.

Let `P=(p23+p24)/2`, `S=(p11+p12)/2`. Pelvis right is `r=normalize(p24-p23)`; orthogonalise calibrated vertical against `r` to obtain `u`; back is `b=r×u`. Thus `[r,u,b]` is right-handed, forward is `−b`. Build torso orientation similarly from shoulder span and `S−P`; relative rotation `Rpelvisᵀ Rtorso` drives spine. Pelvis pitch and axial twists are poorly observed: regularise toward neutral rather than manufacture certainty. Ears/nose estimate head orientation; wrists use palm landmarks when reliable, otherwise neutral twist.

Measure median user segment lengths during one second standing, arms apart. Normalise segment vectors by those lengths, then multiply by robot lengths to form targets. Freeze scale; reject implausible changes. Calibration never moves hardware.

For shoulder–elbow–wrist or hip–knee–ankle, robot lengths `a,b` and target distance `d` give flexion `acos(clamp((d²−a²−b²)/(2ab),−1,1))`, with zero straight. Clamp reach to `|a−b|+ε … a+b−ε`. Proximal offset is `acos(clamp((a²+d²−b²)/(2ad),−1,1))`; place the middle joint in the observed bend plane. Retain the previous pole near straightness, preventing elbow/knee flips. Decompose into the profile's joint axes, clamp, recompute forward kinematics and report unreachable residuals. Heel-to-toe direction sets foot pitch/yaw; ground normal sets ankle roll.

Mirror reflects calibrated x and swaps left/right landmark pairs before solving; rebuild proper rotation frames, never reflect quaternion components. Switching mirror resets tracking and contact anchors; derived calibration remains anatomical and reusable. Hardware mode will refuse mirror changes while live.

Sim contact engages after 80 ms with sole height <2 cm and speed <0.1 m/s; release above 4 cm or 0.2 m/s. Lock soles, adjust pelvis height, keep approximate centre of mass inside the support polygon with 2 cm margin. Blend incompatible poses toward support. This visual heuristic cannot stabilise real legs.

Use the existing [one-euro filter](https://gery.casiez.net/1euro/): cutoff 1.5 Hz, beta 35, derivative cutoff 2 Hz, seconds/metres; tune against fixtures. Filter once before transport. Confidence is `min(visibility,presence)`: enter ≥0.7 for three samples, leave <0.5 immediately. Occluded chains hold without extrapolation; sim eases to rest after 250 ms. Torso requires hips/shoulders; losing it holds everything. Cropped feet permit procedural legs; cropped hips require classical controls. Reacquisition resets anchors; hardware requires rearming.

At 30 fps: capture wait 33 ms + inference 25 + transport 15 + filter 20 + retarget/render 17 = 110 ms target; webcam removes transport. Measure p50/p95 and stationary jitter; target p95 ≤120 ms on reference LAN. Label frame-availability timestamps as proxies when exposure time is unavailable. Lower cadence before accumulating backlog.

## Sim experience

`/sim/humanoid/` opens into robot/arena, with Pair, Camera and Switch controller in the shortcuts dock. Dark frost, ob.Pal typography and lime status marks frame the scene; one strip shows seat/input/quality. Body opens on a tap with head/feet guides. Standing auto-calibration and mirror are on by default, with the optional eight-chain range walkthrough approved below. Classical play needs no calibration.

Reuse `Remote` participants/claims and `src/sim/devices/seats.ts`: two seats, one actor per claim, host-authoritative contacts/scoring. Webcam reserves one local seat; phones track one person each. Source changes reset tracking/contact anchors; closing the local webcam releases its claim and disconnect holds its actor. Spectators cannot drive or arm hardware.

Priority: Stop/fault → held-deadman gate for hardware → joint/contact constraints → selected control source. Gamepad sticks, tilt or trackpad command root travel/yaw; BODY commands articulation. Procedural stepping owns legs while locomoting, blending back over 150 ms when stopped. An explicit preset takes its affected joints until completion/cancel, blending over 120 ms; manual input cancels it. Tracking loss never silently switches to another controller.

Presets: guard brings both forearms up; jab extends/retracts the lead arm; cross adds rear-arm extension and torso turn; uppercut arcs upward; block covers the targeted side; wave opens and oscillates a raised hand. Use bounded joint curves, common limits and interruptible recovery. Physical-driver mode excludes strikes and sparring.

Swept fist capsules against torso/guard volumes register one hit per stroke with a 150 ms cooldown. Show a brief contact ring, small score tick and optional seat haptic; block produces a muted rim flash. Floor contacts trigger footfalls. Reuse the audio event/budget engine with synthesised servo movement and existing credited CC0 impacts; sound requires activation and respects mute. Reduced motion removes shake/flashes.

Camera fits both actors/feet with 15% margin; retain orbit/recentre, no forced shake. Target 60 fps on a measured mid-range phone Viewer: two actors, p95 CPU+GPU work ≤16.7 ms over five warm minutes, retarget/contact ≤2 ms, ≤120 draws, DPR ≤1.5. Reduce shadows/reflections/DPR first; measure webcam contention separately.

## Original models

**Keel**, 1.8 m: 0.30 m pelvis, 0.52 m shoulders; inverted shield chest with a vertical void. Tapered obsidian rails flank smoked-glass sternum panels; recessed lime filament follows the left rail. Wedge head, glass brow, long chamfered forearms, three segmented fingers, split soles with heel pistons. Shoulder rings, elbow drums and layered knee caps expose articulation.

**Morrow**, 1.65 m: 0.42 m shoulders, 0.36 m pelvis, crescent shins. Open oval thorax holds offset glass ribs around a lime core; hexagonal head sits inside a collar. Short faceted arms, crescent forearm guards, four short fingers. Obsidian shells, satin edges, dark joints and open waist distinguish its silhouette from Keel even in flat black.

Script both from bevelled prisms, lathed rings and extruded profiles using `assets/blender/common.py`; no borrowed robot meshes. Named rigid pivots match the joint map, with 8–12 mm shell clearances and separate covers at flexing joints. Use shared kit materials; fake smoked glass with opaque tinted surfaces on mobile, optional transmission on desktop.

Arena: an 8×8 m clipped-square obsidian training floor, fine etched distance marks, two luminous seat corners and low glass perimeter fins. No crowd or advertising. Export meshopt GLBs through the existing compressor and clean-load/reveal path; validate every pivot before swapping meshes.

Budget: ≤25k triangles per hero, 10k fallback LOD, arena ≤15k; scene ≤65k. Each hero ≤1.5 MB compressed, arena ≤0.75 MB, optional shared 1024² atlas ≤1 MB and ≤8 MB decoded textures. Prefer procedural materials. Author geometry and sounds ourselves under the repository licence, or use CC0 assets only; credit all assets in `open-source.json` and retain build scripts.

## Real humanoids and safety

Extend the [arm driver](../src/sim/arm/drivers.ts) pattern with named joints. `HumanoidDriver`: `connect/profile/read/send/hold/close/onLost`; `hold(reason)` is mandatory. Profile declares units, limits, speed/acceleration caps, feedback type, body groups and stop strategy. Readings carry advancing per-joint measurement timestamps, faults and mode; receipt alone cannot refresh stale measurements. Commands carry session/sequence, deadline, targets and deadman lease. Initially observe-only, the twin follows reported joints.

ROS transport uses [rosbridge advertise/subscribe/publish](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md). Map ordered names to [`JointTrajectory`](https://github.com/ros2/common_interfaces/blob/jazzy/trajectory_msgs/msg/JointTrajectory.msg), with positions in radians and bounded velocities, at 30 Hz. A local guardian forwards a validated point 100 ms ahead to `<controller>/joint_trajectory`, using its ROS clock. Subscribe to [`sensor_msgs/msg/JointState`](https://github.com/ros2/common_interfaces/blob/jazzy/sensor_msgs/msg/JointState.msg) on `/joint_states`; map by name, never array position. Missing names remain unknown, not zero. Translate camera/rig coordinates explicitly to [ROS conventions](https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst).

Use a dedicated upper-body controller: [joint_trajectory_controller](https://control.ros.org/jazzy/doc/ros2_controllers/joint_trajectory_controller/doc/userdoc.html) normally requires all its configured joints, and topic submission supplies no action completion result. Read controller state too. The guardian independently watches feedback/leases, cancels/replaces pending motion and performs the configured measured-position hold or controlled damping. Generic rosbridge alone cannot establish a safe stop.

Unitree design: a local C++ `unitree_sdk2` bridge owns DDS and the servo cadence, interpolating browser targets. Official [G1 arm7](https://github.com/unitreerobotics/unitree_sdk2/blob/main/example/g1/high_level/g1_arm7_sdk_dds_example.cpp) and [H1 arm](https://github.com/unitreerobotics/unitree_sdk2/blob/main/example/h1/high_level/h1_arm_sdk_dds_example.cpp) examples publish `rt/arm_sdk` and read `rt/lowstate`; their joint indices, message types and takeover weights differ. Pin SDK/firmware/model variants; never reuse a G1 map for H1 or assume all G1s have wrists. Preserve the vendor locomotion controller. Raw `rt/lowcmd` whole-body control is outside this release. The SDK's [BSD-3-Clause licence](https://github.com/unitreerobotics/unitree_sdk2/blob/main/LICENSE) needs attribution if distributed.

| Hazard | Required mitigation |
|---|---|
| Wrong mapping, stale/partial state, jumps | Verified profile; fresh measured feedback for every enabled joint; twin alignment; finite/range checks on both sides |
| Collision, excessive speed, entanglement | Smaller working envelopes, self-collision capsules, speed/acceleration caps, cleared workspace and reachable physical emergency stop |
| Browser/connection/bridge failure | Independent guardian and robot watchdog; expiring leases; bounded queues; driver-specific hold/damp, never assumed torque-off |
| Replay, competing writers, unexpected resume | Authenticated local bridge, origin restriction, exclusive ownership, session/sequence/deadline checks; latched Stop and fresh rearm |
| Fall or unstable support | Upper body only; vendor stance control, conservative torso envelope; no physical sparring; supported commissioning for legs |

Go-live requires profile/mapping verification, all enabled measured joints ≤100 ms old and inside limits, stable controller mode, healthy guardian/robot watchdog, working stop acknowledgement, clear workspace, aligned twin and fresh held deadman. Initial proposed caps are 0.5 rad/s and 1 rad/s², further reduced by the robot profile; they require hardware-specific commissioning.

Use a held gamepad trigger, keyboard control or approved physical pedal, never a pose gesture or toggle. Sample/renew at 50 Hz; release/blur/hidden sends immediate hold. Require capture age ≤150 ms while following BODY, feedback age ≤100 ms, and lease expiry ≤100 ms; guardian checks at ≤10 ms intervals, issuing hold within 110 ms of missing renewal. A 50 ms missing stop acknowledgement latches a fault. These bound command issuance, not physical stopping distance. Bridge death requires a verified robot-side watchdog; otherwise refuse live.

Stop cancels presets and latched targets, invokes the driver's own hold/damp and blocks all goals. Resume requires released-then-held deadman and a new go-live check. Leg enable is separate, local, explicit and session-only: require supported mounting or a commissioned balance controller, contact/IMU feedback and verified recovery. Unsupported profiles refuse it. Camera-only foot contact cannot authorise real leg motion.

Phase 4 proves contracts against fake drivers only. No hardware readiness claim follows from those tests; commissioning remains separate work.

## Phases and proof

Each phase merges master, runs `pnpm run check`, then affected e2e suites. Tests write temporary files; copy evidence to ignored `artifacts/humanoid/phase-N/`. Use assigned ports, Playwright Chromium and guarded Link copies; require “no new sessions”. Separate fake-camera integration from actual-model/device measurements.

| Phase | Files and work | Tests and acceptance | E2e suites |
|---|---|---|---|
| 1. Capture — implemented | New `packages/core/src/body.ts`, exports, `packages/host/src/{stream,remote,element}.ts`; `src/controller/body-{worker,tracker,signal}.ts`; shared `src/ui/body-capture.ts`, camera/controller/Viewer entry points; capability catalogue, model credits, protocol/privacy docs | `tests/body-{protocol,stream,tracker}.test.ts`: quantisation bounds, seq/time/gen wrap, loss/reacquisition, malformed packets, budget and HAND compatibility. Fake Y4M camera plus synthetic landmark seam: permission/close/background, host offline capture, no image traffic, source switching. ≥30 processed fps on reference device remains a device acceptance target; measured PC results below | camera, phone, embed, shared, catalogue; extension for Frame consumers |
| 2. Sim — implemented | New `sim/humanoid/index.html`, `src/sim/humanoid/{main,profile,ik,rig,retarget,calibration,walkthrough,controls,contacts}.ts`; seats adapter, catalogue, Vite route/early entry, audio integration | `tests/humanoid-{ik,calibration,controls,contacts}.test.ts`: FK/IK roundtrip ≤1° or 1 cm, mirror identity, finite singularities, bounded joints, monotonic/clamped/identity range mapping. `scripts/e2e-humanoid.mjs` under sims: two seats, loss, classical controls, presets, complete/skip/redo/persist/reset walkthrough and screenshots. Five-minute procedural-rig PC budget; physical phone acceptance remains unverified | sims, shared, phone, catalogue, pages |
| 3. Models — implemented | `assets/blender/{humanoids,humanoid_arena,render_humanoids}.py`, five meshopt GLBs, `humanoid/{models,rig,range-figure,walkthrough,fingers}.ts`, kit registrations and credits | Full-limit pivot sweeps at both LODs; geometry/material/byte contracts; cold/warm/failed/late reveal and LOD switching. Selected-robot walkthrough, reduced-motion pixels, optional BODY/HAND finger fusion, phone/desktop screenshots and five-minute two-hero performance | sims, pages |
| 4. Drivers — implemented | `src/sim/humanoid/{drivers,safety,live}.ts`, fake drivers; `hardware/humanoid/README.md` specifies guardian and Unitree bridge contract | Unit fault matrix and `scripts/e2e-humanoid-live.mjs` under sims: stale single joint amid fresh others, unknown/out-of-limit/NaN state, swapped mappings, caps, replay, deadman release/loss, browser freeze, socket/bridge death, stop acknowledgement, leg refusal, reconnect requiring rearm. Zero motion goals after Stop; fake guardian holds within 110 ms. No real robot endpoints | sims, phone, shared |
| 5. Review | Relevant humanoid/UI files, `docs/DEVICE-CHECKLIST.md`, this plan, camera/help documentation | One bounded Opus design review: ≤30 minutes, ≤10 findings, one polish pass, then focused verification. Device checklist covers lighting/occlusion, seated use, permissions, thermal cadence, 60 fps Viewer and measured latency. Record unavailable devices as unverified; no invented passes | sims, camera, phone, shared, pages; catalogue/extension only if changed |

## Phase 1 capture — done (2026-09-30)

Capture is implemented with Lite only, 640×480/30 requested, one person, no masks and Fingers off by default. BODY is 276 bytes and `Frame.body` expires after 250 ms. Unit fixtures verify ≤0.25 mm coordinate quantisation error, confidence gating, counter wrap, late rejection, filter resets, GPU/CPU recovery and shared 18 kB/s budgeting. Optical accuracy is not implied. The detailed implemented contract is [PROTOCOL.md](PROTOCOL.md).

Measured on PC headless Chromium with NVIDIA RTX 4090, an original synthetic full-body image and real Pose Lite inference (short warm runs, not a thermal test):

| Local route | Processed fps | Mean inference | Fake capture-to-local-input p95 | BODY payload |
|---|---|---|---|---|
| Viewer | 29.97 | 11.17 ms | 25.5 ms | 8,271 B/s |
| Arm sim | 30.08 | 15.45 ms | 22.7 ms | 8,303 B/s |

The camera suite also detects the real model fixture through the phone UI and sends BODY over real WebRTC. Synthetic landmarks separately prove default zero HAND, optional Fingers without legacy gestures, partial feet/torso loss, reacquisition, camera flip and source switching. Local Viewer/sim tests observe zero outbound RTC messages, no capture storage writes or HTTP payloads, continuing offline inference and explicit offline restart after caching. Hide/blur/close release tracks and workers; activation never persists. Browser cache eviction can require a fresh static-asset download. Hashed worker and versioned JS loader cache headers are included for offline restart; existing Hand assets keep their paths.

Evidence is under ignored `artifacts/humanoid/phase-1/`: `camera-results.json`, before/after body screenshots, check and suite logs. The model is 5,777,746 bytes with revision/SHA-256 in the asset manifest. The runtime exposes visibility only; effective presence is documented, not presented as an independent model score.

After merging master `04f60bf`, all four typechecks pass and Vitest reports 2,071 passed, 14 skipped. The integrated e2e run passes camera 20/20, phone 35/35, embed 19/19, shared 7/7, catalogue 134/134 and extension 23/23. The Desktop guard reports 19 test-browser lines before and after, with no new sessions.

**Unverified on real devices:** phone processed FPS and thermals, 60 fps capture, moving-person/occlusion accuracy, physical exposure-to-display/network latency, Safari/iOS lifecycle behaviour, and simultaneous mid-phone Viewer performance. Phase 1 shipped capture only; subsequent sim work and the owner's decisions are recorded below.

## Phase 2 simulation — done (2026-09-30)

`/sim/humanoid/` now has two procedural, independently limited Keel/Morrow rigs, existing exclusive seats, practice/free scoring, the six interruptible presets, classical root locomotion and BODY articulation including legs. Stop latches both actors; a disconnected seat holds its own actor. The shared BODY camera requires an explicit tap and reserves a local seat. Phone BODY uses the existing authenticated WebRTC path; spectators cannot take occupied seats. No hardware driver or leg lock is involved.

Named profiles supply joints, chains, geometry, mirror mappings and optional torso/head anchors. Analytic two-link IK, anatomical scale normalisation, per-joint bounds and visual foot support are independent modules. A generic named-tree fixture proves that the rig does not require pelvis/head names. This is an extension boundary, not an octopus implementation. Pose Lite's sparse wrist/ankle observations cannot recover every axial rotation reliably; unknown axes retain default limits. Optional HAND finger articulation and final shell geometry belong with the phase 3 meshes. The procedural sim therefore advertises BODY capture only, avoiding a second landmarker whose output it cannot yet display.

Standing proportions settle over one second; mirror starts on. Eight optional range steps animate one figure and record only sufficiently observed joint spans (at least 5°); skipped or unobserved axes use the reference mapping. Each measured user range maps to the selected robot's safe limits. Derived anatomical ranges and segment lengths share a profile version across Keel/Morrow and persist under the local seat or paired-device identity. The storage parser accepts only known finite range/length fields. Reset clears the measurements and the standing estimator. Images and landmarks are never stored. Privacy copy describes this optional derived-data exception.

The walkthrough and controls use family glass, typography, actions and dock placement. Phone framing keeps both figures above the open controls, with orbit/recentre available; the closed-panel view gives the arena more space. Contact capsules count one hit per stroke, using hand motion relative to the shoulder so walking alone cannot score. Feedback uses a short ring, existing contact/footstep samples, servo synthesis and optional seat haptics. Reduced motion removes flashes; sound follows the existing activation/mute rules.

After merging master `bbc4bb8`, all four typechecks pass and Vitest reports 2,121 passed, 14 skipped. Required e2e suites pass: sims 220/220, shared 7/7, phone 35/35, catalogue 134/134 and pages 59/59. The initial arm re-anchor timing flake passed when sims was rerun alone; it also passed on merged master. A final focused humanoid run passes 11/11 after correcting support-offset rotation. Rereading a BODY frame cannot extend its 250 ms freshness window. Every guard reports 19 test-browser lines before and after: **no new sessions**.

Measured on PC headless Chromium (Playwright build 1237), NVIDIA RTX 4090 through ANGLE/D3D11, at 1440×900, two moving procedural actors with synthetic BODY input and no camera inference. After a two-second warmup, the final sample ran for 300.195 seconds:

| Measurement | Result |
|---|---|
| Render intervals recorded | 17,999 |
| Frame interval p95 | 16.90 ms |
| Retarget/control/contact logic p95 | 0.60 ms |
| Render submission CPU p95 | 0.50 ms |
| GPU timer p95 | 2.58 ms |
| Draw calls / triangles / DPR | 53 / 3,060 / 1 |

Evidence lives in ignored `artifacts/humanoid/phase-2/`: `final/results.json`, raw `final/frame-times.json`, desktop/phone sim screenshots, all eight walkthrough steps at both sizes, check logs and guarded suite logs. Phone screenshots use an emulated Pixel 7 viewport, not phone hardware. Physical phone Viewer frame rate, camera/render contention, thermals, moving-person accuracy and real motion-to-display latency remain **unverified**. Procedural silhouettes are phase 2 stand-ins; approved Blender models and physical-driver safety work remain phases 3 and 4.

## Phase 3 implementation and validation (2026-09-30)

Keel and Morrow now wear original Blender-scripted shells. Keel has paired shield rails,
a smoked sternum, asymmetric lime filament and three segmented fingers per hand.
Morrow has an open oval thorax, offset smoked ribs, crescent forearms/shins and four
short fingers. Its shoulder/hip frames now use the approved 0.42/0.36 m spacing;
the limb lengths, limits and named retargeting chains retain the reference contract.
The clipped eight-metre arena uses inlaid marks and low opaque glass fins. All
materials come from the existing kit; no texture, HDRI or outside mesh was used.
Scripts and assets are MIT, credited in the open-source inventory.

| Asset | Compressed bytes | Triangles | Draws |
|---|---:|---:|---:|
| Keel | 149,888 | 7,088 | 36 |
| Keel low LOD | 121,904 | 4,580 | 34 |
| Morrow | 164,272 | 8,080 | 37 |
| Morrow low LOD | 132,992 | 5,188 | 35 |
| Arena | 51,300 | 4,972 | 4 |

Every asset has zero textures. Both hero meshes plus the arena total 365,460 bytes
and 20,140 triangles before scene effects. The lower LOD removes service details
and bearing segments while retaining the silhouette and every pivot. A 5.5/6.5 m
hysteresis prevents repeated switching. The arena already costs four draws and
does not need a second mesh. All 32 body frames and the four collective finger
frames are checked before replacing a rig. Invalid, failed or delayed downloads
use the shared clean-reveal fallback; late arrival keeps the current joint pose.
The 18 model contract tests include 2,176 independent joint-sweep poses across both robots and
both LODs, comparing each pivot to independent forward kinematics within 0.01 mm.
These are visual shells with exposed bearings and assembly gaps, not manufacturing
clearance certification or a physical self-collision model.

The range walkthrough now has a slim eight-segment redo rail, the selected robot
in glass finishes, lime on the active chain and an arc centred on its moving joint.
Close, skip and redo use shared icon buttons with accessible names and tooltips;
Done is the only worded primary action. Reset sits quietly below. Reduced motion
holds the figure still; browser tests compare its pixels. Shared button CSS was
not changed. The formatting-only cleanup independently passed the original 38
humanoid unit tests and 11 guarded browser checks before feature edits.

Optional phone Fingers now controls collective curl at BODY's wrist. Only a known
side with confidence ≥0.65 and capture skew ≤50 ms can pair. Source, side, mirror
or generation changes require fresh samples from both producers. Missing input
opens the visual hand; Stop holds its current pose. Presets close the fingers,
except wave. No arm angles come from HAND. The phone toggle remains off by default;
host webcam capture remains BODY only. Unit tests cover rejection, wrap and mirror;
fake-camera e2e crosses real WebRTC and proves opt-in, seat isolation and relaxation.

The five-minute PC sample used **both hero meshes**, synthetic BODY at camera
cadence, DPR 1 and Chromium/ANGLE on an RTX 4090. In 300.211 seconds it recorded
17,984 frames: raw frame-interval p95 **16.90 ms**, retarget/contact logic p95
**0.50 ms**, render submission p95 **0.60 ms**, GPU timer p95 **1.93 ms**, **78 draws**
and **20,236 rendered triangles**. Logic and the combined CPU/GPU workload fit
their 2/16.7 ms budgets; the raw interval tail includes frame scheduling jitter
and is reported separately. This does not establish the 60 fps physical-phone
target or include simultaneous camera inference. All four typechecks and 2,144
unit tests passed (14 skipped); the full sims suite passed 222/222 and pages
passed 59/59 after merging master `da31450`. The guard reported “no new sessions”
(19 test-browser lines before and after). No final-suite flake needed a rerun.

The evidence directory is `artifacts/humanoid/phase-3/`. `before/` holds all 16
phase-2 walkthrough baselines. Final browser evidence includes every redesigned
step at phone/desktop sizes, the sim, load states and the raw five-minute timings.
`renders/` holds 3840×2160 front, three-quarter, side and back stills of both robots
and `pair-arena.png`; `render-contact-sheet.png` is a review index. Phone screenshots
are emulated. Physical-phone fps, camera/render contention, thermals and real
motion-to-display latency remain **unverified**. Hardware and real leg enable are
still phase 4; no physical-driver support is implied by the meshes.

## Phase 3b model revision

Keel and Morrow v2 keep the approved heights, joint-centre spans, named frames and
control limits. Their skins now use tapered octagonal lofts, bevelled panels,
closed articulation bearings, a column inside the collar, overlapping abdominal
lamellae and ankle actuator housings. Keel has a broad shoulder cap and deep split
shield; Morrow retains its open oval, offset ribs and crescent guards, with a
swept dorsal crescent visible in side silhouette. Both hands have a palm, thumb,
separated digits and three articulated phalanges. BODY and optional HAND retain
their existing responsibilities; only the visual finger linkage gains a frame.

`humanoid_surfaces.py` extends the shared kit with gloss obsidian, satin graphite
and smoked glass. Those three primary finishes use matching linear colours,
roughness and metalness in Blender and three.js. Lime is confined to the brow and sternum/core.
Coarse-pointer Viewers use standard-material shell/glass reflections without the
second clearcoat lobe. Robot glass remains opaque; perimeter fins use a single
transparent pass. The arena is an 8 × 8 m deck with half-metre grid lines, 1/2/3 m
distance rings, two illuminated corners, twenty glass fins and a supported halo.
The live scene uses a static procedural studio reflection map and soft sole
contact gradients. Cycles' ray-traced reflections are an offline approximation
target, not an extra real-time rendering pass.

The authoring pipeline welds bearing seams before cutting. Expanded copies of the
moving sleeves machine the shoulder/hip openings through 17 positions per axis,
with an 8 mm tool margin. Both LODs retain those concave sockets; simplification
is restricted to the other parts. An independent authoring audit tests actual
tessellated triangle intersections at 65 positions per joint and both LODs.
Nested bearing volumes are intentional overlaps. This is an adjacent-shell
visual audit, not a whole-body physical collision solver: arbitrary simultaneous
joint combinations can still self-contact, and the meshes do not certify real
hardware clearance. The existing joint limits are unchanged.

Meshopt remains the existing compressor and decoder. These four robot assets opt
into 24-bit exponential position precision to preserve the machined edge slivers;
other kit assets keep 18 bits, and normal streams keep 12 bits. Export checks
repair only corner normals that oppose their final triangles after batching.
All geometry and materials remain original, texture-free and MIT-credited.

The final compressed assets measure:

| Asset | Bytes | Triangles | Material batches |
| --- | ---: | ---: | ---: |
| Keel | 489,688 | 22,788 | 41 |
| Keel distant LOD | 279,420 | 8,856 | 41 |
| Morrow | 454,940 | 22,752 | 41 |
| Morrow distant LOD | 256,436 | 9,078 | 41 |
| Arena | 113,048 | 7,360 | 6 |

Both heroes and the arena total 1,057,676 bytes, 52,900 triangles and 88 material
batches before scene effects. Every asset stays within its triangle and byte
budget, with zero textures. The clearance audit passed **8,060 sampled poses**
with zero adjacent exterior-shell crossings. The 22 model contract tests also
cover every named pivot, both LODs, compressed normals and 2,400 limb-centre
coverage samples through straight, halfway and folded poses. Visual sweep sheets
record 1,054 additional poses in the live three.js scene.

The final five-minute PC run used both hero meshes with synthetic BODY motion,
DPR 1 and Chromium/ANGLE on an RTX 4090. It measured **17,929 frames in 300.210
seconds**, raw frame-interval p95 **16.90 ms**, retarget/contact logic p95
**0.60 ms**, render submission p95 **0.70 ms** and GPU timer p95 **3.44 ms**.
The scene rendered **93 draws and 53,004 triangles**. Logic stayed below 2 ms;
combined p95 logic/submission/GPU cost was 4.74 ms against the 16.7 ms budget.
Raw frame intervals include scheduling jitter and are reported separately.
This run does not measure simultaneous camera inference or establish the
physical-phone 60 fps target.

After merging master `797c381`, all four typechecks and **2,148 unit tests** passed
(14 skipped). The full sims suite passed **359/359**, including the shared button
checks, and pages passed **59/59**. The Desktop guard reported **no new sessions**:
19 test-browser lines before and after. No final-suite flake needed a rerun.

Evidence is under `artifacts/humanoid/phase-3b/`: preserved `v1/`, final `v2/`,
3840 × 2160 comparisons in `comparisons/`, a native-64-pixel silhouette sheet,
desktop/phone three.js views, per-joint sweep sheets and raw performance data.
Phone viewports are emulated. Physical-phone fps, camera/render contention,
thermals and real motion-to-display latency remain **unverified**.

## Phase 4 drivers — implemented (2026-09-30)

The humanoid panel now selects ROS 2 reference, G1 arm7 or H1 arm4 **simulated drivers only**. There is no robot endpoint or physical transport in the shipped UI. `HumanoidDriver` has mandatory, deadline-checked hold acknowledgement; the rosbridge adapter carries named measured joints, exact profile identity, session/sequence/deadline metadata and a guardian-issued rearm token. Standard ROS acquisition stamps map through a bounded ROS/monotonic clock handshake. Repeated stamps cannot refresh a joint, and clock discontinuities hold. G1 and H1 have separate indices, supported axes, envelopes and stop strategies. The [bridge contract](../hardware/humanoid/README.md) specifies the future local guardian and Unitree integration, with primary-source links and commissioning requirements.

Connection and reconnection start in observe-only mode. A separate Keel reference twin follows reported joints; practice actors never consume the driver lane's gates. Go-live requires verified mapping, fresh finite in-limit measurements, guardian/watchdog/exclusive ownership, 200 ms of stable controller mode, hold ACK, twin alignment, collision clearance, fresh input, workspace confirmation and a newly held local deadman. Stop revokes the token, drops browser goals and confirmations, and calls the selected driver's measured hold or controlled damping. Release, a new press, fresh checks and Go live are required to rearm. Pointer cancellation, lost capture, blur/hide, panel closure, source/generation changes and tracking loss also hold.

Browser and guardian independently enforce upper-body joint/speed/acceleration caps and named-chain collision capsules. Renewal is 50 Hz, maximum lease 100 ms, feedback age 100 ms, local capture age 150 ms and hold/arm ACK deadline 50 ms. The Worker fake polls every 5 ms against the reviewed ≤10 ms poll requirement. Its rest pose places the arms 0.25 rad outward to clear conservative thigh capsules. Real legs remain refused even with an unverified commissioning string; trajectory names exclude them. Practice BODY legs, classical locomotion and presets stay available and are tested independently.

The driver lane accepts jog or local webcam BODY. Local capture supplies its monotonic origin so age includes inference time. Phone BODY continues to drive the practice sim; using it for this lane awaits a verified remote capture-clock contract. No landmarks or camera images enter driver storage or network requests. The panel uses shared glass, selects, sliders, icon actions and centred labels, with a full-size worded Stop and a lime held deadman. The arm source is unchanged relative to merged master.

**Unverified:** physical stopping time/distance, actual ROS/controller or SDK integration, independent process/robot watchdog behavior, real phone timing and hardware collision geometry. The fake's bridge-death branch models a robot watchdog; it does not establish physical process independence. Keel is a reference visualization, not a commissioned G1/H1 twin. A development run with 10 ms polling measured one 110.3 ms watchdog sample; that evidence is retained. Polling was reduced to 5 ms to leave scheduling margin, without weakening the 110 ms acceptance target. No browser timing result is a hard real-time guarantee.

After merging master `e502fc6`, all four typechecks and **2,228 unit tests** passed (14 skipped), including **80/80 driver fault cases**. The full sims run passed **379/380**; the planetary button-page readiness wait timed out. The requested isolated full-suite rerun also passed **379/380**: planetary passed, but studio at 390 × 844 hit the same 30-second readiness timeout. Both failures are retained; the complete sims suite is not reported as green. All humanoid and arm checks passed in both runs.

The isolated run recorded **39 simulated hold samples**: three explicit deadman releases and 36 watchdog samples across ROS/G1/H1 and page-freeze/socket-loss/bridge-loss faults. Hold issuance p95 was **104.9 ms**, maximum **105.1 ms**, within the 110 ms test target. The repeated five-minute two-hero check passed with 17,999 frames over 300.208 seconds, frame-interval p95 16.80 ms, logic p95 0.70 ms, render submission p95 0.80 ms and GPU p95 3.25 ms, at 93 draws and 53,004 triangles. These are desktop Chromium measurements with synthetic motion, not physical-phone or camera-contention results.

Evidence is in `artifacts/humanoid/phase-4/`: machine-readable and readable fault matrices, raw hold events and histograms, phone/desktop driver states, preserved development failures, full-suite logs and frame-time data. The driver footer reserves space above the desktop pairing badge so Stop remains exposed; no shared button styles changed.

After that layout correction, the focused live-driver suite passed **22/22**, phone **35/35**, shared **7/7** and camera **20/20**. The final 39 hold samples measured p95 **104.8 ms**, maximum **105.4 ms**. Nine-point hit tests keep Stop unobstructed on desktop and phone. Final screenshots and the histogram are in `final-browser/`; the raw runner log is in `final-validation/`. The Desktop guard reported **no new sessions**, with 19 test-browser lines before and after. The two full-sims readiness failures above remain an integration follow-up.

## Open decisions — decided by the owner (2026-09-30)

1. **Decided:** Keel and Morrow, including their names, are approved for phase 3. An octopus bot follows in a separately planned phase 6, after humanoid models and motion testing. Rig geometry, joints and chains remain profile data; nothing octopus-specific ships now.
2. **Decided:** practice with contact scoring first. A mode enum separates scoring from movement; timed rounds come later.
3. **Decided:** standing auto-calibration and mirror on by default, plus an optional guided personal range calibration. Eight short steps cover shoulders (raise, forward, out), elbows, wrists, spine twist/bend, hips, knees, ankles and head. Each shows one animated figure and a measured arc, with completion, skip and redo. Measured ranges map monotonically onto robot limits. Only derived ranges and segment lengths persist in localStorage per device; landmarks never persist. Classical play requires no calibration.
4. **Decided:** ROS 2 first, with fake G1/H1 adapters in phase 4. Real legs remain locked pending separate commissioning. Sim legs follow BODY with visual foot-contact balance and classical locomotion; no sim feature inherits the hardware leg lock.
5. **Decided:** npm 0.3.0 ships HAND and BODY together. Publishing belongs to the coordinator; this branch does not publish or change the release version.
