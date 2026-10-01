# Open references: useful facts, explicit file licences

Research checked on 2026-09-30 using the primary project pages and file-level licence headers below. These are
reference candidates, not vendored or version-pinned dependencies. **No external asset, code file, robot
parameter file or new dependency was imported by F0.** Consequently this return does not add an open-source.json
credit for something it does not ship. Future reuse must pin a commit/content hash and retain all required
notices in the same reviewed packet as the imported files. A moving URL is sufficient for a research lead,
not for a reproducible import manifest.

Physical parameters, joint layouts and demonstrated mechanisms can inform an independently authored model with
citation. A published simulation's inertia or contact coefficient is not necessarily a measured hardware value.
Distinguish measured data, fitted simulation data and our defaults. Never copy NC, ND, incompatible share-alike or
unlicensed files. Root repository licensing is not a blanket licence for linked CAD, submodels or textures.
No external reference authorises changing ob.Pal hardware drivers or driving a physical robot during tests.

## Reference ledger

| ID / family | Primary source and exact licence boundary | What it provides | Planned use, and what is not imported |
| --- | --- | --- | --- |
| R1 / foundation | [Rapier TypeScript source](https://github.com/dimforge/rapier/tree/master/typescript), [Rapier repository licence](https://github.com/dimforge/rapier/blob/master/LICENSE): Apache-2.0. [Official determinism guide](https://rapier.rs/docs/user_guides/javascript/determinism/). | Rigid bodies, joints, contacts and JS/WASM integration; exact capabilities depend on the pinned build. | Preferred F0-R engine candidate. Measure against the custom reference solver, pin one accepted package/build and lazy-load it. Not installed or benchmarked in this return. |
| R2 / humanoids | [Menagerie Unitree G1](https://github.com/google-deepmind/mujoco_menagerie/tree/main/unitree_g1), [that model's LICENSE](https://github.com/google-deepmind/mujoco_menagerie/blob/main/unitree_g1/LICENSE): BSD-3-Clause. | MJCF articulated layout, joint/actuator configuration, body inertials and collision/visual separation for a real robot family. | F1 parameter-structure and joint-space reference, with version/units checks. Do not silently copy G1 masses into differently proportioned ob.Pal bodies or copy branded shells. |
| R3 / humanoids | [Berkeley Humanoid Lite](https://github.com/HybridRobotics/Berkeley-Humanoid-Lite), README licence section: code MIT; other assets CC-BY-SA-4.0. | Functioning open humanoid architecture, assembly/transmission information, controls and simulation descriptions. | Read layout/transmission facts for F1/H2, cite them. **No CAD, meshes or other SA assets copied.** MIT software permission does not relicense the design assets. |
| R4 / humanoids | [ToddlerBot](https://github.com/hshi74/toddlerbot), [README licence declaration](https://raw.githubusercontent.com/hshi74/toddlerbot/main/README.md): code/docs MIT; design (Onshape/STL etc.) CC-BY-NC-SA-4.0. | Working locomotion/manipulation platform, motor/control conventions and mechanical layout. | F1 reference for target/actuator separation and documented functional layout. **No design files/meshes imported.** A downstream model's MIT label is not accepted as proof that upstream restricted geometry is cleared. |
| R5 / humanoids | [Open Duck Mini v2](https://github.com/apirrone/Open_Duck_Mini): root Apache-2.0; linked external CAD/runtime resources need their own audit. | Small walking robot build, simulation/training/runtime resource links and stance/gait architecture. | F1 balance/recovery reasoning and compact-joint packaging reference. Do not copy its entertainment-character styling or assume the hub's licence covers every linked file. |
| R6 / arms | [TheRobotStudio SO-ARM100 / SO-101](https://github.com/TheRobotStudio/SO-ARM100), root LICENSE: Apache-2.0. | STEP/STL and simulation resources, assembly, joint layout, gearing/motor variant information for functioning arms. | A1/A2 cross-check frames and the SO-101 twin's geometry against a pinned source. Keep existing ob.Pal offsets and hardware safety. Verify exact variant/voltage before any torque assumption. No hardware operation in this programme stage. |
| R7 / arms | [Menagerie UR5e](https://github.com/google-deepmind/mujoco_menagerie/tree/main/universal_robots_ur5e), [model LICENSE](https://github.com/google-deepmind/mujoco_menagerie/blob/main/universal_robots_ur5e/LICENSE): BSD-3-Clause. | Six-axis MJCF, inertials, ranges and separated collision geometry for a working industrial-arm family. | A1/A2 reference for joint frames and inertial bookkeeping; independent ob.Pal skin and profile. A model file is not certification of a safe industrial controller. |
| R8 / vehicles and mechanisms | [Project Chrono](https://github.com/projectchrono/chrono), root LICENSE: BSD-3-Clause; third-party/contrib and individual data assets need separate notices. [Vehicle module](https://api.projectchrono.org/vehicle_overview.html). | Multibody/vehicle formulations, suspension/tyre/track examples and mechanism constraints. | Wave C and A load/constraint reference, plus offline comparison cases. Do not port the C++ engine or add a runtime dependency; do not treat every example parameter as measured production hardware. |
| R9 / flight | [PX4 Gazebo motor model](https://github.com/PX4/PX4-SITL_gazebo-classic/blob/main/src/gazebo_motor_model.cpp): that file's header is Apache-2.0. Other files/airframe meshes require their own review. | Rotor speed, thrust, reaction torque and motor response formulation in an established flight-simulation stack. | Wave D drone/helicopter force and lag reference; exact airframe coefficients need provenance. No blanket licence or realism claim for all PX4/Gazebo assets. Use the official airframe data only after a per-file audit. |
| R10 / mobile robots | [ROBOTIS TurtleBot3 simulations](https://github.com/ROBOTIS-GIT/turtlebot3_simulations), root LICENSE: Apache-2.0. | Gazebo simulation packages and references for an actual differential-drive robot platform. | Vacuum/rover controller and contact-test design. Validate the selected description's wheel geometry, inertia and individual asset notices before any file reuse. It is not a vacuum-cleaning physics model. |
| R11 / water | [Gazebo Buoyancy.cc, gz-sim8](https://github.com/gazebosim/gz-sim/blob/gz-sim8/src/systems/buoyancy/Buoyancy.cc): file header Apache-2.0. | Submerged-volume/centre-of-volume forces and torques on primitive collision shapes, with explicit model limitations. | Boat/submarine and later continuum medium tests. Independently implement a bounded primitive model with stated units/signs, not a claim of CFD. It supplies a formulation, not a particular real hull's calibrated coefficients. |
| R12 / quadrupeds | [Menagerie collection](https://github.com/google-deepmind/mujoco_menagerie): per-model licences, **not one blanket asset licence**. [Unitree Go2's model LICENSE](https://github.com/google-deepmind/mujoco_menagerie/blob/main/unitree_go2/LICENSE) is BSD-3-Clause. | Real robot descriptions including quadruped joint layouts, inertials and actuator models. | Dog stance/IK/contact reference in wave E. This is a research candidate only; the licence was inspected, but any reuse still requires a pinned per-file/provenance review. |
| R13 / continuum | [PyElastica](https://github.com/GazzolaLab/PyElastica) and [COOMM](https://github.com/hanson-hschang/COOMM): each root MIT. | Cosserat-rod simulation and a control-oriented octopus muscle model, with reproducible research examples. | Numerical reference cases for strain/twist/energy and muscle-like actuation, not evidence of a fully functioning eight-arm hardware robot. No Python runtime dependency in the browser. |
| R14 / physical soft prototypes | [Original Harvard Octobot report](https://seas.harvard.edu/news/first-autonomous-entirely-soft-robot) and the primary research links already collected in [OCTOPUS.md](OCTOPUS.md). No compatible file/asset licence is established here: publisher/author copyright, reference-only. | Distinguishes demonstrated soft actuation, manipulation and locomotion across different physical prototypes. | Wave B functional inspiration and limits. Never copy article figures, meshes or CAD; do not describe the Octobot actuation demonstration as proven eight-arm walking/swimming. |

## Sources are not interchangeable

Menagerie explicitly organises licences by model. The G1 and UR5e model licence files above were inspected;
a top-level Apache label cannot authorise every other robot. Berkeley's code/asset split and ToddlerBot's
MIT/CC-BY-NC-SA split make them useful references but unsuitable sources of design files under this brief.
Open Duck's links and character inspiration require caution even where repository code is Apache licensed.
Chrono, PX4 and Gazebo examples need matching file headers and versioned parameters, not copied filenames alone.

The old [rapier.js repository](https://github.com/dimforge/rapier.js) now points to Rapier's TypeScript subtree.
Use the canonical source for a new dependency decision. The official determinism guidance makes initial state,
construction order and identical versions part of replay assumptions, and warns about platform-dependent
transcendental inputs. F0's JavaScript pendulum claims same-runtime tick replay only. No cross-browser bitwise
claim is made and no untested package variant is declared deterministic merely from its name.

For every parameter adopted later, retain: source commit and file/field, value and SI unit, coordinate frame,
robot variant, measured/fitted/default status, any rescaling rule and a comparison test. Moment of inertia is
not just mass times an arbitrary visual scale: changing dimensions needs an explicit physical model.
For every copied file, retain path, SHA-256, copyright, SPDX licence, NOTICE and modification summary, and add
the exact asset/code credit to `src/support/open-source.json`. Refuse a candidate whose permission is ambiguous.

## Gaps that remain deliberately open

No specific forklift hydraulic system, pinball mechanism or full-scale helicopter has been calibrated from
manufacturer data here. Chrono/PX4 are formulation references, not substitutes for that data. Wave C/D briefs
must identify and validate their chosen machine/airframe before claiming fidelity. Water/continuum coefficients
remain labelled defaults until calibrated. The report-only gate likewise cannot certify an uninstrumented sim.
These limits do not block an honest game/simulation; they block overstating what it represents.
