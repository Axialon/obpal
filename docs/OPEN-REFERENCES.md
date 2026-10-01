# Open references: useful facts, explicit file licences

Original F0 research checked on 2026-09-30 using the primary project pages and file-level licence headers below. These are
reference candidates, not vendored or version-pinned dependencies. **No external asset, code file, robot
parameter file or new dependency was imported by F0.** That historical F0 return added no new dependency credit. F0-R adds the engine credits below for the already-pinned
comparison packages, but no external robot assets or parameter files. Future reuse must pin a commit/content hash and retain all required
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
| R1 / foundation | [Rapier TypeScript source](https://github.com/dimforge/rapier/tree/master/typescript), [Rapier repository licence](https://github.com/dimforge/rapier/blob/master/LICENSE): Apache-2.0. [Official determinism guide](https://rapier.rs/docs/user_guides/javascript/determinism/). | Rigid bodies, joints, contacts and JS/WASM integration; exact capabilities depend on the pinned build. | F0-R provisional selection is the already-pinned compat 0.21.0 package; real adapter and automated three-way fixture comparison are supplied. Astra did not execute its WASM. Promote only the measured selected engine; see PHYSICS-BACKENDS. |
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


## F0-R NVIDIA additions (checked 2026-10-01)

These entries distinguish upstream software from asset and dependency licences. No Isaac, Newton, ROS or robot
model file is included in this packet. `src/support/open-source.json` credits the already-pinned physics packages
used by the adapters/bench, not hypothetical asset imports. The following are research sources, not pinned
reproducible asset downloads; any later import must carry its own exact bytes, hash and notices.

| ID | Primary source / exact licence | Use and boundary |
| --- | --- | --- |
| R15 / Isaac Sim | [Isaac Sim LICENSE](https://github.com/isaac-sim/IsaacSim/blob/main/LICENSE): Apache-2.0 for the open-source project. [Robot asset catalogue](https://docs.isaacsim.omniverse.nvidia.com/6.0.0/assets/usd_assets_robots.html) lists separate asset licences. | Reference articulation/ROS 2 workflows for N2. Project licensing does not relicense bundled dependencies, linked CAD or asset collections. Not run here. |
| R16 / Isaac Lab | [Release 3.0.0 licence](https://isaac-sim.github.io/IsaacLab/release/3.0.0/source/refs/license.html): most framework packages BSD-3-Clause; `isaaclab_mimic` and related scripts Apache-2.0, with per-file SPDX headers. | Reference training/control/scene separation, not imported policies or assets. Isaac Sim and dependency/asset notices remain separate. Not run here. |
| R17 / PhysX + binding | [PhysX LICENSE.md](https://github.com/NVIDIA-Omniverse/PhysX/blob/main/LICENSE.md): BSD-3-Clause. [physx-js-webidl](https://github.com/fabmax/physx-js-webidl) and its [2.8.0 package declaration](https://github.com/fabmax/physx-js-webidl/blob/main/dist/package.json): MIT binding. | Real lazy browser comparator using native reduced-coordinate articulations. Binding 2.8.0 package prose names PhysX 5.11.0, not the brief's older 5.3.x; print actual runtime `PHYSICS_VERSION`. Existing dependency remains development-only unless the measured selection promotes it. Browser execution is pending. |
| R18 / Newton | [Newton repository README/licensing](https://github.com/newton-physics/newton/blob/main/README.md): software Apache-2.0; documentation CC-BY-4.0. A Linux Foundation project initiated by Disney Research, Google DeepMind and NVIDIA. [1.3.0 requirements](https://newton-physics.github.io/newton/1.3.0/guide/installation.html). | N1 off-browser reference trajectories. Python/Warp implementation is not a browser or phone runtime for ob.Pal. CPU execution exists, but the proposed N1 GPU reference workload uses a suitable NVIDIA GPU; do not misstate GPU support as the only possible Newton execution. Not installed or run here. |
| R19 / asset catalogue | [Isaac Sim 6.0 robot catalogue](https://docs.isaacsim.omniverse.nvidia.com/6.0.0/assets/usd_assets_robots.html), per-asset licence cells; selected entries immediately below. | Read joint frames, mass/inertia and gear/limit metadata only with exact variant/units/provenance. Do not attribute a dataset parameter to measured hardware without its source saying so. No meshes or parameters copied in F0-R. |

### Exact asset references, not a blanket asset permission

Paths are relative to the catalogue's robot root. Each licence below belongs to that named catalogue entry,
not every asset from its manufacturer. A later import must recheck the actual file's notices and dependencies.

| Cited asset path | Catalogue licence | Possible later use; current status |
| --- | --- | --- |
| `Turtlebot/Turtlebot3/turtlebot3_burger.usd` | Apache-2.0 | N2 simulated base/joint layout; reference only. |
| `iRobot/Create3/create_3.usd` | BSD-3-Clause | Mobile-robot wheel frames/drive comparison; reference only. |
| `NVIDIA/Robomaker/aws_robomaker_jetbot.usd` | MIT | Compact differential-drive reference; reference only. |
| `FrankaRobotics/FrankaPanda/franka.usd` | Apache-2.0 | N1/N2 arm settling and named-joint/frame reference; reference only. |

No USD, texture, mesh or robot numeric table is shipped by F0-R, so these assets are deliberately not credited as
used files in the application. Restricted, unlicensed or uncleared dependencies remain reference-only even when
a catalogue neighbour has a permissive licence. The current physics fixtures use original, explicitly labelled
simulation defaults. See the N1/N2 briefs for future provenance manifests and gate evidence.
