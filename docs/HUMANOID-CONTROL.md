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

The limits shape get-up: hip flexion is at most 100°, knee 130°, ankle dorsiflexion 25°. A flat-foot deep squat leaves the hip about 0.24 m behind the ankle, so the COM falls behind the heel. Rising must therefore start from a crouched pike: knee about 1.1 rad, hip at its limit, trunk at least 60° forward. That puts the COM about 0.11 m ahead of the ankle.

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
- **Ankle.** From `ξ' = ω(ξ - r_cmp)`, set `r_cmp = ξ + k_ξ(ξ - ξ_ref)` toward the polygon centroid. Clip to `r_cop` inside `P` shrunk 0.01 m. Apply `F = m ω²(com - r_cop)` by Jacobian transpose per stance leg, weighted by load share. A foot with fewer than three hull points, or turning faster than 1 rad/s, gets no ankle torque (GBWC).
- **Hip.** The residual `e = r_cmp - r_cop` sets a trunk moment `m g e`, at most 60 N m, while trunk pitch is within 0.35 rad. Stance hips realise it SIMBICON-style; a torso PD returns upright. Sign test: a toe-ward excess pitches the trunk forward.

**stepping.ts**

- **Trigger:** `ξ` more than 0.03 m outside the shrunk polygon for two ticks, or `|v| > 0.35 m/s` (GBWC rule).
- **Swing:** the less-loaded foot. On a lateral exit, the exit-side foot once its load share is ≤ 0.6 (balance unloads it by ankle roll). Never a crossing step.
- **Landing:** `ξ_T = r_cop + (ξ - r_cop)e^(ω T_s)`, `T_s = 0.32 s`, plus 0.03 m along the exit. Length is capped at 0.6 L (GBWC); lateral width from the stance ankle is at least 0.20 m. A capped step recomputes at touchdown, giving N-step recovery.

**gait.ts** runs SIMBICON's four states (lift and strike, each side):

| State | Exit | Swing hip θ₀ (world) | Swing knee | Swing ankle | Stance knee |
| --- | --- | ---: | ---: | ---: | ---: |
| Lift | t ≥ 0.30 s | 0.40 | 1.10 | 0.20 | 0.05 |
| Strike | swing foot loaded 2 ticks, or t ≥ 0.40 s | 0.00 | 0.05 | 0.00 | 0.10 |

- Lift values are SIMBICON's walk row, flexion-positive. The knee's 1.10 rad at 4 rad/s takes 0.275 s, inside the lift.
- **Swing hip** (world frame): `θ = θ₀ + c_d d + c_v(v - v_d)` in both planes, where `d` and `v` are the COM relative to the stance ankle. Raibert's `(v - v_d)` replaces SIMBICON's `v`. Lateral θ₀ is 0.05 rad abduction. Convert with `worldTarget`.
- **Torso and stance hip.** The pelvis follows `yaw(ψ_d)` under a PD, `tau_t = 300·err - 30·w`. The stance hip gets `tau_A = -tau_t - tau_B` in torque mode, split by load in double support.
- **Stance ankle:** GBWC velocity tuning `F_V = k_V(v_d - v)` sagittally plus a lateral PD (30 s⁻², 11 s⁻¹), by Jacobian transpose. Gravity compensation on the swing leg.
- **Turning, start and stop.** Stance-hip twist error is capped at ±0.3 rad. Start shifts the COM 40% toward the future stance foot (GBWC). Stop needs `v_d = 0` and `|v| < 0.1 m/s` at strike.
- **Recovery steps** reuse the machine with `v_d = 0`, aiming the swing hip at the landing target.

**getup.ts**

- **Fall:** a non-foot floor impulse, or `up.y < 0.8` or COM below 0.65 h₀ with no step possible. Protective arms (Faloutsos): shoulders 1.2 rad toward the fall, elbows 0.3, knees 0.4.
- **Settle:** `|v_com| < 0.05 m/s` and every `|ω| < 0.3 rad/s` for 0.5 s.
- **Classify** by thorax forward axis: `f·ŷ < -0.5` is prone, `> 0.5` supine, else roll to prone.
- **Supine** rolls to prone first, as Faloutsos's stuntman does (S1, 2.0 s): head 0.6 and spine yaw 0.3 toward the roll, far arm across (pitch 1.2, roll −0.2), far leg crossing (hip pitch 0.8, roll −0.3). One retry, on the other side.
- **Prone** adapts Behnke's phases. Each phase eases to its keyframe (cosine plus gate slew) and advances only on its post-condition:

| Phase | Key targets (rad) | Post-condition | Timeout |
| --- | --- | --- | ---: |
| P1 Hands under | shoulder pitch 1.4, roll 0.3; elbow 1.9 | both hands loaded | 1.0 s |
| P2 All fours | elbow 0.15; hip 1.5; knee 1.6 | hands and shins loaded; pelvis ≥ 0.35 m | 1.5 s |
| P3 Toes tucked | ankle 0.43; knee 1.1; shoulders 0.9 | both feet loaded; COM in hull(hands ∪ feet) | 1.5 s |
| P4 Crouched pike | hip 1.74; trunk ≥ 60° forward; hip offset `k_c(com - feetCentroid)` | COM in feet-only polygon | 1.5 s |
| P5 Rise | knee/hip → 0.05/0 over 1.2 s; ankle law on | `up.y ≥ 0.95`; pelvis ≥ 0.85 h₀ | 2.0 s |
| P6 Settle | nominal; `StanceController` | 0.98 / 90% held 1 s | 2.0 s |

Keyframes are SD starting points; post-conditions are the contract. After two failures the actor is `down` (limp hold, not quiet).

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
| Support shrink | 0.02 m | HUMANOID.md 2 cm |
| `k_ξ`; hip cap; trunk limit | 1.0; 60 N m; 0.35 rad | SD |
| Step trigger; `T_s`; overshoot; min width | 0.03 m or 0.35 m/s; 0.32 s; 0.03 m; 0.20 m | SD (GBWC form) |
| Maximum step | 0.6 L | GBWC |
| Lift 0.30 s; knee 1.10; hip 0.40; ankle 0.20; stance knee 0.05 | rad | SIMBICON walk |
| `c_d`, `c_v` | 0.5 rad/m, 0.2 rad s/m | SIMBICON 3D walk |
| Torso K/D | 300 N m/rad, 30 N m s/rad | SIMBICON |
| `k_V` | 60 N s/m | SD |
| Speeds fwd/back/side; yaw rate | 0.5/0.25/0.25 m/s; 1.0 rad/s | SD (GBWC −0.6…1.7 m/s, 2 rad/s) |
| BODY ramps; spine clamp | 0.15/0.25 s; 0.15 rad | HUMANOID.md; SD |
| Get-up `k_c` | 1.0 rad/m | SD |
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

Only algorithms are adapted; no third-party code, parameters or assets are copied. Any implementation a lane reads must be MIT, Apache-2.0 or BSD and credited in `src/support/open-source.json`.
