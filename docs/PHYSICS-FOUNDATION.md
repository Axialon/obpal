# Physics foundation: implemented proof and remaining F0 contract

**Status: partial, not ready to start F1.** This return supplies a real fixed-step adapter and pendulum migration,
not the requested complete rigid/articulated/vehicle/buoyant engine. No Rapier dependency or mock wrapper is
present. Do not infer implementation from the continuation design below. See [SIMS-PROGRAMME](SIMS-PROGRAMME.md)
for the audit/roadmap and the return pack's TESTS.md for executed versus pending gates.

## Implemented data flow

`DeviceInput -> PendulumLogic input handling -> FixedWorld fixed ticks -> PendulumAdapter -> owned snapshots
-> renderState -> pendulum view`.

The existing device registry still loads the pendulum module only for that sim/preview. No physics import is
added to the shared kit or other device logic. PAD/POSE/HAND/BODY messages, hardware paths and presentation
snapshot whitelist are unchanged. This is opt-in through constructing a world, not a global replacement loop.

| Module | Actual responsibility |
| --- | --- |
| `src/sim/physics/world.ts` | Engine-neutral adapter, accumulator, budgets, snapshots, diagnostics and disposal. |
| `pendulum.ts` | Real nonlinear one-degree-of-freedom pendulum integration, viscous damping, lab stops and sleep/wake. |
| `interpolation.ts` | Finite position interpolation and shortest-arc normalised quaternion interpolation. |
| `materials.ts` | Immutable named friction/restitution defaults and a symmetric combining policy. No general contact response is implemented. |
| `debug.ts` | Optional DOM diagnostics output, refreshed by the view; no timers, telemetry, network or hardware reads. Not a collider visualiser. |

### Clock, bounds and replay

Default timestep is 1/240 second, max 12 steps per frame, max accepted frame time 0.05 second, max 64 bodies.
The proof constrains body count to three. Limits are validated; invalid/negative/non-finite frame times are
counted and do not advance the clock. Frame-clamped time and steps discarded by overload are reported as
`droppedSeconds`, not accumulated into a later catch-up burst. A 1e-10 tick-count tolerance repairs floating
point summation at exact boundaries. Budgets are count-based, not CPU-deadline based.

The renderer interpolates the previous/current completed snapshots with the fractional remainder, introducing
one fixed tick of visual latency (about 4.17 ms), without contact extrapolation. Snap resets both snapshots after
Home without rewinding the shared clock. Disposal is idempotent and disallows later step/render/snap use.
Snapshots belong to the caller; adapters must not return aliases to mutable engine memory.

Repeatability means the same runtime, initial state, fixed tick stream and input sequence. Free motion is tested
at 30/60/120 render partitions. Input is still handled by the existing device frame path: this is **not** a claim
of bitwise replay for arbitrary differently timed live input, cross-browser transcendental calculations or a
network lockstep protocol. Future multi-body input events need explicit tick-boundary quantisation and ordering.
The adapter interface carries tick IDs; the pendulum does not need a random seed.

### Pendulum mechanics and preserved controls

Velocity Verlet with symmetric exponential viscous damping integrates `theta'' = -g/L sin(theta) - d theta'`.
Gravity is 9.81 m/s². Existing lab controls retain length 0.55-2.2 m, damping 0-1.2, angle stop +/-1.4 radians,
speed bound +/-5 rad/s and stop bounce factor -0.35. These stops are a lab/game policy, not restitution measured
from metal. Length changes preserve the existing angular-momentum adjustment. Push edges, tilt debounce,
quiet/positioned input behaviour and independent unit settings remain. Non-finite touch/tilt input is rejected
or neutralised before it can poison state.

A unit sleeps after 0.25 simulated seconds with `abs(angle)+abs(omega)<1e-4`; sleeping state is exactly zero.
External nonzero motion wakes it. History is sampled at 30 Hz on fixed ticks, capped at 300 samples. Home resets
the selected experiment and snapshots; other unit physics state is retained. The shared world continues counting
ticks and history even when all pendulums sleep: this is not a zero-allocation/zero-cost sleeping-world claim.

