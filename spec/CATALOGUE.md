# ob.Pal control catalogue (v1)

Every controller surface is built from **utilities** in one catalogue. Every host maps utilities to **outputs** through **profiles**. Several devices can share one scene, each controlling its own node (§5). Other controllers join through a phone or PC as **bridges** (§6), and what a scene controls, down to real machines, is a **control system** (§7). On the device, the catalogue becomes a picker: a person uses any controller the host takes, on one device or several (§9, planned). A new kind of control (a wheel, a keyboard page, a pedal) becomes a new catalogue entry with:
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
| `bridge.watch` | A watch: Wear OS and Galaxy Watch; an Apple Watch only beside a native iPhone app | A native watch app, joined as a device of its own or linked to the phone's page over Bluetooth (Chrome on Android) | Wrist motion, taps, the crown or bezel | The Motion utilities and buttons, as a second device of its person (§9.5) | Research first ([RESEARCH-DEVICES.md](RESEARCH-DEVICES.md)) |

The controllers themselves are described with the standards' ids rather than new ones: the Gamepad API's standard mapping for pads, and the WebXR Input Profiles registry's ids for headset controllers ([RESEARCH-DEVICES.md](RESEARCH-DEVICES.md), "Controller profiles").

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

## 9. The catalogue on the device

**Status: the contract is built; the rest is design.**
- **Built:** the controller ids (§9.1), `layout.controllers` (§9.2) and `mode{m, c?, p?}` (§9.4), in `@obpal/core` (`CONTROLLERS`, `withControllers`, `layoutControllers`, `readMode`) and `@obpal/host`, and in PROTOCOL §3. The phone names its controller and profile in `mode`, and opens the first controller the host suggests. The embed (`<obpal-remote modes="face.wii face.trackpad">`) names controllers by these ids, so its attribute stays put when the picker lands.
- **Design, not built:** the picker (§9.3), several devices per person (§9.5), and profiles beyond the built-ins (§9.6).

Today the phone shows four fixed tabs: Rotate, Point, 3D and Gamepad. The host's `layout.modes` decides which of them appear. The catalogue's routes and profiles (§2–3) reach only the Gamepad tab's motion chips. This section makes the catalogue itself what a person picks from while connected: any controller the host takes, tuned by a profile, on one device or several. PLAN §10 places the work (step 5b).

**Words:**
- **Controller:** what a person uses, as the picker shows it. It is either a **face** drawn on the device's screen (the gamepad, the Wii remote, the mouse, the trackpad), or a physical controller bridged through the device (§6). Each is built from utilities (§1).
- **Seat:** one more participant on a device's own connection, for a bridged controller (§6).
- **Person:** the devices and seats one human uses in a scene, shown and managed together.

### 9.1 Controllers

The first faces are today's tabs and tray controls, so nothing is lost. New ones are rows here, never new tabs: the music room's drum pads and tone keys arrive as `face.drums` and `face.keys`. Adding one follows §8.

