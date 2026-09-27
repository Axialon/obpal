# ob.Pal control catalogue (v1)

Every controller surface is built from **utilities** in one catalogue. Every host maps utilities to **outputs** through **profiles**. Several devices can share one scene, each controlling its own node (§5). Other controllers join through a phone or PC as **bridges** (§6), and what a scene controls, down to real machines, is a **control system** (§7). A new kind of control (a wheel, a keyboard page, a pedal) becomes a new catalogue entry with:
- a stable id;
- a category;
- a wire encoding;
- host semantics.

It does not become a one-off mode. The wire formats are in [PROTOCOL.md](PROTOCOL.md).

## 1. Utilities

| id | Category | On the phone | Wire |
|---|---|---|---|
| `pad` | Controller | Standard gamepad face: sticks, D-pad, A/B/X/Y, bumpers, analog triggers, View / Menu / Guide | PAD 0x12 |
| `motion.aim` | Motion | Gyro **turn rate** drives a look output. Moving the phone turns; holding it still stops. | Mixed into PAD axes, or a relative POINTER 0x14 (the `mouse` route) |
| `motion.steer` | Motion | Tilt **angle** drives a stick. The tilt is held while the phone is held tilted. | Mixed into PAD axes |
| `motion.point` | Pointer | Wii-style absolute pointing (PROTOCOL §4, Point mode): the cursor is where the phone points | POINTER 0x14 |
| `motion.track` | 3D | 6-DOF: the phone's position and orientation in space (mode 6). By default from the phone's own sensors, Wii-style (no camera): the gyro's orientation through an arm model gives where the hand is, and the accelerometer adds pushes and pulls along where the phone points (`src/controller/imu3d.ts`). In settings, the camera instead (Android WebXR), or a glow for the host's camera. Hosts move what's held as the hand moves. In the Viewer, a held part moves and turns with the phone, a live value drags, and the lead with nothing held moves the scene. `handMove`, `handTurn` and `headingOf` in `@obpal/host` put a pose in the hand's terms | POSE 0x15 |
| `touch.trackpad` | Touch | One-finger drag, two-finger pan, pinch, twist | STATE 0x11 |
| `motion.hold` | 3D | 1:1 orientation while held | STATE 0x11 (qRel) |
| `motion.tilt` | 3D | Racing-style tilt stick | STATE 0x11 (tilt) |

**Categories** order the phone's UI. Controller comes first, then Motion, then Pointer, Touch and 3D. A host declares which utilities it accepts in its layout (`utilities: string[]`; absent means all). The phone offers only those.

**Device buttons.** A device may also drive its current mode with hardware buttons, wherever its browser allows. Each button fires a *primary* action (A, or switching the gyro in Rotate), a *secondary* one (B held in Point and Gamepad, or recentre in Rotate), or *next* and *previous*:
- volume keys, when the browser passes them to the page (some Android browsers; never iOS);
- keys from a Bluetooth keyboard, remote or clicker: Enter or Space, Escape, the arrows, and Page Up and Down;
- headset and earbud buttons through Media Session. This is opt-in, because it plays a silent track that takes the audio focus.

These buttons need no new wire format: they press what the device's own controls press.

**Rotation lock.** While a device steers with its motion, turning it must not re-lay out or remap its controls. Turning the gyro on locks the screen's rotation, and a lock button unlocks it. Where there's a native lock (Android, in fullscreen), the device uses it. Elsewhere the page counter-rotates itself, reads touches in its own frame, and reports the locked orientation in STATE.

## 2. Routes: where a motion utility goes

| Route | Meaning |
|---|---|
| `stick.left` / `stick.right` | Mixed into that stick, clamped to the unit circle. A thumb on the same stick adds to it. |
| `stick.fly` | Steer only. Tilting left or right is X and tipping forward or back is Y, on the **right** stick: yoke-style flight and look. |
| `stick.wheel` | Steer only. Tilting left or right is the **left** stick's X axis: a steering wheel. |
| `mouse` | Relative mouse movement: the phone integrates the turn and sends it as a *relative* POINTER (PROTOCOL §6); the host turns the angular change into pixels ("gyro mouse"). Used by keyboard-and-mouse games, and by any page with pointer lock. Without pointer lock the host finishes the route on the right stick instead. |
| `pointer` | Point only. An absolute cursor where the phone points. |

