# Step inside a shared sim

The screen remains the authority. A participant can watch any device without taking its controls. First person and Enter VR sit beside the sim controls; Overview is always available. A shared-scene link opens the same sim on another screen, phone or headset through the existing authenticated WebRTC pairing. A phone can keep driving while its person watches from a headset.

| Where | View and input |
| --- | --- |
| Desktop browser | First person; drag to look, optional pointer lock, snap turns, Escape or Overview to leave |
| Phone browser | First person; permission-gated orientation sensors, drag fallback, recenter and Overview |
| Secure WebXR browser | Enter VR after a support probe; headset pose, controller rays or hand pinch, sticks and buttons |

WebXR availability is detected, not inferred from a browser name. Quest and other standalone browsers exposing `immersive-vr` are the primary hardware targets. Ordinary iPhone Safari uses the magic window. Denying sensors or XR leaves the overview and drag controls usable.

## Camera contract

Every catalogue sim has rideable viewpoints. Named `pov` nodes supply optical and secondary tool views; their +Z points forward, so camera orientation turns by pi around Y. Body views use the logic heading, and operator seats use the stationary base. The rig owns a separate camera; overview orbit and framing survive entry, resize and exit. `SimView.activeCamera` and its camera-change event expose the rendered camera for spatial audio and picking.

Default comfort: horizon lock, 30-degree snap turns and a motion vignette. Navigation turns use snaps; a turning body carries its view heading while physical head look stays independent. Room-scale head motion is relative to the ride origin. Recenter resets look orientation; Overview ends the XR session. An in-world exit target works without DOM overlays. XR button B also exits. Sensitivity and comfort controls remain local.

## Views and control frames

What you push is what you see. `Experience.controlFrame` is the active camera's screen right and forward projected onto the ground, with world up. It stays defined when a wrist points straight down. Each spatial intent is transformed once, after the controller reader; actions, gain, deadzones, limits and simulation authority stay with the device. The overview uses its orbit heading, including after orbiting behind the device. Picking and screen projections use the camera being rendered.

| Style | Default and second view | Control frame |
| --- | --- | --- |
| Rover, boat, tank, kart, submarine, planetary rover, vacuum, forklift, slot cars, dog | Body cockpit, then chase. Tank also has a turret lens. Suspension, head animation and mast/turret pan do not turn the cockpit. | Body-relative while riding. Overview spatial sticks steer toward the screen direction; reverse is permitted. Wheel steering, pedals and slot-car throttle retain their mechanical meaning. |
| Drone, helicopter, plane | FPV on body heading, then chase; no artificial roll. | Body-relative flight while riding. Overview translations follow the orbit; aircraft roll, pitch, thrust and yaw remain flight commands. |
| Six arms, claw, excavator, sorting cell, jib | Fixed operator seat overlooking the workspace; secondary steadied wrist/tool/lens. | Active view for tool translation, world up for lift. A constrained rail or swing uses its screen projection. Excavator triggers still move its base; its sticks place the bucket. |
| PTZ, gimbal, telescope, slider, spotlights | Lens/beam, then operator. | Pan right and tilt up aim right and up. Slide and beam position follow the view; gimbal roll remains a device command while Horizon lock steadies the view. |
| Pinball, air hockey, football, maze, marble run, arena; pendulum and trebuchet | Stable player/observer seat, then a wider seat. | Seat-relative spatial moves; opposite ends reverse the world basis. Flippers, kicks, length, damping and launch power remain named mechanism controls. |
| Studio | Player seat facing the instruments, then wide. | Air targets and captured strikes follow the visible left-to-right order, including after orbiting behind. Named notes, pitch and velocity retain their musical meaning. |
| Lamps, smart home, light painter, shared scene | Lamp/appliance/object or painter workspace, then wide/tool view. | Lamps change colour and brightness, not aim: observe their result instead of sitting inside the bulb. Painter and shared-object movement use the active view. |

`View` and **V** switch viewpoints; **R** and Recenter clear drag and snap offsets. **Q/E** snap left/right; Escape and Overview exit. Switching the ridden device starts at its primary view. Look is independent of driving: desktop drag is a temporary offset on body views, easing home when released or moving. Physical headset look is never auto-centred. The XR origin removes the initial tracked position and yaw, so a seated height, recenter and snap turn stay relative to the body. Phone sensor look holds steady during motion control and rebases before resuming, avoiding a jump on release.

