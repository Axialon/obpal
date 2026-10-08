# Local control on the sim screen

Sim **Play here**, the pairing chip's **Play here**, and hub links open the same local-control chooser. **On-screen touch controls** is an explicit choice on phones, tablets with an attached mouse, and computers. Share names touch and keyboard/mouse/gamepad separately. A saved source/unit/binding preference and entry URL never enable input after reload.

On-screen controls reuse PhonePlay's PAD/STATE/tray messages and the native Seats consumer. The toolbar names its sticks and scene actions, and offers a unit selector and **Choose controls**. Changing source or unit closes the old local seat before creating another. A paired phone can take over the selected local touch seat; touch cannot evict a paired phone. Pointer release, cancellation, lost capture, blur, hidden visibility, camera switching, exit and reload release held input. Live-driver approval, arming and deadman checks remain independent.

Research and implementation notes, 1 October 2026. These defaults are proposals specific to ob.Pal, based on the input and accessibility patterns below. Browser emulation verifies software behaviour; it does not establish physical USB, Bluetooth, camera or phone sensor performance.

## Comparable controls

The [W3C Gamepad specification](https://www.w3.org/TR/gamepad/) defines `standard` mapping: axes 0/1 are the left stick, 2/3 the right stick, with positive Y down. Buttons 0–3 are the four face buttons, 4/5 shoulders, 6/7 analogue triggers, 12–15 the directional pad and 16 the centre/guide button. Devices appear only after browser exposure rules permit them, often following a button press. Poll current pads each frame, preserve sparse indices and stop when a pad disappears. A connected device with an unknown mapping cannot honestly be labelled a supported standard pad. ob.Pal ignores that mapping rather than guessing its axes.

[Godot’s controller guidance](https://docs.godotengine.org/en/stable/tutorials/inputs/controllers_gamepads_joysticks.html) demonstrates why analogue input needs a deadzone: a resting stick may report drift, whereas a keyboard produces discrete full deflection. ob.Pal keeps its existing radial 0.12 deadzone and consumer response instead of applying two rescaling curves. Its [InputEvent and InputMap documentation](https://docs.godotengine.org/en/stable/tutorials/inputs/inputevent.html) separates actions from physical events, allowing several bindings for one action. The same separation lets our overlay remap a key without rewriting a sim.

[Babylon’s Universal Camera](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/cameras/camera_introduction.md) accepts keyboard, mouse, touch and gamepad input through one camera interface, with keyboard input dependent on rendering-area focus. This supports a focused local-control surface rather than global interception. We adopt familiar WASD and arrow movement, QE turning, IJKL secondary axes, Space/Shift vertical or trigger input, Enter/B/X/Y actions and number keys for the sim’s tray. These particular bindings are our design choice, not a browser standard. The first nine tray buttons provide modes and device actions using the same ids the phone sends.

[three.js OrbitControls](https://threejs.org/docs/pages/OrbitControls.html) assigns a one-finger/left-mouse drag to orbit, wheel or pinch to zoom and other gestures to pan. That conflicts directly with object control. Selecting and enabling keyboard/mouse therefore assigns drag to the object and pauses orbit; releasing controls returns orbit. A separate explicit Lock mouse button requests pointer lock. The [Pointer Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API) requires a user engagement gesture and offers relative movement without screen edges. Esc releases it; failure leaves drag usable. Merely selecting a source, reloading, detecting a pad or opening help never requests lock.

[WCAG keyboard operability](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html), [no keyboard trap](https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html) and [visible focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) inform the interaction boundary. The canvas is focusable, Tab leaves it, form fields and buttons retain normal editing and activation, and modified browser shortcuts are left alone. Only bound play keys on the focused, enabled scene are consumed. Focus changes clear held input. Blur and backgrounding release local controls. The bindings button provides the same help as `?`; its key caps can be activated to remap a binding, with Esc cancelling capture.

## Phone faces and default mappings

The phone already sends PAD, STATE, POSE, HAND and BODY, plus button/value/text events. `Seats` reads those into `DeviceInput`. Local controls produce that same structure before focus routing and device stepping. Recommended native mappings remain in each `DeviceSpec`; a generic adapter supplies missing routes. Compatibility is guidance: best, good or works, with a dot gauge and the recommendation first. Tilt is a trackpad style; 3D is the existing `face.hand`; Hand and Body are camera utilities; Keys is the musical face, and Keyboard supplies typing/key codes. They are distinct choices in the phone catalogue.

| Face | Existing phone output | Default local / generic route |
| --- | --- | --- |
| Gamepad | Standard PAD axes, triggers, button edges | Hardware standard pad, or WASD/arrows left stick; QE/IJKL secondary stick; drag both sticks when movement keys are idle; Space/Shift RT/LT; Enter/B/X/Y buttons |
| Wheel | PAD steer and pedals | Left/right steer, forward/back throttle; physical triggers remain pedals |
| Wii pointer | Point, held B, A and zoom buttons | Drag/aim or secondary stick; held grab enables movement; aim becomes bounded steer/tilt |
| Mouse | Point, mouse buttons and wheel | Explicit drag or locked relative aim; click action; wheel zoom/value |
| Trackpad | Touch drag, two-finger pan, pinch and twist | On-device touch floating stick; keyboard sticks and mouse aim supply equivalent channels |
| Tilt | STATE tilt or calibrated slope | Left stick / WASD / touch deflection becomes board slope or steering |
| 3D | Tracked pose with a touching deadman; motion-estimated orbit | Pose translation and orientation become bounded movement/secondary axes when no native tool-follow route exists |
| Hand | Tracked palm and hand landmarks, held drive | Held palm displacement becomes movement; native arm camera-hand path retains its pinch and workspace rules |
| Body | Tracked body landmarks | Wrist relative to shoulder becomes movement through the shared adapter; humanoid keeps full-body retargeting |
| Keys / drums | Music value events | A deliberate note/strike supplies a bounded directional pulse and primary action; native studio audio remains event-driven |
| Keyboard | Text and `key-*` button events | WASD/arrow key events supply short directional jogs; Enter primary action |

The fallback clamps axes and triggers and consumes deltas once. It does not create Go live or approval events from motion. The simulated drone retains its existing A/tray takeoff and deliberate climb-to-takeoff behaviour. A live driver additionally requires held Z (remappable) or gamepad LB; releasing it sends a neutral frame through the existing driver gate.

## Families, exceptions and shared rooms

Vehicles use left-stick steer/throttle; flyers use translation, yaw, climb and an explicit takeoff action. Camera rigs use secondary axes and zoom. Industrial machines use paired axes for their mechanisms. Home devices also receive bounded drag/value channels because some consume gestures rather than PAD. Games use movement plus their existing action buttons. Music keeps its native event scheduler and accepts fallback sticks for cursor selection. Arena and humanoid feed the same mapped input into their existing movement consumers.

The marble board accepts a stick as slope in build and run modes; drag still pushes and edits, and Y/its tray changes Run/build. Pendulum uses vertical stick for length, horizontal for damping and its explicit Push action. Slot cars turn fallback movement magnitude into throttle. Pinball routes non-pad horizontal movement to held flippers and downward movement to the plunger. Wheel pedals become forward/back on non-driving devices. Maze music pulses steer without repeatedly invoking A’s Home action. Excavator’s declared 3D face uses the fallback because its native reader has no POSE branch. Drone, claw, painter, gimbal and arm keep implemented native spatial routes. The so101 local path uses the arm’s existing pad consumer, motion limits, collision checks and watchdog. Real-driver Go live and held deadman requirements remain additional gates.

The picker remembers source, selected unit and key bindings per sim, but never remembers an enabled/armed state. Keyboard/mouse drives the selected unit. Multiple standard pads receive separate stable unit assignments. Phone claims take precedence, including quiet/watchdog frames; local actions are discarded for that unit and local enable is released on takeover. Other local pads can drive free units in the same room. Existing phone QR and controller-window pairing continue to use the room’s normal claims, approval and connection flow.
