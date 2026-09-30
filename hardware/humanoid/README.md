# Humanoid driver contract

**Tested against simulated drivers only. This is not a hardware-ready control system.**

The humanoid sim has an explicit driver panel with three local, Worker-backed choices: ROS 2 reference, G1 arm7 and H1 arm4. There is no endpoint field, physical transport factory, SDK connection, credential or robot address. The ROS implementation encodes rosbridge messages through an injected `BridgeTransport`; the shipped transport exchanges messages with a simulated guardian. A physical bridge and its commissioning are future work.

The panel's reference twin follows measured joints. It is separate from the two practice robots. Driver legs are refused at the browser and guardian, including when a caller supplies an unverified commissioning string. Practice BODY legs, locomotion, presets and sparring remain available. Keel is a reference visualization, not a geometrically accurate G1/H1 digital twin.

## Browser contract

`src/sim/humanoid/drivers.ts` defines `HumanoidDriver`: `connect()`, immutable `profile` and session identity, `read()`, `send()`, mandatory `hold(reason)`, `close()` and `onLost(reason)`. `LiveSession` requires a fresh hold acknowledgement even from an adapter whose connection routine omits one. Missing, invalid, replayed or late acknowledgements refuse rearm. Adapter hold promises have a 50 ms deadline. Late resolution cannot restore permission.

Profiles specify named joints, wire names, motor indices, sign/zero transforms, radian envelopes, speed/acceleration caps, measured feedback, named chains and driver-specific hold strategy. Exact profile identity includes mapping, geometry and envelopes; matching a label is insufficient. Unknown measured joints stay unknown; a display may retain its last pose but that cannot satisfy the checklist. Unsupported axes in the vendor fakes are fixed reference geometry, not inferred feedback.

Observe is the only initial/reconnect state. Go-live requires:

1. Verified profile/map and fresh measured feedback for every mapped joint, including passive legs.
2. Guardian health, robot watchdog, exclusive writer and controller status, stable for 200 ms.
3. Acknowledged driver hold and measured twin alignment within 0.03 rad; clear collision envelopes.
4. Fresh tracked input, explicit workspace/emergency-stop confirmation and a newly held local deadman.

The operator holds the on-screen control, Shift, or a physical gamepad's right trigger, then selects Go live. These are held controls, never pose gestures or toggles. Input ownership cannot silently transfer between them. Stop immediately suppresses goals, clears confirmations and calls the driver's hold/damp. Release, a new press, renewed confirmations and Go live are required after every stop. Blur, hide, page release, panel close/minimise, pointer cancellation, lost capture, gamepad release/loss, stale input or changed source also hold. The practice scene's Stop holds the driver too; practice Resume never rearms it.

Jog and local BODY supply upper-body targets through the same caps. The local camera uses its known capture-clock origin; packet receipt does not refresh capture age. BODY loss, an unobserved required joint, generation/mirror/seat change or calibration interruption holds. Phone BODY remains a practice input: a commissioned capture-clock synchronization contract is needed before accepting it in this driver lane. Presets and contact scoring never become driver commands. No camera frames or landmarks are persisted by the driver lane.

## ROS 2 / rosbridge mapping

The adapter uses [`advertise`, `subscribe`, `publish` and `call_service`](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md). Publishers explicitly request volatile, reliable, keep-last/depth-one QoS; queued goals must never be latched for a new subscriber. Names below are protocol topics/services, not robot endpoints.

| Name | Type / direction | Required payload |
|---|---|---|
| `/obpal/humanoid/open` | Service, browser → guardian | `session`, exact `profile_key`, `sent`; returns same identity, simultaneous monotonic `clock` and `ros_clock`, in milliseconds |
| `/obpal/humanoid/lease` | `obpal_msgs/msg/DeadmanLease` | `kind: arm` or `lease`, identity/token/sequence/deadline fields below |
| `/obpal/humanoid/goal` | `obpal_msgs/msg/GuardedTrajectory` | Same envelope, `kind: goal`, plus standard `trajectory_msgs/msg/JointTrajectory` payload |
| `/joint_states` | `sensor_msgs/msg/JointState`, guardian → browser | Names, positions in radians, acquisition `header.stamp`; each batch shares a measurement time |
| `/obpal/humanoid/status` | `obpal_msgs/msg/GuardianStatus` | `session`, `profile_key`, increasing `seq`, monotonic `at`/`stable_since`, `mode`, `guardian`, `robot_watchdog`, `exclusive`, `fault`, `held` |
| `/obpal/humanoid/hold` | Service, browser → guardian | `session`, reason, `requested_at`; ACK contains same session, new `id`, monotonic `at`, configured `strategy`, `held: true` |

