# F1a2: constrained-inertia stance candidate

This is a **candidate**, not accepted F1a, F1b or F1c. Native Rapier and browser
acceptance were not executed in the authoring sandbox. No production practice or
seat default is changed. Sections 5-6 of
[HUMANOID-PHYSICS.md](HUMANOID-PHYSICS.md) retain historical F1a evidence;
section 7 records the measured F1a2 reconciliation. Its stance passes, while anatomy
and authored-rendering acceptance remain pending.

## Scope and unchanged parameters

`humanoid-f1a2-v2` selects `constraint-damped` torque prediction for the private
pilot. All eight models retain the exact previous shapes, masses, body positions,
rotations, skin dimensions, anchor/frame transforms, asymmetric cones, motor gains,
individual effort caps, friction, restitution, damping and contact solver settings.
The before/after comparison removes only model version and integration-mode fields.
It compares all remaining model data, not selected scalar totals.

There remain 16 dynamic bodies, 15 joints and 59.5 kg per actor. The sum of declared
individual joint torque caps is 1414 N m; this is **not** a single actuator rating or
permission to apply that torque to a body. The pelvis is free. Existing native
spherical constraints and native collision handling remain authoritative. Nothing
projects body poses, rewrites feet, changes skin geometry or adds a root-support force.

Default F0 torque control and `inertia-damped` remain available unchanged. Coupled
mode is explicit and cannot be mixed with another motor integrator within a scene.
The selected engine remains the shipped Rapier dependency. No dependencies, package
manifests, lockfiles or native adapters are changed.

## Why change the free-body prediction?

The old approximation combines inverse inertia about two unconstrained body centres.
That omits the translational response at a joint anchor and the other links and
loaded contacts. An independently calculated uniform test rod demonstrates the
missing term: mass 3 kg, half-extents (0.1, 1, 0.2) m and a 1 m anchor offset have
COM inertia 1.04 kg m^2 about X but anchor inertia **4.04 kg m^2**, not 1.04.

For two identical, straight test links, relative joint coordinates give the planar
mass matrix `[[32.08, 10.04], [10.04, 4.04]]` kg m^2. The new offline tests compare
the response to its independent inverse, including off-diagonal coupling. They also
check rotated anisotropic covariance, dissipation in a one-axis implicit step and
separation of disjoint actors in the *mathematical* response. These are not native
stance, impact, collision-isolation or get-up results.

The general kinetic-energy and constrained-dynamics formulation is described in
MIT's [Multibody Dynamics notes](https://underactuated.mit.edu/multibody.html),
especially the manipulator equations and bilateral constraints. The numerical
implementation and rod examples here are original; no third-party code is copied.

## Local coupled motor/stop solve

`constraint-response.ts` builds a current, mass-weighted velocity response. Dynamic
body coordinates use translational weights `1/sqrt(m)` and rotated principal angular
weights `1/sqrt(I)`. Each anchor contributes three relative point-velocity rows.
Let `Q` be an orthonormal basis of those weighted constraint rows and `W` map a
joint torque to equal/opposite body angular forces in the weighted coordinates.
The local joint acceleration response is

```
H = W^T (I - Q Q^T) W
```

The implementation uses the equivalent sparse-column Schur form, without forming a
dense projector. Two-pass reorthogonalisation removes duplicate/coplanar rows. It
does not add compliance, a pinned root or a pose correction. Gravity is projected
through the same response for the next-velocity prediction.

For the implicit motor step, `C = D*dt + K*dt^2`, with a rank-one contribution from
an active directional stop. Motor and stop share **one** solve:

```
(H + inverse(C)) * torque = inverse(C) * rhs
```

The matrix order matters for anisotropic response. The existing stop stiffness
1200 N m/rad and outward damping 30 N m s/rad are unchanged; they do not get a
second independent inertia budget. Torque is capped once per joint after the solve.
Both unconstrained algebra residual and **applied residual after saturation** are
reported. A small unconstrained residual is not evidence that a saturated actuator
realised the unconstrained solution.

This is a local velocity predictor, **not** complete inverse dynamics, a friction
optimizer or an energy/fall guarantee. It omits Coriolis/gyroscopic bias in its
prediction, changing-contact impulses and saturation coupling. The native engine
still handles the actual dynamics. High-speed motion, contact transitions and
simultaneous pose interference must pass the real acceptance tests.

## Actual contacts, not geometric support

Only copied native manifold samples can supply contact rows. A static/dynamic pair
must have positive impulse within the existing prediction distance. Its zero-pressure
manifold points can then bound the footprint. Separating contact points contribute
nothing; moving tangentially or frictionless material removes tangential sticking
rows. This predicts local sticking only: it cannot force native friction to stick.
Dynamic/dynamic contact is deliberately **not** treated as a bilateral support in
this predictor; native collision response is still present. F1b must investigate
impacts and two-actor coupling, not assume this limitation is an accepted result.