The rows are data in `@obpal/core` (`Controller` and `CONTROLLERS`: each one's name, category, utilities and modes) and in [/catalogue.json](https://obpal.blackboxes.net/catalogue.json) (`controllers`). An id is a kind, a dot and a name (`CONTROLLER_ID`).

| id | Controller | Built from | Sends (mode · wire) | Today |
|---|---|---|---|---|
| `face.gamepad` | Gamepad | `pad`, with `motion.aim`, `motion.steer` and `motion.point` as chips | gamepad · PAD, POINTER | The Gamepad tab |
| `face.trackpad` | Trackpad | `touch.trackpad`, with the gyro as 1:1 (`motion.hold`) or Tilt (`motion.tilt`) | hold or tilt · STATE | The Rotate tab |
| `face.wii` | Wii remote | `motion.point`: A, B, − ⌂ + | point · POINTER, `btn` | The Point tab (`point: 'wii'`) |
| `face.mouse` | Air mouse | `motion.point`: Left, Right and the wheel | point · POINTER, `btn`, `value` | The Point tab on a PC (`point: 'mouse'`) |
| `face.hand` | 3D hand | `motion.track` | track · POSE | The 3D tab |
| `face.keyboard` | Keyboard | Typing and a key row | `text`, `btn{key-…}` | The tray's Keyboard |
| `face.wheel` | Steering wheel (new) | `pad`, with Steer on `stick.wheel` and the triggers as pedals | gamepad · PAD | Gamepad with the Driving profile |
| `bridge.*` | A physical controller | §6 | As its bridge | Planned (§6) |

### 9.2 What a host takes

**A controller works on a host when everything it sends, after its profile's routes (§2), is something the host takes.** A steering wheel works in any gamepad game, because its tilt is routed into the pad's left stick. The air mouse needs a host that takes `motion.point`.
- **Takes:** `layout.utilities` lists the utilities the host takes; absent means all of them, as today. Today only the Gamepad's chips read it, and no host sends it. With the picker, every host should.
- **Suggests:** `layout.controllers` lists the controllers the host suggests, in order, and the first opens by default (the phone opens it once, on the first `welcome`; after that the person's choice stands).
  - A host that sends only `modes` (every host before controllers) gets the faces whose modes it lists (`layoutControllers`): Rotate is `face.trackpad`, Point `face.wii` (or `face.mouse` with `point: 'mouse'`), 3D `face.hand`, Gamepad `face.gamepad`, and a keyboard in the tray `face.keyboard`.
  - The SDK fills in the fields older phones read (`withControllers`, which `Remote` applies to every layout it sends): absent `modes` become the controllers' modes, in order; `face.mouse` ahead of `face.wii` sets `point: 'mouse'`; `face.keyboard` adds a keyboard control to the tray; `face.wheel` ahead of `face.gamepad` suggests the Driving profile. Whatever the layout sets itself is kept.
  - Unknown ids are skipped, so a host may already name controllers a later phone will have.
- **The device:** its own abilities count too. Without motion sensors or permission, the motion chips, the Wii remote and the 3D hand wait for motion. The 3D hand's camera ways stay settings, as today.

In the picker, each controller is in one of four states:

| State | Shown |
|---|---|
| Suggested | First, lit, with the host's dot |
| Ready | Lit |
| Needs motion | Lit, with "Tap to allow motion" (the Start gate) |
| Not on this screen | Dimmed, and it can't be picked. A long press says why ("This screen takes a gamepad only"). |

Planned catalogue entries don't show on a device; the /catalogue/ page lists them.

### 9.3 The picker

- **The bar.** The mode tabs become a bar of up to four controllers: the host's suggestions first, then the ones this person uses most with this host. The last slot is **More** (a grid), which opens the picker. On a host that suggests one controller, the bar holds that controller and More.
- **The picker** is a glass sheet like the tray's pickers. Controller cards sit in a grid, grouped by the catalogue's categories: Controller, Pointer, Touch, 3D, Keys, and Music once it exists. A card is a large glyph and a name. The line on what it's for shows on a long press, or as the tooltip on a computer.
- **Connected** (§9.5): controllers bridged through this device sit in a row at the top, each with Use and Stop.
- **Profiles** (§9.6): a row of chips under the grid, for the chosen controller.
- **Pin:** a long press on a card offers "Keep in the bar".
- **Hint:** the first time, a hint points at More. Closing it hides it for the session, like the other hints.
- **Access:** the cards are a radiogroup of buttons, the bar stays a tablist, and reduced motion is respected.

### 9.4 Switching live

- Picking a controller switches at once, with no reconnect.
- The device first lets go of everything the old controller held: buttons up, sticks centred, the clutch released, in one neutral packet. Then it sends `mode{m}` as today, with two new optional fields: `c`, the controller's id, and `p`, the profile's. Hosts that don't know them ignore them (PROTOCOL §3).
  - Built: the phone sends `c` with every `mode`, and `p` while on the gamepad (again whenever its profile changes). Until the picker, the gamepad with the Driving profile says `face.wheel`.
  - `@obpal/host` reads them into `Participant.controller` and `Participant.profile` (`readMode`). A device that doesn't say is taken to use the controller its mode stands for (`controllerOf`), so hosts see a controller for every phone, old or new.
  - Ids are checked for shape only (a kind, a dot and a name; a profile id as in §3), so a newer device can name a controller or a community profile the host doesn't know.
- A claim (§5) survives a switch: the node follows whatever the participant uses next. For a system that moves real things (§7), letting go is the deadman, so the node stops until the new controller takes hold.
- The host may answer with a new layout: another suggestion, or `utilities` that rule the controller out. The device then moves to the first controller it can use, and a toast says why.
- The device remembers the last controller per host, the way it remembers profiles (§3).

### 9.5 Several devices per person

Today (§5) each device is a participant of its own, with its own colour, up to 8 in a scene. A second device from the same person is someone else.

Planned:
- **Person.** One or more participants that belong together: devices (a phone and a tablet, later a watch) and seats. They share a name and a colour, and each extra device or seat gets a numbered shade of it. The host shows them together and can remove one or all.
- **Use a pad here.** The phone's browser sees controllers connected over Bluetooth or USB through the Gamepad API (Xbox, DualSense, Switch Pro, Joy-Con pairs, 8BitDo). The simplest use makes one the phone's own gamepad: its buttons and sticks go out in the phone's PAD packets, and the phone's gyro can still aim. It needs no seat and nothing new on the wire.
- **Add a pad as a player.** Or the pad becomes a participant of its own, as a seat on the phone's connection: `seat{op: 'open', seat, name, kind: 'bridge.gamepad', profile}` (PROTOCOL §8), with the seat index in its packets.
  - The host sees one more participant ("Alex · Xbox pad") that claims its own node. So one person can drive two things at once, while one node per participant stays the rule.
  - A seat can be named for someone else, for couch play on one phone.
  - Stop closes it.
- **Add a device.** The person's first device shows a QR code and a link: the scene's invite plus a short-lived token the host minted for this person, handed over inside the DTLS channel. The second device joins as usual and presents the token in `hello`, and the host groups it with the person. A device that can't scan (a watch) uses the short code instead (PLAN §4), approved on the person's phone.
- **On the phone.** The header gains a small stack of dots: this device and the person's other devices and seats, each in its colour with its controller's glyph. Tapping it opens **Controllers**:
  - This phone: its controller, and the picker.
  - Connected: bridged pads, with Use here, Add as a player and Stop.
  - Your other devices: their controller and link, and Remove.
  - Add a device.
  - People here: everyone in the scene and what they hold. Today the scene list only counts them.
- **On the host.** The People panel (the Viewer, the sims) groups its rows by person: the person first, then each device and seat with its controller's glyph and what it holds. Remove works per row and per person. Approval (§7) stays per participant, so a seat added to a robot arm scene waits for approval like a new device.
- **Limits.** Seats count toward the scene's participants (8 today). A device opens at most 4 seats.
- **ob.Pal Link.** `system.gamepad-slots` (§7) uses the same seats: each phone or seat claims one of Players 1–4, and the game sees up to four pads.

### 9.6 Profiles, on the device and on the host

- **On the device (§3).** The profile chips list, for the chosen controller:
  - the host's suggestion, marked;
  - the built-ins;
  - the host's own profiles (`layout.profiles`, planned), for a host tuned to one site or program;
  - community profiles from /catalogue.json, kept for offline use;
  - **Mine**, the person's own.

  Today the device knows only the five built-ins, and it ignores a suggestion it doesn't know. Planned, it takes any profile that passes `checkProfile()`.
- **Mine.** The /catalogue/ builder gains **Use on my phone**.
  - On a phone, it saves to the phone's own profiles. The controller page shares them, because both pages are on obpal.blackboxes.net.
  - On a computer, it shows a QR code that carries the profile to the phone in the URL fragment, so the profile never reaches a server.
  - Changes made on the phone (a long press on a chip) are saved per profile, as today.
- **Wider profiles.** Today a profile tunes the Gamepad's three motion utilities. Profiles will name the controller they tune (`controller: 'face.wii'`) and grow with it: the Wii remote's gain and edge turn, the trackpad's speed, button remaps. `checkProfile()` and /profile.schema.json stay the one check.
- **On the host: mappings.** What a control finally does belongs to the host (§3). Some hosts already carry that as data: ob.Pal Link's Keys and whole-PC tables (`DEFAULT_KEYS` and `DESKTOP_KEYS` in `extension/src/shared/keys.ts`), and its per-site suggestions (`sites.ts`).
  - Planned, mappings become catalogue entries too, as `catalogue/mappings/<id>.json`, checked at build like profiles. A mapping says what each catalogue control does for one site or program: a key, the mouse, a gamepad button.
  - A host offers its mappings as an ordinary `select` in the tray, so switching one needs no new wire.
  - People share mappings the way Steam Input configurations are shared ([RESEARCH-DEVICES.md](RESEARCH-DEVICES.md)).

### 9.7 On the wire

All of it is optional, and a host that ignores it keeps today's behaviour.
- Layout: `controllers?: string[]` (built) and `profiles?: ProfileSpec[]` (planned).
- `mode{m, c?, p?}` (built).

Planned:
- `welcome{…, person?: {id, token}}`, and `hello{…, with?: token}`, for Add a device.
- `seat{op, seat, name, kind, profile?}`, and a seat index in the PAD, POINTER, STATE and POSE packets. PAD has two reserved bytes.
- In `scene.people`: `person?` (who a participant belongs with) and `controller?` (what it uses now).
- In `Caps`: `form?` (phone, tablet, watch, headset or computer), for the People views and the picker.