Position and orientation use time-based exponential filters, with shortest quaternion turns and roll removed again after interpolation. Body translation has a faster filter than a moving wrist. Seats never follow a mallet, ball or gripper. Lens anchors sit beyond the front surface; body anchors clear their own shell. The secondary view remains an explicit choice, not a camera change caused by a control action.

Portrait first person preserves a primary workspace seat's horizontal coverage by widening its vertical field of view. It does not move the ride origin or change a headset's projection. The excavator seat includes the bucket's full swing; the slot-car following overview clears the start gantry.

XR sticks send the same intents as gamepads. For arms, a trigger is the deadman; the existing approval, claim, watchdog, stop, joint-speed, floor and collision rules still run. Viewing takes no claim. While driving, a trigger belongs to the device; squeeze and pinch still grab shared props. Remote XR input uses that participant's view frame rather than the host's orbit. Releasing the trigger or losing input stops arm motion.

The view hook is `DeviceInput.controlFrame` (plain yaw, body heading and view mode). `ViewInputs` fits the calibrated `ControlAim` through `mapDeviceSpace` after attaching this frame; ground targets rotate before their device bounds clamp them. Rail and canvas directions follow their screen projection. Arms express the participant's frame in the stationary base before applying calibrated workspace limits and IK. Hand displacement is ratcheted without rotating an old accumulated displacement. Set position clears its anchor without homing the sim. Scene-selection menus, named actions and musical notes keep their own meanings.

### Review scope

The second review covers all 41 catalogue sims: overview after a half orbit, desktop and phone first person, and emulated immersive XR. The findings table, controller samples and before/after captures live in the ignored `artifacts/codex-vr2/` viewer. The principal failures were world-fixed spatial inputs, wrist roll and occlusion, animated camera anchors, overview-only picking, a drum seat facing the wrong way, and the missing arm XR drive path. Lamps and the science mechanisms intentionally retain named, nonspatial controls. Software evidence establishes direction and lifecycle behaviour, not physical headset comfort or headset frame rate.

## Shared presence and objects

Use optional versioned `sim` messages on the existing reliable control channel (PROTOCOL, sim presence extension). Only subscribed peers receive snapshots. The host owns device physics, object positions, grab ownership and release velocity. A viewer sends intent, never a replacement world. Its identity comes from the authenticated connection. A stale or disconnected hand releases its object; competing grabs are first accepted wins. Snapshot sequence numbers reject old frames. Rejoining starts with a fresh snapshot.

Head-and-hands avatars and aim rays use each participant's colour. Shared props have bounded speeds, gravity, ground contact and sphere contacts with devices and each other. Existing movable props are adapted where possible; their original simulation remains responsible while they are free. Native phone actions remain available; the added grab action lets a phone lift and release a nearby prop using its current controls.

XR controllers use `xr-standard` sticks as `face.gamepad`: left and right axes, trigger values and A. Squeeze or pinch grabs. Driving requires a device claim; watching never takes a phone's claim. Arms retain their approval, deadman and stop rules; immersive viewing must not bypass real-hardware controls.

## Rendering and proof

Use the renderer's animation loop in every mode. XR bypasses still accumulation and picture-in-picture passes. Start at conservative framebuffer scale and foveation; adjust foveation and shadows against the runtime's frame rate (72 or 90 Hz where offered). Framebuffer scale changes only between sessions. Existing per-sim geometry budgets still apply. Report observed cadence separately from hardware performance: a software test cannot establish headset frame rate or comfort.

Tests cover every catalogue rig, control-frame direction, steadying, view switching and recentering, comfort, message validation, authority, grab races and expiry, a real two-peer WebRTC scene, and an emulated XR lifecycle. Evidence is kept only in ignored artifact folders.

API references: [three.js WebXRManager](https://threejs.org/docs/pages/WebXRManager.html), [WebXR Device API](https://www.w3.org/TR/webxr/), [XR gamepads](https://www.w3.org/TR/webxr-gamepads-module-1/), [hand input](https://www.w3.org/TR/webxr-hand-input-1/).