See the primary Rapier descriptions of
[joint constraints](https://rapier.rs/docs/user_guides/javascript/joint_constraints/)
and [contact manifolds](https://rapier.rs/docs/user_guides/javascript/advanced_collision_detection/).
The installed 0.21.0 package and measured `version()` remain the implementation
authority; moving documentation is not a dependency substitution. References were
read on 2026-10-03. No assets or reference meshes are added.

## Bounded support targets and policy boundary

`StanceController.step(observation)` computes a `source: 'classical'` schema-1 frame.
The native stance measurement explicitly supplies this controller to `pilot.advance`.
It is **not** silently installed as the pilot's default or as a production controller.
No-input hold, quiet, reset and explicit caller inputs retain their existing ownership.

Observation adds owned per-foot upward load, pressure-weighted centre of pressure,
manifold footprint and material-point tangential speed, plus mass-weighted COM
velocity. The controller uses those loads, the measured support polygon and COM to
bias existing ankle/hip targets. It cannot send forces or body transforms. Requests
still pass through the same complete-target, generation/tick, cone and 4 rad/s
ActuationGate and are recorded with the pre-step observation and accepted action.
There is no wall clock, heading accumulator or action queue. Yaw covariance is
checked offline; this **does not reproduce or fix the separate BODY heading bug**.

No support produces nominal targets. A low/tilted actor is outside this controller's
stance envelope, also producing nominal targets; this is not a get-up or a safe-fall
controller. All torque/force limits continue to apply. A learned signature policy
may later consume the same observation and return the same frame. Learning, policy
storage and recording UI are absent. Observation model version changed; cross-version
replay must validate the paired observation version before consuming actions. Bare
schema-1 actions do not carry a model-version field and are not a portable policy file.

### New simulation and numerical defaults

| Quantity | Value and units | Meaning |
| --- | --- | --- |
| COM position feedback | 4 s^-2 | Original stance target default, not measured stability |
| COM velocity feedback | 4 s^-1 | Nominal critically damped 2 rad/s design reference only |
| Hip tilt gain | 0.2 rad / unit horizontal torso-up component | Target bias, not root torque |
| Ankle / hip bias cap | 0.1 / 0.08 rad | In addition to unchanged cone/slew/effort limits |
| Stance envelope | up Y >=0.8; COM height >=0.65 initial COM height | Dimensionless controller guard, **not** the stricter acceptance gate |
| Predicted sticking/separating speed | 0.02 m/s | Local response approximation; native friction/separation wins |
| Rank tolerance | 1e-10, dimensionless after row normalization | Numerical rank only |
| Dense workspace | 32 dynamic bodies, 32 joints, 256 samples | Allocation bounds; not proof of two-actor performance |
| Quaternion/normal length tolerance | 1e-4, dimensionless | Numerical validity envelope |
| Fixed-tick timestamp tolerance | 1e-10 s | Numerical identity, not tolerated frame staleness |
| Inverse-gain floor | 1e-9 N m/rad | Numerical division guard; pinned ankle gains remain strictly positive |
| Support-area cutoff | 1e-10 m^2 in twice-area | Degenerate-polygon numerical guard |
| Native anchor audit tolerance | 2% +1e-5 rad/s absolute | One-tick analytical fixture, never a change to humanoid gates |

Existing 240 Hz, 12-step/50 ms catch-up, 30-second stance, 5 mm, 0.01 rad cone,
90% pelvis height, up Y>=0.98 and all 6720 settled support checks are unchanged.
No new slip acceptance threshold is invented.

## Loaded sliding versus legacy displacement

`LoadedSlipMeter` integrates pressure-weighted tangential **material-point velocity**
with trapezoidal fixed-tick sampling. Both endpoints must belong to one consecutive
positive-load episode. Lift-off closes the episode; touchdown establishes the next
reference without bridging airborne motion. Duplicate, skipped, wrong-actor,
wrong-generation and non-finite samples reject atomically. A rolling point can have
zero sliding even while its foot origin translates.

The JSON fields are deliberately explicit:

- `loadedSlipMm`: maximum per-foot cumulative loaded path, starting at tick 481.
- `loadedSliding.feet`: loaded samples, episodes, total path and maximum episode path.
- `fallDisplacementMm`: unchanged maximum foot-origin XZ displacement from tick 481,
  in all contact states. It is not a fall classifier and can include intended movement.

`slipMm`, the old `slip` witness and displacement references remain deprecated aliases
for the last quantity so historical render strips remain comparable. They are **not**
relabelled as loaded slip. New metric fields are null when no post-warm-up sample was
executed. Every lower-face corner still contributes to penetration/hover on every tick,
including after collapse; no unloading exception hides a tipped foot.

## Verifier, performance and remaining gate

The candidate initially promoted all 80 physical expected-failure gates to ordinary
assertions before acceptance ran. Reconciliation keeps the measured passing stance
gates ordinary and records only the 24 measured anatomy failures as `it.fails`, under
the unchanged thresholds. The ordinary harness still fails missing, errored or
incomplete trials; a green test command does not mean physical acceptance. All eight
forms retain `physicalAcceptance: false`. The measured values and remaining work are
in [HUMANOID-PHYSICS.md](HUMANOID-PHYSICS.md#7-f1a2-candidate-after-the-recorded-follow-up).
Node prints
`humanoid-f1a2-native`, `humanoid-f1a2-candidate-table` and the two-row independent
`humanoid-f1a2-native-anchor-response` audit. Errors/missing measurements print before
assertions. An eight-form measured table, 97 trials/form and fixed-tick replay remain.

The existing `OBPAL_E2E_SIMS_ONLY=humanoid-physics` group adds an ordinary gate for
three 7200-tick browser stance rows. It retains 18 motion/loading rows, eight sheets,
three stance strips, 133 expected raw frames, actual timestamps, zero clock loss and
the 180-second row budget. A failed stance also makes its row false in JSON. The
15/16 authored-skin gate remains explicitly pending for F1c. There is no new BODY,
two-actor browser, latency or full-scene release proof.

A sandbox numerical microprobe exposed a performance risk in the first dense
implementation. Sparse Schur evaluation removed redundant dense column projections
without changing the mathematical assertions. The retained before/after logs are in
this stage's TESTS.md. Even the revised probe has noisy multi-millisecond tails. It
uses fixed initial states and empty contacts on Linux/Node, **not native physics,
browser frame time or a controlled speedup benchmark**. Native timing and 4x narrow
clock gates remain open. Do not relax clock/quality limits to fit this predictor;
profile the actual native run before proceeding to two actors.