The custom message/service types are a bridge specification, not an installed ROS package. The fake uses their rosbridge JSON representation. Topic submission alone is not controller execution acknowledgement.

Every command carries `session`, increasing `seq`, `profile_key`, the latest acknowledged `hold_id`, monotonic `issued_at`, `deadline`, and `lease_until`. The guardian validates strict types, time bounds, ordering, exclusive ownership and feedback independently. Each hold rotates the token, cancels queued goals and latches motion off; old traffic cannot restart it. Repeated hello is allowed only for the same session, without resetting controller stability. A second writer is refused.

Hello bounds clock uncertainty to half the round trip, at most 10 ms. At most three observe-only probes are allowed; all motion deadlines subtract uncertainty. ROS acquisition stamps are mapped through the simultaneous ROS/monotonic sample and then conservatively into the browser clock. Repeated stamps never refresh a joint; future or regressed/paused ROS clocks fault or age out. A physical guardian must independently detect ROS clock discontinuity and require a new session; receipt time is never substituted for acquisition time.

Send complete upper-body joint names at 30 Hz, with one point 100 ms ahead, ordered positions and velocities. A physical guardian must attach its ROS header time and forward only to a dedicated upper-body controller. The [ROS 2 trajectory controller](https://control.ros.org/jazzy/doc/ros2_controllers/joint_trajectory_controller/doc/userdoc.html) expects every configured joint unless partial goals are explicitly enabled; its topic interface does not supply an action result. Read controller state as well as measured joints. Monitor tracking error and stop before accepting a competing controller. Never send a whole-body command to bypass the leg refusal.

## Independent guardian and timing

| Constraint | Implemented test envelope |
|---|---|
| Joint measurement age / guardian status age | ≤100 ms |
| Local capture age | ≤150 ms |
| Lease renewal / maximum lease | 20 ms / 100 ms |
| Fake guardian polling | 5 ms; design requires ≤10 ms |
| Hold issuance target after last renewal/feed | ≤110 ms |
| Hold / arm acknowledgement deadline | 50 ms |
| Maximum speed / acceleration | 0.5 rad/s / 1 rad/s², or lower profile cap |
| Tracking error cutoff | 0.15 rad |

The browser uses bounded integration and braking distance to joint limits. The guardian independently checks finite positions/velocities, position deltas, acceleration-consistent deltas and profile caps. Named-chain capsules cover limbs, torso and head with an 8 mm margin; five samples check each short capped path. Both sides refuse approaching envelopes. The fake rest pose abducts the arms by 0.25 rad to clear the conservative thigh capsules. These approximate reference capsules are not commissioned shell, hand, payload or environment collision geometry.

In production the guardian must be a separate local process, with sole control ownership, authenticated transport, origin/access checks, bounded queues and a monotonic scheduler. It must issue the controller's verified hold/damp on lease expiration, socket loss, invalid feedback or unsafe goals. A separate robot/controller watchdog must hold if the guardian itself dies. An emergency stop remains independently reachable; software hold is not an emergency-stop substitute. Stopping-distance, balance, actuator gravity behavior, damping gains and physical clearances require supervised commissioning before any physical connection.

The fake guardian runs in a dedicated Worker, so a blocked page cannot renew its lease. Its bridge-death test models the robot watchdog as a separate branch of that Worker. Its plant follows accepted trajectory points without modeling inertia, controller interpolation or actuator dynamics. It proves the state machine, not independent physical processes or a hard real-time scheduler. Browser/OS suspension can exceed a timing target; retained raw measurements must not be described as a hardware guarantee.

Freshness comparisons use the timestamp of the sample being checked, never an
earlier callback-entry time. Expiry is checked before feedback work and again
after command validation, before accepting motion or renewal. Crossing a deadline
during validation holds; it cannot extend the old lease. Expiration revokes the
rearm token just like an explicit hold.

The 110 ms issuance target assumes an eligible guardian check is scheduled within
10 ms of expiry. Under arbitrary browser/OS starvation **there is no finite
in-browser wall-clock bound**. The achievable semantic guarantee is hold on the
first runnable check of an expired lease, with no subsequent motion accepted and
a fresh deadman/rearm required. Tests retain the 100 ms lease, 50 ms acknowledgement
and on-time 110 ms assertions; they also measure scheduling lateness separately.
Aligned Worker/page traces prove the Worker issued the hold while the page was
still blocked, rather than accepting a later page Stop as watchdog evidence.
This does not replace the independently scheduled, commissioned robot-side
watchdog required for real hardware.

## Unitree bridge specification

The future local C++ bridge owns `unitree_sdk2`, DDS, CRC/mode requirements, takeover and servo cadence. It interpolates already-capped upper-body trajectories at the commissioned controller rate, reads measured `q`, and reports acquisition age and status through the same guardian contract. It must preserve the vendor locomotion controller and never publish whole-body low-level commands. Test sign/zero offsets, limits and hold strategy are deliberately not vendor calibration.

The official [G1 arm7 example](https://github.com/unitreerobotics/unitree_sdk2/blob/main/example/g1/high_level/g1_arm7_sdk_dds_example.cpp) uses `rt/arm_sdk`, `rt/lowstate` and `unitree_hg` command/state types. The fake maps legs 0–11, waist yaw/roll/pitch 12–14, left shoulder pitch/roll/yaw, elbow and wrist roll/pitch/yaw 15–21, and right arm 22–28. Index 29 is takeover weight in that example, not a joint. Its test caps are 0.35 rad/s and 0.7 rad/s²; stop is measured-position hold.

The [H1 arm example](https://github.com/unitreerobotics/unitree_sdk2/blob/main/example/h1/high_level/h1_arm_sdk_dds_example.cpp) uses the same topic names with a different mapping and command type. Its shown command is `unitree_go::msg::dds_::LowCmd_`, state `unitree_hg::msg::dds_::LowState_`. The fake maps right hip roll/pitch/knee 0–2, left 3–5, torso yaw 6, left/right hip yaw 7/8, left/right ankle 10/11, right shoulder pitch/roll/yaw/elbow 12–15 and left 16–19. Index 9 is takeover weight, not a joint. No wrists or head are commanded. Test caps are 0.3 rad/s and 0.6 rad/s²; its own stop strategy is controlled damping, modeled as a held plant.

Pin the exact robot variant, firmware and SDK revision before commissioning; neither example describes every G1/H1 variant. Do not reuse maps or assume safe torque-off behavior. Legs require separately verified controller capability and commissioning evidence; this release contains no verification authority and therefore always refuses them. Future approval must include supervised support/balance tests, physical limits, stop distances and independent watchdog evidence. A supplied string or browser setting cannot unlock legs.

All fake/guardian code here is authored for this repository. No SDK is vendored or distributed. Any later SDK distribution must retain its [BSD-3-Clause notice](https://github.com/unitreerobotics/unitree_sdk2/blob/main/LICENSE).

## Proof and limits

`tests/humanoid-live.test.ts` exercises the fault matrix: per-joint freshness, unknown/NaN/out-of-limit state, profile/mapping mismatch, controller/watchdog/ownership faults, malformed/replayed/deadline-invalid traffic, caps, self-collision, missing/late hold ACK, source loss/change, deadman release and fresh rearm. The guardian is tested independently from the page gate.

`scripts/e2e-humanoid-live.mjs`, included in the sims suite, uses the actual UI and Worker protocol for all three adapters. It blocks the main thread, kills simulated transports/bridge feeds, measures hold issuance, checks zero goals after Stop, touches the phone deadman and proves driver leg refusal does not inhibit practice BODY legs. Evidence is written to a temporary folder, then copied to `artifacts/humanoid/phase-4/` for review. The histogram reports issuance delay, not joint deceleration or physical stopping time. Real robots, external ROS processes, physical phones and networked control remain unverified.
