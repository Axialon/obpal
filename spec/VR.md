# Step inside a shared sim

The screen remains the authority. A participant can watch any device without taking its controls. First person and Enter VR sit beside the sim controls; Overview is always available. A shared-scene link opens the same sim on another screen, phone or headset through the existing authenticated WebRTC pairing. A phone can keep driving while its person watches from a headset.

| Where | View and input |
| --- | --- |
| Desktop browser | First person; drag to look, optional pointer lock, snap turns, Escape or Overview to leave |
| Phone browser | First person; permission-gated orientation sensors, drag fallback, recenter and Overview |
| Secure WebXR browser | Enter VR after a support probe; headset pose, controller rays or hand pinch, sticks and buttons |

WebXR availability is detected, not inferred from a browser name. Quest and other standalone browsers exposing `immersive-vr` are the primary hardware targets. Ordinary iPhone Safari uses the magic window. Denying sensors or XR leaves the overview and drag controls usable.

## Camera contract

Every catalogue sim has rideable viewpoints. Prefer the restyle's named `pov` node, whose +Z points forward. Until that node exists, the rig derives a pose from device state; arms use the moving grasp frame. The camera looks along -Z, so anchor orientation is turned by pi around Y. The rig owns a separate camera; overview orbit and framing survive entry, resize and exit. `SimView.activeCamera` and its camera-change event expose the rendered camera for spatial audio.

Default comfort: horizon lock, 30-degree snap turns and a motion vignette. No smooth artificial yaw is forced on the head. Room-scale head motion is relative to the ride origin. Recenter resets look orientation; Overview ends the XR session. An in-world exit target works without DOM overlays. XR button B also exits. Sensitivity and comfort controls remain local.

## Shared presence and objects

Use optional versioned `sim` messages on the existing reliable control channel (PROTOCOL, sim presence extension). Only subscribed peers receive snapshots. The host owns device physics, object positions, grab ownership and release velocity. A viewer sends intent, never a replacement world. Its identity comes from the authenticated connection. A stale or disconnected hand releases its object; competing grabs are first accepted wins. Snapshot sequence numbers reject old frames. Rejoining starts with a fresh snapshot.

Head-and-hands avatars and aim rays use each participant's colour. Shared props have bounded speeds, gravity, ground contact and sphere contacts with devices and each other. Existing movable props are adapted where possible; their original simulation remains responsible while they are free. Native phone actions remain available; the added grab action lets a phone lift and release a nearby prop using its current controls.

XR controllers use `xr-standard` sticks as `face.gamepad`: left and right axes, trigger values and A. Squeeze or pinch grabs. Driving requires a device claim; watching never takes a phone's claim. Arms retain their approval, deadman and stop rules; immersive viewing must not bypass real-hardware controls.

## Rendering and proof

Use the renderer's animation loop in every mode. XR bypasses still accumulation and picture-in-picture passes. Start at conservative framebuffer scale and foveation; adjust foveation and shadows against the runtime's frame rate (72 or 90 Hz where offered). Framebuffer scale changes only between sessions. Existing per-sim geometry budgets still apply. Report observed cadence separately from hardware performance: a software test cannot establish headset frame rate or comfort.

Tests cover every catalogue rig, comfort, message validation, authority, grab races and expiry, a real two-peer WebRTC scene, and an emulated XR lifecycle. Evidence is kept only in `artifacts/codex-vr/`.

API references: [three.js WebXRManager](https://threejs.org/docs/pages/WebXRManager.html), [WebXR Device API](https://www.w3.org/TR/webxr/), [XR gamepads](https://www.w3.org/TR/webxr-gamepads-module-1/), [hand input](https://www.w3.org/TR/webxr-hand-input-1/).