Shared guests receive `applyDevice` presentation updates without stepping host physics. A review regression test
found that blindly returning world snapshots made those guests appear frozen. `renderState` therefore uses the
replicated live pose when it differs from the last simulated pose, otherwise the interpolated local snapshots.
The test proved the old failure and now checks the guest pose while its tick remains zero. No wire changes or
new authoritative replicated engine state are introduced. The guest displays host presentation samples, not an
independently deterministic dynamics replay. Its downstream network smoothing remains unchanged.

Energy checks apply only with fixed length, zero damping and no stops/pushes. Parameter changes intentionally do
work; damping/sleep/stops dissipate energy. The scalar solver is not a general rigid body, a swing/twist joint,
a motorised chain, a tyre or a buoyant hull.

### Material table

The initial defaults are metal (friction 0.45, restitution 0.15), rubber (0.9, 0.1), ceramic (0.35, 0.2), ice
(0.04, 0.02). Pair friction is the geometric mean and restitution the minimum. These are **simulation defaults**,
not measured tribology; the eventual backend must implement and test the stated combining rule. The pendulum's
lab stop does not consume the table. No collider/contact system exists merely because this table exists.

### Diagnostics

Open the proof with `?d=pendulum&physics=debug` on the device page to see backend, body/sleep counts, ticks,
steps, interpolation fraction, dropped time and invalid frames. The view owns refresh; the helper has an explicit
remove operation and no autonomous work. Normal page navigation releases the DOM. The existing DeviceView has
no teardown contract, so reusable view mounting must gain one before a resource-owning backend is migrated.

## Actual numeric proof, and what it does not choose

A local headless microbenchmark compared the **pinned original PendulumLogic** with this actual implementation.
Node 22.16.0, Linux, Intel Xeon Platinum 8370C reported by the container, five visible logical CPUs. No GPU,
browser, phone or physical machine was simulated. Nine measured batches of 20,000 frames followed two warm-up
batches; dt=1/60. Both variants include the real three-unit logic/history; the new variant additionally computes
its render snapshot. Variance and full raw output are in the return pack, outside the repository patch.

| Measurement | Pinned original | This partial |
| --- | ---: | ---: |
| Max relative undamped energy error, theta0=0.8, L=1.2, 60 simulated seconds | 0.00576183634 | 0.00003368821 |
| Max final-angle difference across 30/60/120 Hz, five seconds free motion | 0 | 0 |
| Median active CPU ms per 60-Hz frame, three units | 0.00160585 | 0.00396877 |
| Median resting CPU ms per frame, three units | 0.00076981 | 0.00316432 |
| History cap at end of energy experiment | 300 | 300 |
| Rapier timings / download / memory / articulated stability | Not measured | Not measured |

The energy bound improved in this experiment; both versions already agree across these exact render partitions.
The new abstraction/snapshot work **costs more CPU**, including at rest. These numbers do not establish 60 fps,
phone viability, superiority to Rapier or the completed F0 engine selection. Tests also cover rest/sleep/wake,
finite states, interpolation continuity, bounded impulses, Home, controls and shared guest presentation.

No dependency was installed: the environment has no pnpm, Vitest, three, Playwright or Rapier packages, and the
snapshot lockfile was not changed. The isolated global TypeScript 5.8.3 check is not the repository-pinned full
check. The canonical engine choice and dependency graph remain a required closure stage, not an implied rejection
of the preferred engine. [R1](OPEN-REFERENCES.md) is the primary engine reference.

## Smoothness report and proof gate