**Response parameters** (per utility, per profile):
- `gain`: sensitivity multiplier. Default 1. It multiplies the phone's global sensitivity.
- `deadzone`: the game's own stick deadzone to jump over. The output is `sign(v) · (d + (1 − d) · |v|)` for any non-zero `v`. Default 0.2.
  - The value only has to be close. Most games use 0.1 to 0.25, and Godot projects commonly use 0.2 (CVC Collider's pad profile uses 0.18).
  - Without this, the small, deliberate motions that make gyro aim precise are swallowed.
  - The jump is applied to the **magnitude** of the stick vector, so the direction is exact: a pure yaw stays a pure yaw instead of picking up a jumped pitch. Games with a radial deadzone (Godot's `get_vector`) then read exactly the intended direction.
  - Motion below 1% of full travel (about 1.8°/s of turn) counts as a still phone and is not jumped, so sensor noise never creeps into the game.
  - When several utilities and the thumb feed one stick, they are summed first and jumped once (the largest deadzone asked for); the thumb alone is never jumped.
- `curve`: exponent on `|v|` before the deadzone jump. Above 1 gives finer control near the centre. Default 1.
- `invertY`: false by default.

**Point response:** `gain` scales the pointing angles (a faster cursor); `invertY` flips pitch; `edgeTurn` asks page hosts for the edge turn (§4). Point has no deadzone or curve.

The maths is `packages/core/src/response.ts`; the phone's routing is `composeSticks` in `src/controller/gamepad.ts`.

**Defaults:**
- Aim is `stick.right` with a deadzone of 0.2.
- Steer is `stick.wheel`.
- Point is `pointer`.

## 3. Profiles

A profile is a named set of utility settings. The **host** owns what each output finally does, and the phone never sends raw key sequences (PLAN §9).

| Profile | For | Settings |
|---|---|---|
| `default` | Most gamepad games | Aim → `stick.right`. Steer → `stick.wheel`. Point → `pointer`. |
| `flight` | Flight and space games (e.g. CVC Collider) | Steer → `stick.fly` (tilt the phone like a yoke). Aim → `stick.right` as fine correction on top. Deadzone 0.2. |
| `driving` | Racing | Steer → `stick.wheel`, with the triggers as throttle and brake. |
| `shooter` | First-person shooters | Aim → `mouse` when the page has pointer lock, otherwise `stick.right`. |
| `pointer` | Menus, point-and-click, Wii-style games | Point on. A clicks at the cursor and holding B drags. |

**Suggestions:**
- A host may suggest a profile for the current site or program: layout `profile: string`. The browser extension takes it from a per-site data table (`extension/src/shared/sites.ts`: tesana.com and play.tesana.ai suggest `flight`).
- The phone applies the suggestion unless the user has chosen a profile for that host.
- The phone remembers choices per host, and per suggestion the host makes (a suggestion stands for a site or program, so a choice made on one site never overrides another site's suggestion). Picking the suggested profile again forgets the choice.
- A profile's `on` utilities switch on when it applies (`pointer` turns Point on); the others keep their state.
- Options a user changes on a chip (route, sensitivity, deadzone jump, invert Y, edge turn) are remembered per profile.

## 4. Host semantics for `motion.point`

Pointing uses a POINTER packet (PROTOCOL §6):
- The host projects it with the Point-mode geometry: `x = cx + tan(yaw) · K`, where `K = (width / 2) / tan(16°)`.
- Buttons come from PAD: A is button 0 and B is button 1.
- PAD flag bit 2 says Point is on; when it clears, the cursor goes at once. The phone recentres (a new generation) when Point is switched on and on its centre button: aim there = the middle of the screen.

**Page hosts (browser extension):**
- They draw a cursor over the controlled page. One frame owns it: a pointer-locked frame, else the frame with the game's canvas, else the top frame.
- A clicks at the cursor: `pointerdown`/`mousedown`, then `up`, then `click`, on the element under it, through frames and open shadow roots. The cursor also hovers (`pointermove` with no buttons) as it moves.
- Holding B presses the left button and drags.
- While A or B acts as a click, it isn't also sent as a gamepad button: the link strips both from the pad every frame sees.
- Outside the Controller target (3D and Keys), pointer changes act as aim deltas, like Point-mode gyro.

**Pointer-locked pages** (the game has captured the mouse):
- The pointer becomes relative mouse movement. The change in yaw and pitch per packet turns into `movementX` and `movementY` pixels.
- No cursor is drawn.

**Edge turn** (optional, profile flag `edgeTurn`):
- Near an edge of the screen, the right stick deflects toward that edge, in proportion to how far into the last 12% the cursor is.
- This is the Wii shooter scheme: the view turns when you point at its edge.

## 5. Shared scenes: participants, nodes and claims

Several devices can control one scene at once. Each joins with the scene's invite and controls the node it claims, and a node has one controller at a time. The messages are in PROTOCOL §3.

- **Participant.** A device joined to the scene, or a controller a device bridges (§6). The host gives each one an id, a name and a colour, and the device's own controls take on that colour.
- **Lead.** The first participant. While it holds nothing, its input drives the shared view (the camera). When it leaves, the next oldest becomes lead.
- **Node.** Something a participant can control: an object or part in a 3D scene, a gamepad slot in a game, a joint of a robot arm. The host lists its nodes in `scene`, each with an id, a name and a kind.
- **Claim.** A participant takes a node by pointing at it and pressing A, or by picking it from the scene list on the device.
  - A node held by someone else can't be claimed. The device gets a bump and a toast naming who holds it.
  - A participant holds one node at a time: claiming another releases the first.
  - A claim ends on release, when the participant leaves, and when the host removes the node or takes it back.
- **What input drives.** A participant's input drives the node it holds: 1:1 turns it, Tilt and Gyro turn it, and the trackpad moves it. Holding nothing, the lead's input drives the view and the whole scene, and everyone else's only moves their cursor. Letting go (× on the device) hands 1:1 back to the whole scene.
- **Showing a change of control.** When a node is taken, handed over or let go, the screen's halo flashes and a released halo lingers as it fades. The device's control area flashes in its colour, and its held-part chip fades out instead of vanishing.
- **Invite.** The pairing QR or link. Anyone with it can join, up to 8 devices, until the host makes a new link. That stops the old one without dropping anyone connected. The host sees everyone in the scene and can remove a participant.
- **The screen.** The person at the host is a participant too (id `host`). The mouse claims nodes the same way, and can take a node back from anyone.
- Hosts that don't list nodes keep the one-device behaviour: a new device takes over.

Systems that move real things (§7) also require the host to approve each participant before its first claim, and add their own safety envelope.

## 6. Bridges: other controllers through a phone or PC

A bridge forwards a controller connected to a phone, PC or headset into the scene as a participant of its own. So a Switch Pro Controller, a DualSense or a VR controller claims its own node beside the phone that bridges it.
- The bridging device runs the controller page.
- The host sees one more participant, named after both (for example "Alex · Pro Controller").
- A bridge reuses the utilities and wire formats above: it is a new source of input, not a new kind of control.
- Wire (planned): a `seat` message opens a sub-participant on the bridging device's connection, and that sub-participant's packets carry its seat index.

| id | Controller | Runs on | Reads | Becomes | Status |
|---|---|---|---|---|---|
| `bridge.gamepad` | Any Gamepad API controller: Xbox, DualSense, Switch Pro, Joy-Con pairs, 8BitDo | Phone or PC browser (Bluetooth or USB) | Gamepad API, standard mapping | `pad` | Planned |
| `bridge.joycon` | Joy-Con and Switch Pro, with motion | Chromium on a PC (WebHID) | HID reports: buttons, sticks, 6-axis IMU | `pad`, plus Aim and Steer from its gyro | Planned |
| `bridge.wiimote` | Wii Remote and Nunchuk | Chromium on a PC (WebHID) | HID reports: buttons, IR camera, accelerometer | `pad`, plus absolute Point from the IR camera | Planned |
| `bridge.xr` | VR controllers and tracked hands (Quest, Vision Pro, Pico) | The headset's browser (WebXR) | Each hand's 6DoF pose, trigger, grip, stick, buttons | `motion.hold` (1:1 pose) and `pad`, one participant per hand | Planned |

## 7. Control systems: what a scene controls

A control system is a kind of host. It decides what its nodes are, which utilities drive each one, and what is safe.

| id | Host | Nodes | Takes | Status |
|---|---|---|---|---|
| `system.scene3d` | ob.Pal Viewer | Each object, its movable parts, and the view (the lead's) | Point, Hold, Steer and Tilt, the trackpad, the gamepad | Shared scenes shipped |
| `system.gamepad-slots` | ob.Pal Link in a browser game | Player 1–4 gamepad slots | `pad` and the Motion utilities | Public sim at [/sim/arena/](https://obpal.blackboxes.net/sim/arena/). In ob.Pal Link: planned. Each participant claims a slot, so a local-multiplayer game gets one pad per phone. |
| `system.desktop` | ob.Pal Desktop | The allowed program in front (keyboard, mouse) | The Keys and mouse routes | Shipped, one participant |
| `system.robot-arm` | A bridge beside the arm's control software | Each arm whole (the tool follows the phone), its joints and its gripper; several arms per scene | Hold (gyro on) → the tool follows the phone. Drag, tilt, the sticks → tool or joint velocity. The triggers, a tap or Grip → the gripper. | [/sim/arm/](https://obpal.blackboxes.net/sim/arm/): one to four arms with the whole safety envelope. Each drives a real arm when the screen connects one: Feetech bus servos (SO-100, SO-101) or the ob.Pal serial sketch over Web Serial, or ROS 2 through rosbridge. Not yet tried on hardware. |

**`system.robot-arm`.** The host is a small bridge next to the arm's own control software. It is a web page using `@obpal/host` or ob.Pal Desktop, and it speaks the arm's interface:
- ROS 2 (through rosbridge, or `ros2_control` topics);
- a vendor SDK (UR RTDE, xArm, Dobot);
- a serial servo controller;
- MQTT or OSC.

Nodes map to the arm: one participant can steer the tool while another works the gripper, but never two on the same joint. The safety envelope is part of the item, not an option:
- **Deadman:** a node moves only while its participant holds the grab control. Letting go stops it.
- **Limits:** joint ranges, velocity and acceleration caps, and a workspace box are enforced in the bridge, never on the phone.
- **Watchdog:** 200 ms without input stops the node, as the desktop helper releases everything when frames stop.
- **E-stop:** every participant's device and the host show a stop control that halts every node at once.
- **Approval:** the host approves each participant before its first claim. Having the link isn't enough.
- **Record:** the bridge logs who held which node, and when.

**The reference bridge** (`src/sim/arm/`) runs this envelope for one to four arms, each a digital twin of a real one.
- **Nodes, by the arm's control profile:** the whole arm, its joints, or both. A joint is inside its arm (`SceneNode.parent`), so while someone holds the whole arm nobody else can take one of its joints, and the reverse.
- **Point and go** (Wii-style, the default; `reach.ts`): each person's pointer lands on the floor as a dot in their colour. Hold B and the gripper goes over the spot, hovering 20 cm up. A picks up or puts down like a claw (down, close or open, back up). Plus and minus change the height by 5 cm, and ⌂ sends the arm home. Aiming straight at the screen is the middle of the floor.
- **Camera** (any phone, `GlowFollower` in `@obpal/host`, also in the Viewer's People panel): where the phone can't track itself (an iPhone), Start 3D makes its screen glow in its seat colour, with a Stop button kept on it. The screen turns on "Follow glowing phones with this camera", and each glow's move in the picture (its size gives the distance) moves the gripper the same way while a thumb is on the glowing screen.
- **3D** (every phone with motion sensors, `motion.track`; no camera): in the 3D tab, hold the pad and move the phone. Its own sensors follow it, Wii-style: swing it and the gripper swings, tip it and the gripper rises and tips, push it toward the screen and the gripper reaches. The camera (Android WebXR) or a glow for the screen's camera can take over in settings. The gripper moves as the hand does (×1.5 in the sim), toward the screen as the screen shows it, and the phone's tip and twist set the gripper's angle and roll. Letting go holds; pressing again carries on from there.
- **The whole arm follows the phone** (1:1; kinematics in `kinematics.ts`): with the gyro on and a thumb on the pad, turning the phone swings the arm, tipping it raises the tool, and twisting it rolls the wrist. Dragging reaches and swings; two fingers raise and tip the tool. Letting go holds the pose; pressing again carries on from there. Past the arm's reach or a joint's limit, the arm holds the last pose it could reach and the phone bumps.
- **Buttons:** Stop, Grip and Home in every phone's tray. The phone's hardware buttons are bound through `Layout.keys`: volume up grips, volume down (or Esc) stops everything, and next sends what you hold home. A gamepad's A grips and B sends the arm home.
- **Deadman:** a finger on the trackpad, or a stick deflected. For a joint, the 1:1 grab held also counts.
- **Limits:** speed and acceleration caps, and joint limits.
- **Watchdog:** 200 ms without input stops the joint.
- **E-stop:** a Stop button on every phone's tray and on the screen (Space). It holds position rather than cutting power, and only the screen resumes. The screen going to the background while an arm is live also stops everything.
- **Approval:** the screen lets each person in before their first claim.
- **Real arms** (`drivers.ts`):
  - **Connect:** the screen connects a driver, and the twin then follows the real arm.
  - **Calibrate:** pose the arm like the twin's home, then set home and flip any reversed joints.
  - **Go live:** only the screen can, after a confirmation and at a speed cap (25% by default). The twin starts from the arm's own pose, so nothing jumps.
  - **Watch:** while live, a real arm that stops reporting, or lags its twin by more than 12° for 0.6 s, stops everything.
  - **Arduino:** `hardware/arduino/obpal-arm` is a reference sketch for hobby servos. It speaks the ob.Pal serial protocol (`J`, `?`, `S`, `T` lines at 115200 baud) and keeps its own limits, speed caps and a 0.5 s hold.

`Claims` in `@obpal/host` gives any control system the same one-per-node rules.

## 8. Adding to the catalogue

A new utility, bridge or control system needs all of the following:
1. A row in §1, §6 or §7 with a stable id and a category.
2. Its wire encoding, reusing PAD, STATE or POINTER fields where possible. A new packet type is the last resort, and hosts ignore unknown types.
3. Its routes and response parameters (§2), or for a control system its nodes and what drives each one.
4. Host semantics, and for anything physical its safety envelope.
5. Its place in the built-in profiles.
6. Tests: a codec round trip, the route maths, and one end-to-end case (`extension/scripts/e2e.mjs`, or the viewer's shared-scene test).
