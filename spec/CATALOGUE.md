# ob.Pal control catalogue (v1)

Every controller surface is built from **utilities** in one catalogue. Every host maps utilities to **outputs** through **profiles**. A new kind of control (a wheel, a keyboard page, a pedal) becomes a new catalogue entry with:
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
| `touch.trackpad` | Touch | One-finger drag, two-finger pan, pinch, twist | STATE 0x11 |
| `motion.hold` | 3D | 1:1 orientation while held | STATE 0x11 (qRel) |
| `motion.tilt` | 3D | Racing-style tilt stick | STATE 0x11 (tilt) |

**Categories** order the phone's UI. Controller comes first, then Motion, then Pointer, Touch and 3D. A host declares which utilities it accepts in its layout (`utilities: string[]`; absent means all). The phone offers only those.

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

## 5. Adding to the catalogue

A new utility needs all of the following:
1. A row in §1 with a stable id and category.
2. Its wire encoding, reusing PAD, STATE or POINTER fields where possible. A new packet type is the last resort, and hosts ignore unknown types.
3. Its routes and response parameters in §2.
4. Host semantics.
5. Its place in the built-in profiles.
6. Tests: a codec round trip, the route maths, and one end-to-end case in `extension/scripts/e2e.mjs`.