`scripts/e2e-smoothness.mjs` composes the landed warm-up capture helper with a separate-context motion probe.
It never changes the renderer's framebuffer-preservation flags. Temporary output is printed and includes an
incremental `report.json` plus a per-ID result, even for failed/incomplete scenes. Only pendulum is enforced by
the usual sims suite; all other 41 configurations are report-only. `OBPAL_E2E_SIMS_ONLY=smoothness` selects the
full report through the existing guarded sims runner; `OBPAL_SMOOTHNESS_SIZE=phone` selects the phone viewport.
Use the local guarded runner, not production, and remove the ONLY environment variable before full suites.

The probe uses actual RAF timing, render-frame progress and rigid mesh draw submissions during one second of
rest, ten seconds of pendulum motion/orbit and one second after Home. It retains existing mesh render hooks and
camera state. For parts wholly inside an independently computed frustum box, a missing draw submission is an
error. Removal/visibility loss, unexpected geometry identity changes and non-finite transforms are recorded.
Skinned/instanced geometry is explicitly unsupported; per-part pixel visibility, occlusion and colour flashes
during motion are not certified. Existing warm-up capture handles blank/flash startup tests separately.

Provisional enforced budgets: p95 RAF gap <=25 ms, p99 <=50 ms, max gap <=250 ms; at least 80% of moving RAFs render;
>=10 seconds motion with >=120 moving samples and >=180 total. Pendulum angle <=1.400001, speed <=5.000001,
rest jitter <=1e-4 and no invalid frames. These are first-proof thresholds, not the stricter F1 60-fps claim.
Missing motion, unsupported geometry or physics, and missing warm-up data produce `incomplete`, never pass.
Classifier unit fixtures test that rule, but **are not real browser measurements**. No first all-sim browser report
was produced here; the task explicitly assigns that capture to the coordinator.

For other sims, orbit alone is insufficient: each wave adds real input-driven motion, per-model coverage,
intentional visibility/swap semantics and its own physical invariants before enforcement. The initial 42 entries
do not automatically select six soft forms, occupy arena seats or validate every imported model. Those are
explicit continuation gaps, not silent passes.

## F0-R closure: exact implementation still required

Request a new stage ID against the coordinator's accepted master after this partial is reviewed; include the
actual dependency environment and before files. Do not start humanoid physics on this scalar adapter alone.

1. Benchmark one pinned Apache-2.0 Rapier build against a small custom constraint solver on the same host:
   pendulum, stacked rigid blocks, motorised two-link chain/cone limits, wheeled body and partially submerged hull.
   Record cold compressed/decoded size, WASM init, peak memory, CPU p50/p95/p99/tick, contact penetration, constraint
   error, drift, sleeping behaviour and equal-tick replay. Use identical masses/colliders/tolerances/workloads and
   multiple runs; report every unsupported case rather than comparing incompatible features. Prefer Rapier when
   it meets the agreed budget. Only the chosen engine is a new dependency; update the lock and credit together.
2. Implement real lazy-loaded backend creation/disposal, rigid body mass/inertia/collider validation, motorised
   articulated joints with tested swing/twist cone limits, wheels with suspension/traction and primitive-volume
   buoyancy/drag with force-at-point torque. Types/descriptors alone do not meet this acceptance. Keep world/body
   IDs stable and make tests exercise actual falling/contact, motor settling, rolling load and floating trim.
3. Test negative/non-finite parameters, broken async initialization, disposal/re-entry, body/step/force budgets,
   quaternion sign/wrap, saturated motors, sleep/wake, energy under damping, deterministic tick ordering and overload.
   A failed backend must not half-advance a recoverable world; define an explicit fault/reset contract.
4. Close the proof's browser evidence and add cold/slow/failed asset cases. Extend motion coverage for skinned/
   instanced/deforming parts and intended LOD switches before promising a reusable all-model no-pop gate. Keep
   report-only gaps visible. No other sim migration is needed to finish F0.
5. Run the pinned private scan, overclaims, canonical check and guarded sims/pages/catalogue/shared suites;
   capture desktop/phone reports and reconcile red results. Only then call F0 complete and release the F1 brief.
